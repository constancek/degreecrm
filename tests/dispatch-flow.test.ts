// The home-service flow: request → (needs tech) → scheduled → on the way → on site → signed / declined,
// plus running late and rescheduling. Texts are checked for the arrival window and technician.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createMockDiscordClient, setDiscordClient } from "@/lib/integrations/discord";
import { createMockGeocodingClient, setGeocodingClient } from "@/lib/integrations/google-maps";
import { createMockQuoClient, setQuoClient } from "@/lib/integrations/quo";
import { createMemoryBlobStore, setBlobStore } from "@/lib/integrations/blob";
import { createMockEmailClient, setEmailClient } from "@/lib/integrations/email";
import { createMockQuickBooksClient } from "@/lib/integrations/quickbooks";
import { createMockCalendarClient, setCalendarClient } from "@/lib/integrations/google-calendar";
import { setQuickBooksClient } from "@/lib/services/quickbooks-auth";
import { setPdfRenderer } from "@/lib/pdf";
import { arrivalPhrase } from "@/lib/booking";
import { bookingTimes } from "@/lib/services/booking";
import { createLead } from "@/lib/services/leads";
import { savePriceBookItem } from "@/lib/services/pricebook";
import { saveTerms } from "@/lib/services/terms";
import { DEFAULT_TAX_RATES, saveTaxRates } from "@/lib/services/tax";
import { createProposalDraft, sendProposal } from "@/lib/services/proposals";
import { recordPaperApproval } from "@/lib/services/signing";
import { saveCompanyDetails, getCompany } from "@/lib/services/company";
import { ensureDefaultSequences, processDueEnrollments } from "@/lib/services/sequences";
import { needsReschedule, rescheduleVisit, runningLate, scheduleVisit, updateVisitStatus, wrapUpVisit } from "@/lib/services/visits";
import { pollServiceFeeInvoices } from "@/lib/services/payments";
import { planStageMove } from "@/lib/services/stage-moves";
import { runTick } from "@/lib/jobs/tick";
import { ForbiddenError } from "@/lib/services/actor";
import { makeUser, resetDb } from "./helpers";

const quo = createMockQuoClient();
const qbo = createMockQuickBooksClient();
setDiscordClient(createMockDiscordClient());
setQuoClient(quo);
setBlobStore(createMemoryBlobStore());
setEmailClient(createMockEmailClient());
setQuickBooksClient(qbo);
setCalendarClient(createMockCalendarClient());
setGeocodingClient(createMockGeocodingClient());
setPdfRenderer(async () => Buffer.from("%PDF-1.4"));

beforeEach(async () => {
  await resetDb();
  await db.$executeRawUnsafe(`TRUNCATE "TaxRate", "PriceBookItem", "TermsVersion", "Sequence", "Message", "Payment", "Signature", "Visit", "Job" CASCADE`);
  await saveTaxRates({ kind: "system", label: "test" }, DEFAULT_TAX_RATES);
  await ensureDefaultSequences();
  quo.sent.length = 0;
});
afterAll(() => db.$disconnect());

const DAY = "2026-11-03"; // a Tuesday
const texts = () => quo.sent.map((m) => m.content);
const lastText = () => quo.sent.at(-1)?.content ?? "";
const stageOf = async (id: string) => (await db.lead.findUniqueOrThrow({ where: { id } })).stage;

async function setup() {
  const owner = await makeUser("owner", "owner@test.dev");
  const mike = await makeUser("tech", "mike@test.dev");
  const dana = await makeUser("tech", "dana@test.dev");
  await db.user.update({ where: { id: mike.id }, data: { name: "Mike Reyes" } });
  await db.user.update({ where: { id: dana.id }, data: { name: "Dana Cole" } });
  mike.name = "Mike Reyes";
  const lead = await createLead(owner, {
    customer: { name: "Sarah Mitchell", phone: "513-555-0111", email: "sarah@example.com" },
    property: { street: "3412 Erie Ave", zip: "45208", county: "Hamilton" },
    title: "AC not cooling",
    trade: "hvac",
  });
  return { owner, mike, dana, lead };
}

/** Sends whatever sequence step is due right now (the confirmation goes out immediately). */
async function flushTexts(now = new Date("2026-10-20T15:00:00Z")) {
  await processDueEnrollments(now);
}

describe("arrival window wording", () => {
  it("reads naturally for 3-hour windows, all day, and exact times", () => {
    const w = bookingTimes({ date: DAY, window: "09-12", hours: 1 });
    expect(arrivalPhrase({ start: w.arrivalStart!, end: w.arrivalEnd! })).toBe("between 9 am and 12 pm");
    const all = bookingTimes({ date: DAY, window: "09-18", hours: 1 });
    expect(arrivalPhrase({ start: all.arrivalStart!, end: all.arrivalEnd! })).toBe("sometime between 9 am and 6 pm");
    const exact = bookingTimes({ date: DAY, window: "exact", time: "10:30", hours: 2 });
    expect(exact.arrivalStart).toBeNull();
    expect(arrivalPhrase({ start: exact.start, end: null })).toBe("at 10:30 am");
    expect(exact.end.getTime() - exact.start.getTime()).toBe(2 * 3_600_000);
  });
});

describe("booking and dispatch", () => {
  it("booked with a tech: Scheduled + confirmation with address, day, arrival window and technician", async () => {
    const { owner, mike, lead } = await setup();
    await scheduleVisit(owner, { leadId: lead.id, kind: "estimate", techId: mike.id, ...bookingTimes({ date: DAY, window: "09-12", hours: 1 }) });
    expect(await stageOf(lead.id)).toBe("estimate_scheduled");
    await flushTexts();
    expect(lastText()).toContain("this is Degree of Comfort. Your service call at 3412 Erie Ave, Cincinnati is confirmed for Tuesday, Nov 3.");
    expect(lastText()).toContain("Mike Reyes will arrive between 9 am and 12 pm. We'll text you when Mike is on the way.");
  });

  it("all-day window says 'sometime between 9 am and 6 pm'", async () => {
    const { owner, mike, lead } = await setup();
    await scheduleVisit(owner, { leadId: lead.id, kind: "estimate", techId: mike.id, ...bookingTimes({ date: DAY, window: "09-18", hours: 1 }) });
    await flushTexts();
    expect(lastText()).toContain("Mike Reyes will arrive sometime between 9 am and 6 pm.");
  });

  it("booked without a tech: Needs tech, no text, no calendar; assigning sends the confirmation", async () => {
    const { owner, mike, lead } = await setup();
    const v = await scheduleVisit(owner, { leadId: lead.id, kind: "estimate", techId: null, ...bookingTimes({ date: DAY, window: "12-15", hours: 1 }) });
    expect(await stageOf(lead.id)).toBe("needs_tech");
    expect(v.syncState).toBe("skipped");
    expect(await db.enrollment.count({ where: { visitId: v.id } })).toBe(0);
    expect(await planStageMove(owner, lead.id, "estimate_scheduled")).toMatchObject({ kind: "assignTech", visitId: v.id });

    await rescheduleVisit(owner, v.id, { start: v.start, end: v.end, techId: mike.id });
    expect(await stageOf(lead.id)).toBe("estimate_scheduled");
    await flushTexts();
    expect(lastText()).toContain("Mike Reyes will arrive between 12 pm and 3 pm");
  });

  it("moving the time texts 'has been moved to'; changing only the tech texts 'Change of technician'", async () => {
    const { owner, mike, dana, lead } = await setup();
    const v = await scheduleVisit(owner, { leadId: lead.id, kind: "estimate", techId: mike.id, ...bookingTimes({ date: DAY, window: "09-12", hours: 1 }) });
    quo.sent.length = 0;
    const moved = bookingTimes({ date: "2026-11-05", window: "12-15", hours: 1 });
    await rescheduleVisit(owner, v.id, { ...moved });
    expect(lastText()).toContain("Your service call has been moved to Thu, Nov 5. Mike Reyes will arrive between 12 pm and 3 pm.");

    await rescheduleVisit(owner, v.id, { start: moved.start, end: moved.end, techId: dana.id });
    expect(lastText()).toContain("Change of technician: Dana Cole will come instead of Mike Reyes, same time (Thu, Nov 5, between 12 pm and 3 pm).");

    // Dispatch drags can skip the text.
    const count = quo.sent.length;
    await rescheduleVisit(owner, v.id, { start: new Date(moved.start.getTime() + 3_600_000), end: new Date(moved.end.getTime() + 3_600_000) }, { notifyCustomer: false });
    expect(quo.sent.length).toBe(count);
  });
});

describe("day of the visit", () => {
  it("On my way → On the way, Arrived → On site; running late texts the new time", async () => {
    const { owner, mike, lead } = await setup();
    const v = await scheduleVisit(owner, { leadId: lead.id, kind: "estimate", techId: mike.id, ...bookingTimes({ date: DAY, window: "09-12", hours: 1 }) });
    quo.sent.length = 0;

    await runningLate(mike, v.id, 60, new Date("2026-11-03T15:07:00Z")); // 10:07 am Eastern
    expect(lastText()).toBe("Hi Sarah, Mike from Degree of Comfort is running behind at a previous call. New arrival time is about 11:10 am. Sorry for the wait!");
    expect((await db.visit.findUniqueOrThrow({ where: { id: v.id } })).lateEta).not.toBeNull();

    await updateVisitStatus(mike, v.id, "en_route", { notifyCustomer: true });
    expect(await stageOf(lead.id)).toBe("on_the_way");
    expect(lastText()).toContain("Mike from Degree of Comfort is on the way");
    await updateVisitStatus(mike, v.id, "in_progress");
    expect(await stageOf(lead.id)).toBe("on_site");
  });

  it("tech can't make it: visit cancelled, Needs reschedule, customer + owner told; rebooking texts the new time", async () => {
    const { owner, mike, dana, lead } = await setup();
    await saveCompanyDetails(owner, { ...(await getCompany()), name: "Degree of Comfort", ownerAlertPhone: "513-555-0100", serviceCallFeeCents: 8900 });
    const v = await scheduleVisit(owner, { leadId: lead.id, kind: "estimate", techId: mike.id, ...bookingTimes({ date: DAY, window: "09-12", hours: 1 }) });
    quo.sent.length = 0;

    await needsReschedule(mike, v.id, { reason: "tech_delayed", note: "Furnace job ran long" });
    expect((await db.visit.findUniqueOrThrow({ where: { id: v.id } })).status).toBe("cancelled");
    expect(await stageOf(lead.id)).toBe("needs_reschedule");
    expect(texts()).toContainEqual(expect.stringContaining("We're sorry, our technician is held up at a previous call, so we need to reschedule your service call on Tue, Nov 3."));
    expect(quo.sent.some((m) => m.to === "+15135550100" && m.content.includes("can't make Sarah Mitchell"))).toBe(true);

    quo.sent.length = 0;
    const v2 = await scheduleVisit(owner, { leadId: lead.id, kind: "estimate", techId: dana.id, ...bookingTimes({ date: "2026-11-04", window: "15-18", hours: 1 }) });
    expect(await stageOf(lead.id)).toBe("estimate_scheduled");
    expect(lastText()).toContain("has been moved to Wed, Nov 4. Dana Cole will arrive between 3 pm and 6 pm.");
    // Only the reminder is queued (no second "you're confirmed").
    const e = await db.enrollment.findFirstOrThrow({ where: { visitId: v2.id } });
    expect(e.stepIndex).toBe(1);
  });

  it("customer asked to move it: no 'we're sorry' text", async () => {
    const { owner, mike, lead } = await setup();
    const v = await scheduleVisit(owner, { leadId: lead.id, kind: "estimate", techId: mike.id, ...bookingTimes({ date: DAY, window: "09-12", hours: 1 }) });
    quo.sent.length = 0;
    await needsReschedule(owner, v.id, { reason: "customer_request" });
    expect(await stageOf(lead.id)).toBe("needs_reschedule");
    expect(quo.sent).toHaveLength(0);
  });
});

describe("on site outcomes", () => {
  async function onSite() {
    const s = await setup();
    const item = await savePriceBookItem(s.owner, { trade: "hvac", category: "labor", name: "Capacitor swap", unit: "ea", costCents: null, priceCents: 28500 });
    await saveTerms(s.owner, { body: "# Terms\n\n" + "These terms apply to all work we do for you. ".repeat(3), keyTerms: "{deposit} deposit." });
    await db.lead.update({ where: { id: s.lead.id }, data: { assignedToId: s.mike.id } });
    const v = await scheduleVisit(s.owner, { leadId: s.lead.id, kind: "estimate", techId: s.mike.id, ...bookingTimes({ date: DAY, window: "09-12", hours: 1 }) });
    await updateVisitStatus(s.mike, v.id, "en_route");
    await updateVisitStatus(s.mike, v.id, "in_progress");
    // The tech writes and presents the estimate on site (no text to the customer).
    const opt = (tier: "good" | "better" | "best") => ({ tier, title: `Replace capacitor (${tier})`, priceCents: 28500, lineItems: [{ description: "Capacitor swap", qty: 1, priceBookItemId: item.id }] });
    const draft = await createProposalDraft(s.mike, s.lead.id, { summary: "Repair", options: [opt("good"), opt("better"), opt("best")] });
    await sendProposal(s.mike, draft.id, { textCustomer: false });
    await expect(sendProposal(s.mike, draft.id, { textCustomer: true })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await stageOf(s.lead.id)).toBe("estimate_sent");
    return { ...s, v, proposalId: draft.id };
  }

  it("signed → Start work now: job without deposit, job visit in progress, then complete → invoiced", async () => {
    const { owner, mike, lead, v, proposalId } = await onSite();
    const p = await db.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { options: true } });
    await recordPaperApproval(owner, proposalId, { optionId: p.options[0]!.id, signerName: "Sarah Mitchell" });
    expect(await stageOf(lead.id)).toBe("estimate_approved");

    const res = await wrapUpVisit(mike, v.id, { outcome: "work_now" });
    const job = await db.job.findUniqueOrThrow({ where: { id: (res as { jobId: string }).jobId } });
    expect(job).toMatchObject({ depositCents: 0, status: "in_progress" });
    expect(await stageOf(lead.id)).toBe("job_in_progress");
    expect((await db.visit.findUniqueOrThrow({ where: { id: v.id } })).outcome).toBe("work_now");

    await updateVisitStatus(mike, (res as { jobVisitId: string }).jobVisitId, "done");
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("invoiced");
    expect(await stageOf(lead.id)).toBe("invoiced");
  });

  it("not signed: Start work now is refused", async () => {
    const { mike, v } = await onSite();
    await expect(wrapUpVisit(mike, v.id, { outcome: "work_now" })).rejects.toThrow(/sign the estimate first/);
  });

  it("declined with the fee collected: Declined, service fee payment, follow-up drip", async () => {
    const { mike, lead, v } = await onSite();
    await wrapUpVisit(mike, v.id, { outcome: "declined", reason: "Too expensive", fee: "collect", feeCents: 8900, method: "card" });
    expect(await stageOf(lead.id)).toBe("estimate_declined");
    expect(await db.visit.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({ status: "done", outcome: "declined", feeStatus: "collected", feeCents: 8900 });
    expect(await db.payment.findFirstOrThrow({ where: { kind: "service_fee" } })).toMatchObject({ amountCents: 8900, method: "card" });
    expect(await db.enrollment.count({ where: { leadId: lead.id, status: "active", sequence: { key: "estimate_declined" } } })).toBe(1);
    expect(await db.enrollment.count({ where: { leadId: lead.id, status: "active", sequence: { key: "proposal_followup" } } })).toBe(0);
  });

  it("declined with an invoice: QuickBooks invoice + pay link text; paid when the invoice clears", async () => {
    const { mike, v } = await onSite();
    quo.sent.length = 0;
    await wrapUpVisit(mike, v.id, { outcome: "declined", reason: "Getting other quotes", fee: "invoice", feeCents: 8900 });
    const visit = await db.visit.findUniqueOrThrow({ where: { id: v.id } });
    expect(visit.feeStatus).toBe("invoiced");
    expect(visit.feeInvoiceId).toBeTruthy();
    expect(lastText()).toContain("Your service call fee of $89.00 is ready to pay");
    qbo.state.invoices.set(visit.feeInvoiceId!, 0);
    expect(await pollServiceFeeInvoices()).toBe(1);
    expect((await db.visit.findUniqueOrThrow({ where: { id: v.id } })).feeStatus).toBe("paid");
  });

  it("declined, no charge", async () => {
    const { mike, lead, v } = await onSite();
    await wrapUpVisit(mike, v.id, { outcome: "declined", reason: "Wants to think about it", fee: "none" });
    expect(await stageOf(lead.id)).toBe("estimate_declined");
    expect((await db.visit.findUniqueOrThrow({ where: { id: v.id } })).feeStatus).toBe("waived");
    expect(await db.payment.count({ where: { kind: "service_fee" } })).toBe(0);
  });
});

describe("scheduler", () => {
  it("new requests move to Needs scheduling after 4 hours, unless the customer already picked windows", async () => {
    const { owner, lead } = await setup();
    const waiting = await createLead(owner, { customer: { name: "Pat Jones", phone: "513-555-0122" }, title: "Leak", trade: "plumbing" });
    await db.bookingRequest.create({ data: { leadId: waiting.id, date: DAY, window: "09-12", altDate: "2026-11-04", altWindow: "12-15", source: "website" } });
    const old = new Date(Date.now() - 5 * 3_600_000);
    await db.lead.updateMany({ data: { stageChangedAt: old } });
    await runTick();
    expect(await stageOf(lead.id)).toBe("follow_up");
    expect(await stageOf(waiting.id)).toBe("new");
  });
});
