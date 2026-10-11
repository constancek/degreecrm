import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { createMockDiscordClient, setDiscordClient } from "@/lib/integrations/discord";
import { createMockGeocodingClient, setGeocodingClient } from "@/lib/integrations/google-maps";
import { createMockQuoClient, setQuoClient } from "@/lib/integrations/quo";
import { createMemoryBlobStore, setBlobStore } from "@/lib/integrations/blob";
import { createMockEmailClient, setEmailClient } from "@/lib/integrations/email";
import { createMockQuickBooksClient } from "@/lib/integrations/quickbooks";
import { createMockCalendarClient, setCalendarClient } from "@/lib/integrations/google-calendar";
import { setQuickBooksClient } from "@/lib/services/quickbooks-auth";
import { createLead } from "@/lib/services/leads";
import { savePriceBookItem } from "@/lib/services/pricebook";
import { saveTerms } from "@/lib/services/terms";
import { DEFAULT_TAX_RATES, saveTaxRates } from "@/lib/services/tax";
import { createProposalDraft, sendProposal } from "@/lib/services/proposals";
import { loadByToken } from "@/lib/services/client-proposals";
import { recordPaperApproval, signProposal } from "@/lib/services/signing";
import { chargeDeposit, chooseDepositMethod, pollDepositInvoices, recordManualDeposit } from "@/lib/services/payments";
import { pollCalendars, rescheduleVisit, scheduleVisit, syncVisit, updateVisitStatus } from "@/lib/services/visits";
import { completeJob, createMilestoneInvoice, pollInvoices, requestReviews } from "@/lib/services/jobs";
import { ensureDefaultSequences, nextAllowedSendTime, processDueEnrollments } from "@/lib/services/sequences";
import { handleInbound, verifyQuoSignature } from "@/lib/services/messages";
import { findSlots } from "@/lib/services/dispatch";
import { handleFinancingEmail } from "@/lib/services/financing";
import { ValidationError } from "@/lib/services/actor";
import { makeUser, resetDb } from "./helpers";

const discord = createMockDiscordClient();
const quo = createMockQuoClient();
const email = createMockEmailClient();
const qbo = createMockQuickBooksClient();
const calendar = createMockCalendarClient();
setDiscordClient(discord);
setQuoClient(quo);
setBlobStore(createMemoryBlobStore());
setEmailClient(email);
setQuickBooksClient(qbo);
setCalendarClient(calendar);
setGeocodingClient(createMockGeocodingClient());

// PDF rendering needs a browser; stub it for these service tests.
import { setPdfRenderer } from "@/lib/pdf";
setPdfRenderer(async () => Buffer.from("%PDF-1.4 signed copy"));
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(400, 7)]).toString("base64");

beforeEach(async () => {
  await resetDb();
  await db.$executeRawUnsafe(`TRUNCATE "TaxRate", "PriceBookItem", "TermsVersion", "Sequence", "Message", "Payment", "Signature", "Visit", "Job" CASCADE`);
  await saveTaxRates({ kind: "system", label: "test" }, DEFAULT_TAX_RATES);
  await ensureDefaultSequences();
  quo.sent.length = 0;
  discord.sent.length = 0;
  calendar.events.clear();
});
afterAll(() => db.$disconnect());

const META = { ip: "1.2.3.4", userAgent: "test" };

/** Lead with a sent proposal, ready to sign. */
async function sentProposal(trade: "hvac" | "plumbing" = "hvac") {
  const owner = await makeUser("owner", "owner@test.dev");
  const tech = await makeUser("tech", "tech@test.dev");
  await db.user.update({ where: { id: tech.id }, data: { googleRefreshToken: encrypt("rt-tech") } });
  const item = await savePriceBookItem(owner, { trade, category: "equipment", name: "Unit", unit: "ea", costCents: null, priceCents: 400000 });
  await saveTerms(owner, { body: "# Terms\n\n" + "These terms apply to all work we do for you. ".repeat(3), keyTerms: "{deposit} deposit." });
  const lead = await createLead(owner, {
    customer: { name: "Pat Jones", phone: "513-555-0123", email: "pat@example.com" },
    property: { street: "1 Vine St", zip: "45202", county: "Hamilton" },
    title: "AC replacement",
    trade,
    assignedToId: tech.id,
  });
  const opt = (tier: "good" | "better" | "best") => ({ tier, title: `${tier}`, priceCents: 400000, lineItems: [{ description: "Unit", qty: 1, priceBookItemId: item.id }] });
  const draft = await createProposalDraft(owner, lead.id, { summary: "Options", options: [opt("good"), opt("better"), opt("best")] });
  const { link } = await sendProposal(owner, draft.id, { textCustomer: false });
  const p = (await loadByToken(link.split("/p/")[1]!))!;
  return { owner, tech, lead, p, optionId: p.options[1]!.id };
}

const SIGN = { name: "Pat Jones", email: "pat@example.com", termsAccepted: true as const, esignConsent: true as const };

async function signed(trade: "hvac" | "plumbing" = "hvac") {
  const ctx = await sentProposal(trade);
  await signProposal(ctx.p, { optionId: ctx.optionId, ...SIGN, signature: { type: "typed", text: "Pat Jones" } }, { ...META, phoneVerified: true });
  return ctx;
}

describe("signing", () => {
  it("signs on the page: signature + evidence, stage estimate_approved, signed copy emailed and texted", async () => {
    const { p, lead, optionId } = await sentProposal();
    email.sent.length = 0;
    await signProposal(
      p,
      { optionId, ...SIGN, signature: { type: "drawn", dataUrl: `data:image/png;base64,${PNG}` } },
      { ...META, phoneVerified: true },
    );
    const after = await db.proposal.findUniqueOrThrow({ where: { id: p.id }, include: { signature: true } });
    expect(after.status).toBe("signed");
    expect(after.signature).toMatchObject({
      optionId,
      method: "drawn",
      signerEmail: "pat@example.com",
      ip: "1.2.3.4",
      phoneVerified: true,
      termsVersion: 1,
      signedPdfPath: expect.stringContaining("signed"),
    });
    expect(after.signature!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(after.signature!.signedPdfHash).toMatch(/^[0-9a-f]{64}$/);
    expect(after.signature!.consentAt).toBeTruthy();
    expect(after.signature!.copySentAt).toBeTruthy();
    expect(after.quickbooksEstimateId).toMatch(/^est/);
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).stage).toBe("estimate_approved");
    expect(await db.enrollment.count({ where: { leadId: lead.id, status: "active" } })).toBe(0);
    expect(email.sent.at(-1)).toMatchObject({ to: "pat@example.com", attachments: [expect.objectContaining({ filename: expect.stringMatching(/\.pdf$/) })] });
    expect(quo.sent.at(-1)!.content).toContain("Your proposal is signed");
  });

  it("can't be signed twice, without consent, or with a bad signature image", async () => {
    const { p, optionId } = await sentProposal();
    await expect(signProposal(p, { optionId, ...SIGN, esignConsent: false as never, signature: { type: "typed", text: "Pat" } }, { ...META, phoneVerified: true })).rejects.toThrow();
    await expect(
      signProposal(p, { optionId, ...SIGN, signature: { type: "drawn", dataUrl: "data:image/png;base64,AAAA" } }, { ...META, phoneVerified: true }),
    ).rejects.toBeInstanceOf(ValidationError);
    await signProposal(p, { optionId, ...SIGN, signature: { type: "typed", text: "Pat Jones" } }, { ...META, phoneVerified: true });
    await expect(signProposal(p, { optionId, ...SIGN, signature: { type: "typed", text: "Pat Jones" } }, { ...META, phoneVerified: true })).rejects.toThrow(
      /already signed/,
    );
    expect(await db.signature.count()).toBe(1);
  });

  it("owner can record a paper signature", async () => {
    const { p, owner, optionId, lead } = await sentProposal();
    await recordPaperApproval(owner, p.id, { optionId, signerName: "Pat Jones", note: "signed at the kitchen table" });
    const sig = await db.signature.findUniqueOrThrow({ where: { proposalId: p.id } });
    expect(sig).toMatchObject({ method: "paper", recordedById: owner.id, phoneVerified: false });
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).stage).toBe("estimate_approved");
  });
});

describe("deposit", () => {
  it("charges the card once, books it, creates the job and texts the customer", async () => {
    const { p, lead } = await signed();
    await chargeDeposit(p.id, "tok_good_card", META);
    await chargeDeposit(p.id, "tok_good_card", META); // double click
    const payments = await db.payment.findMany({ where: { proposalId: p.id } });
    expect(payments).toHaveLength(1);
    // 4,000 + 7.8% tax = 4,312 → under $5k → 50% deposit
    expect(payments[0]).toMatchObject({ amountCents: 215600, status: "succeeded", cardLast4: "1111", method: "card" });
    expect(payments[0]!.quickbooksPaymentId).toBeTruthy();
    const job = await db.job.findUniqueOrThrow({ where: { proposalId: p.id } });
    expect(job).toMatchObject({ status: "unscheduled", totalCents: 431200, depositCents: 215600 });
    expect(quo.sent.at(-1)!.content).toContain("received your $2,156.00 deposit");
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).stage).toBe("estimate_approved");
  });

  it("a declined card records a failed payment and no job", async () => {
    const { p } = await signed();
    await expect(chargeDeposit(p.id, "tok_declined", META)).rejects.toBeInstanceOf(ValidationError);
    expect(await db.payment.count({ where: { proposalId: p.id, status: "failed" } })).toBe(1);
    expect(await db.job.count()).toBe(0);
  });

  it("bank transfer: a QuickBooks deposit invoice; the deposit is recorded when it clears", async () => {
    const { p } = await signed();
    const { payLink } = await chooseDepositMethod(p.id, "ach");
    expect(payLink).toMatch(/example\.com\/invoice\//);
    expect((await chooseDepositMethod(p.id, "ach")).payLink).toBe(payLink); // no second invoice
    const after = await db.proposal.findUniqueOrThrow({ where: { id: p.id } });
    expect(after).toMatchObject({ depositChoice: "ach", depositInvoiceLink: payLink });
    expect(await pollDepositInvoices()).toBe(0); // not paid yet
    qbo.state.invoices.set(after.depositInvoiceId!, 0);
    expect(await pollDepositInvoices()).toBe(1);
    expect(await db.payment.findFirstOrThrow({ where: { proposalId: p.id } })).toMatchObject({ method: "ach", amountCents: 215600, status: "succeeded" });
    expect(await db.job.findUniqueOrThrow({ where: { proposalId: p.id } })).toMatchObject({ depositCents: 215600 });
  });

  it("check / in person: choice logged, office alerted, no job until the deposit is recorded", async () => {
    const { p, lead } = await signed();
    await chooseDepositMethod(p.id, "check");
    expect((await db.proposal.findUniqueOrThrow({ where: { id: p.id } })).depositChoice).toBe("check");
    expect(await db.activity.count({ where: { leadId: lead.id, type: "deposit_choice" } })).toBe(1);
    expect(await db.job.count()).toBe(0);
  });

  it("payment schedule: milestone invoices during the job; the final invoice bills only what's left", async () => {
    const { p, owner } = await signed();
    // Deposit 50% (company rule under $5k) + rough-in 40% + completion 10%.
    await db.paymentMilestone.createMany({
      data: [
        { proposalId: p.id, label: "Rough-in complete", percent: 40, sortOrder: 0 },
        { proposalId: p.id, label: "Completion", percent: 10, sortOrder: 1 },
      ],
    });
    await chargeDeposit(p.id, "tok_good_card", META);
    const job = await db.job.findUniqueOrThrow({ where: { proposalId: p.id } });
    const [roughIn, completion] = await db.paymentMilestone.findMany({ where: { proposalId: p.id }, orderBy: { sortOrder: "asc" } });

    await expect(createMilestoneInvoice(owner, job.id, completion!.id)).rejects.toThrow(/final invoice/);
    const m = await createMilestoneInvoice(owner, job.id, roughIn!.id);
    expect(m).toMatchObject({ amountCents: 172480 }); // 40% of $4,312
    expect(quo.sent.at(-1)!.content).toContain("rough-in complete payment of $1,724.80");

    qbo.state.invoices.set(m.invoiceId!, 0);
    await pollInvoices();
    expect(await db.payment.findFirstOrThrow({ where: { jobId: job.id, kind: "progress" } })).toMatchObject({ amountCents: 172480 });

    await completeJob(owner, job.id);
    const done = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(qbo.state.invoices.get(done.quickbooksInvoiceId!)).toBe(43120); // 4,312 − 2,156 − 1,724.80
  });

  it("owner can record a check deposit", async () => {
    const { p, owner } = await signed();
    await recordManualDeposit(owner, p.id, { method: "check", amountCents: 100000, note: "#1042" });
    expect(await db.job.count({ where: { proposalId: p.id } })).toBe(1);
  });
});

describe("scheduling, calendar, completion, payment, review", () => {
  it("runs a job from scheduling to review", async () => {
    const { p, owner, tech, lead } = await signed("hvac");
    await chargeDeposit(p.id, "tok_ok_card_1", META);
    const job = await db.job.findUniqueOrThrow({ where: { proposalId: p.id } });

    const start = new Date(Date.now() + 3 * 86_400_000);
    const visit = await scheduleVisit(owner, { leadId: lead.id, jobId: job.id, kind: "job", techId: tech.id, start, end: new Date(start.getTime() + 4 * 3_600_000) });
    await syncVisit(visit.id);
    const synced = await db.visit.findUniqueOrThrow({ where: { id: visit.id } });
    expect(synced.syncState).toBe("synced");
    expect(calendar.events.get(synced.googleEventId!)).toMatchObject({ visitId: visit.id, summary: expect.stringContaining("Pat Jones") });
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).stage).toBe("job_scheduled");
    expect(await db.enrollment.count({ where: { visitId: visit.id, status: "active" } })).toBe(1);

    // Tech drags the event in Google → CRM follows.
    const moved = new Date(start.getTime() + 86_400_000);
    calendar.move(synced.googleEventId!, moved, new Date(moved.getTime() + 4 * 3_600_000));
    await db.user.update({ where: { id: tech.id }, data: { googleCalendarPolledAt: new Date(Date.now() - 10 * 60_000) } });
    expect(await pollCalendars()).toBe(1);
    expect((await db.visit.findUniqueOrThrow({ where: { id: visit.id } })).start.getTime()).toBe(moved.getTime());

    await updateVisitStatus(tech, visit.id, "en_route", { notifyCustomer: true });
    expect(quo.sent.at(-1)!.content).toContain("on the way");
    await updateVisitStatus(tech, visit.id, "in_progress");
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).stage).toBe("job_in_progress");
    await updateVisitStatus(tech, visit.id, "done");

    const invoiced = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(invoiced.status).toBe("invoiced");
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).stage).toBe("invoiced");
    expect(qbo.state.invoices.get(invoiced.quickbooksInvoiceId!)).toBe(431200 - 215600);

    // Customer pays the QuickBooks invoice.
    qbo.state.invoices.set(invoiced.quickbooksInvoiceId!, 0);
    expect(await pollInvoices()).toBe(1);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("paid");
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).stage).toBe("payment_complete");

    // Next morning: review request + HVAC maintenance drip.
    await db.lead.update({ where: { id: lead.id }, data: { stageChangedAt: new Date(Date.now() - 2 * 86_400_000) } });
    const tenAm = new Date();
    tenAm.setUTCHours(15, 0, 0, 0); // 10–11 am Eastern
    expect(await requestReviews(tenAm)).toBe(1);
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).stage).toBe("review_requested");
    const maint = await db.enrollment.findFirst({ where: { leadId: lead.id, sequence: { key: "maintenance" } } });
    expect(maint?.status).toBe("active");
    void owner;
  });

  it("deleting the event in Google Calendar cancels the visit and texts the customer", async () => {
    const { owner, tech, lead } = await sentProposal();
    const start = new Date(Date.now() + 2 * 86_400_000);
    const v = await scheduleVisit(owner, { leadId: lead.id, kind: "estimate", techId: tech.id, start, end: new Date(start.getTime() + 3 * 3_600_000) });
    await syncVisit(v.id);
    const eventId = (await db.visit.findUniqueOrThrow({ where: { id: v.id } })).googleEventId!;
    await calendar.deleteEvent("rt-tech", eventId); // the tech deletes it in Google
    await db.user.update({ where: { id: tech.id }, data: { googleCalendarPolledAt: new Date(Date.now() - 10 * 60_000) } });
    expect(await pollCalendars()).toBe(1);
    const after = await db.visit.findUniqueOrThrow({ where: { id: v.id } });
    expect(after.status).toBe("cancelled");
    expect(quo.sent.at(-1)!.content).toContain("has been cancelled");
    expect(await db.enrollment.count({ where: { visitId: v.id, status: "active" } })).toBe(0);
  });

  it("reassigning a visit moves the event to the other tech's calendar", async () => {
    const { owner, tech, lead } = await sentProposal();
    const other = await makeUser("tech", "other@test.dev");
    await db.user.update({ where: { id: other.id }, data: { googleRefreshToken: encrypt("rt-other") } });
    const start = new Date(Date.now() + 2 * 86_400_000);
    const v = await scheduleVisit(owner, { leadId: lead.id, kind: "estimate", techId: tech.id, start, end: new Date(start.getTime() + 3_600_000) });
    await syncVisit(v.id);
    const first = (await db.visit.findUniqueOrThrow({ where: { id: v.id } })).googleEventId!;
    await rescheduleVisit(owner, v.id, { start, end: new Date(start.getTime() + 3_600_000), techId: other.id });
    await syncVisit(v.id);
    const after = await db.visit.findUniqueOrThrow({ where: { id: v.id } });
    expect(calendar.events.get(first)!.status).toBe("cancelled");
    expect(calendar.events.get(after.googleEventId!)!.owner).toBe("rt-other");
  });
});

describe("texting", () => {
  it("only sends 9 am–8 pm Eastern, Monday to Saturday", () => {
    const sunNoon = new Date("2026-10-11T16:00:00Z"); // Sunday 12 pm EDT
    expect(nextAllowedSendTime(sunNoon).toISOString()).toBe("2026-10-12T13:00:00.000Z"); // Monday 9 am
    const satLate = new Date("2026-10-10T01:30:00Z"); // Friday 9:30 pm EDT
    expect(nextAllowedSendTime(satLate).toISOString()).toBe("2026-10-10T13:00:00.000Z");
    const ok = new Date("2026-10-13T15:00:00Z");
    expect(nextAllowedSendTime(ok)).toEqual(ok);
  });

  it("proposal follow-up drip: first text carries STOP wording; a reply stops it", async () => {
    const { lead } = await sentProposal();
    const e = await db.enrollment.findFirstOrThrow({ where: { leadId: lead.id, sequence: { key: "proposal_followup" } } });
    expect(e.status).toBe("active");
    const due = new Date("2026-10-13T15:00:00Z");
    await db.enrollment.update({ where: { id: e.id }, data: { nextSendAt: new Date(due.getTime() - 1000) } });
    expect(await processDueEnrollments(due)).toBe(1);
    expect(quo.sent.at(-1)!.content).toMatch(/proposal link.*Reply STOP to opt out\.$/);
    const msg = await db.message.findFirstOrThrow({ where: { enrollmentId: e.id } });
    expect(msg.direction).toBe("out");

    await handleInbound({ quoId: "in_1", from: "+15135550123", body: "Can you call me tomorrow?" });
    expect((await db.enrollment.findUniqueOrThrow({ where: { id: e.id } })).stoppedReason).toBe("customer replied");
    expect(await db.message.count({ where: { direction: "in" } })).toBe(1);
  });

  it("STOP opts the customer out; later sends are refused", async () => {
    const { lead } = await sentProposal();
    await handleInbound({ quoId: "in_2", from: "(513) 555-0123", body: "STOP" });
    const customer = await db.customer.findUniqueOrThrow({ where: { id: lead.customerId } });
    expect(customer.smsOptOut).toBe(true);
    expect(await db.enrollment.count({ where: { leadId: lead.id, status: "active" } })).toBe(0);
  });

  it("a text from a number not in the CRM is ignored (stays in Quo)", async () => {
    await sentProposal();
    const { processOutbox } = await import("@/lib/services/outbox");
    await processOutbox();
    discord.sent.length = 0;
    const before = { customers: await db.customer.count(), leads: await db.lead.count() };
    await handleInbound({ quoId: "in_unknown", from: "+15139990000", body: "Hi, do you do furnaces?" });
    expect({ customers: await db.customer.count(), leads: await db.lead.count() }).toEqual(before);
    expect(await db.message.count({ where: { quoMessageId: "in_unknown" } })).toBe(0);
    await processOutbox();
    expect(discord.sent).toHaveLength(0);
  });

  it("an urgent text alerts Discord", async () => {
    await sentProposal();
    await handleInbound({ quoId: "in_3", from: "+15135550123", body: "Water heater is flooding the basement!" });
    const { processOutbox } = await import("@/lib/services/outbox");
    await processOutbox();
    expect(discord.sent.some((m) => m.content?.includes("URGENT"))).toBe(true);
  });

  it("verifies Quo webhook signatures", () => {
    const key = Buffer.from("super-secret-key").toString("base64");
    const body = JSON.stringify({ object: { type: "message.received" } });
    const ts = String(Date.now());
    const sig = createHmac("sha256", Buffer.from(key, "base64")).update(`${ts}.${body}`).digest("base64");
    expect(verifyQuoSignature(`hmac;1;${ts};${sig}`, body, key)).toBe(true);
    expect(verifyQuoSignature(`hmac;1;${ts};${sig}`, body + " ", key)).toBe(true); // compact JSON re-serialization
    expect(verifyQuoSignature(`hmac;1;${ts};AAAA${sig.slice(4)}`, body, key)).toBe(false);
    expect(verifyQuoSignature(`hmac;1;1000;${sig}`, body, key)).toBe(false); // stale
  });
});

describe("slot finder", () => {
  it("skips busy time and Sundays, one suggestion per tech per day", async () => {
    const { owner, tech, lead } = await sentProposal();
    // Monday Oct 12 2026: tech busy 8 am–12 pm Eastern.
    await scheduleVisit(owner, { leadId: lead.id, kind: "estimate", techId: tech.id, start: new Date("2026-10-12T12:00:00Z"), end: new Date("2026-10-12T16:00:00Z") });
    const now = new Date("2026-10-11T12:00:00Z"); // Sunday morning
    const { slots } = await findSlots(owner, { leadId: lead.id, durationHours: 3, maxDriveMinutes: 60, fromDate: "2026-10-11", days: 3, techId: tech.id }, now);
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(s.start)).not.toBe("Sun");
    }
    // The first Monday opening is after the 8–12 visit.
    expect(slots[0]!.start.toISOString()).toBe("2026-10-12T16:00:00.000Z");
  });
});

describe("financing emails", () => {
  it("matches the lead and logs the status", async () => {
    const { lead } = await sentProposal();
    const res = await handleFinancingEmail({ subject: "Customer approved", text: "Pat Jones (pat@example.com) was approved for $8,000" }, async () => ({
      isFinancingUpdate: true,
      customerName: "Pat Jones",
      customerEmail: "pat@example.com",
      status: "approved",
      amountDollars: 8000,
      summary: "Approved for $8,000",
    }));
    expect(res).toMatchObject({ matched: true, status: "approved" });
    const a = await db.activity.findFirstOrThrow({ where: { type: "financing", leadId: lead.id } });
    expect(a.body).toContain("Financing approved ($8,000)");
  });
});
