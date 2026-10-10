import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createMockDiscordClient, setDiscordClient } from "@/lib/integrations/discord";
import { createMockGeocodingClient, setGeocodingClient } from "@/lib/integrations/google-maps";
import { createMockQuoClient, setQuoClient } from "@/lib/integrations/quo";
import { createMemoryBlobStore, setBlobStore } from "@/lib/integrations/blob";
import { createMockQuickBooksClient } from "@/lib/integrations/quickbooks";
import { createMockCalendarClient, setCalendarClient } from "@/lib/integrations/google-calendar";
import { createMockEmailClient, setEmailClient } from "@/lib/integrations/email";
import { setPdfRenderer } from "@/lib/pdf";
import { setQuickBooksClient } from "@/lib/services/quickbooks-auth";
import { bookableDates } from "@/lib/booking";
import { confirmBooking, requestBooking, windowTimes } from "@/lib/services/booking";
import { planStageMove, performStageMove } from "@/lib/services/stage-moves";
import { ensureDefaultSequences } from "@/lib/services/sequences";
import { savePriceBookItem } from "@/lib/services/pricebook";
import { saveTerms } from "@/lib/services/terms";
import { DEFAULT_TAX_RATES, saveTaxRates } from "@/lib/services/tax";
import { createLead } from "@/lib/services/leads";
import { createProposalDraft } from "@/lib/services/proposals";
import { ValidationError } from "@/lib/services/actor";
import { makeUser, resetDb } from "./helpers";

const quo = createMockQuoClient();
setDiscordClient(createMockDiscordClient());
setQuoClient(quo);
setBlobStore(createMemoryBlobStore());
setQuickBooksClient(createMockQuickBooksClient());
setCalendarClient(createMockCalendarClient());
setEmailClient(createMockEmailClient());
setGeocodingClient(createMockGeocodingClient());
setPdfRenderer(async () => Buffer.from("%PDF-1.4"));

beforeEach(async () => {
  await resetDb();
  await db.$executeRawUnsafe(`TRUNCATE "BookingRequest", "TaxRate", "PriceBookItem", "TermsVersion", "Sequence" CASCADE`);
  await saveTaxRates({ kind: "system", label: "t" }, DEFAULT_TAX_RATES);
  await ensureDefaultSequences();
  quo.sent.length = 0;
});
afterAll(() => db.$disconnect());

const website = { kind: "system" as const, label: "Website booking" };

describe("booking requests", () => {
  it("offers Mon–Sat, tomorrow to 3 weeks out", () => {
    const dates = bookableDates(new Date("2026-10-10T15:00:00Z")); // Saturday
    expect(dates[0]!.ymd).toBe("2026-10-12"); // Sunday skipped
    expect(dates.every((d) => !d.label.startsWith("Sunday"))).toBe(true);
    expect(dates.length).toBe(18);
  });

  it("maps a window to Eastern times", () => {
    const { start, end } = windowTimes("2026-10-14", "09-12");
    expect(start.toISOString()).toBe("2026-10-14T13:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-14T16:00:00.000Z");
  });

  it("website request → lead + pending request + acknowledgement text; owner confirm books the window", async () => {
    const owner = await makeUser("owner", "owner@test.dev");
    const tech = await makeUser("tech", "tech@test.dev");
    const day = bookableDates()[2]!.ymd;
    const r = await requestBooking(
      website,
      { name: "Ana Diaz", phone: "513-555-0199", street: "12 Main St", zip: "45202", trade: "hvac", message: "Furnace won't start", date: day, window: "12-15" },
      { ip: "9.9.9.9", source: "website" },
    );
    expect(r.status).toBe("pending");
    expect(quo.sent.at(-1)!.content).toMatch(/We got your request for .*12 pm – 3 pm/);
    const lead = await db.lead.findUniqueOrThrow({ where: { id: r.leadId } });
    expect(lead).toMatchObject({ source: "web_form", trade: "hvac", stage: "new" });

    const v = await confirmBooking(owner, r.id, { techId: tech.id });
    expect(v.start.toISOString()).toBe(windowTimes(day, "12-15").start.toISOString());
    expect(v.end.getTime() - v.start.getTime()).toBe(3 * 3_600_000);
    expect((await db.bookingRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("confirmed");
    expect((await db.lead.findUniqueOrThrow({ where: { id: r.leadId } })).stage).toBe("estimate_scheduled");
    expect(await db.enrollment.count({ where: { visitId: v.id, sequence: { key: "estimate_visit" } } })).toBe(1);
  });

  it("rejects Sundays and past days", async () => {
    await expect(
      requestBooking(website, { name: "A B", phone: "5135550199", street: "1 A St", trade: "hvac", message: "Help", date: "2020-01-01", window: "09-12" }, { ip: null, source: "website" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("pipeline drag does the stage's work", () => {
  async function lead() {
    const owner = await makeUser("owner", "owner@test.dev");
    const tech = await makeUser("tech", "tech@test.dev");
    const l = await createLead(owner, { customer: { name: "Pat", phone: "5135550123" }, property: { street: "1 Vine St", county: "Hamilton" }, title: "No heat", trade: "hvac" });
    return { owner, tech, l };
  }

  it("Estimate scheduled books a window (and confirms a pending request)", async () => {
    const { owner, tech, l } = await lead();
    const day = bookableDates()[1]!.ymd;
    await requestBooking(owner, { leadId: l.id, date: day, window: "15-18" }, { ip: null, source: "staff" });
    const plan = await planStageMove(owner, l.id, "estimate_scheduled");
    expect(plan).toMatchObject({ kind: "scheduleEstimate", booking: { date: day, window: "15-18" } });
    await performStageMove(owner, l.id, "estimate_scheduled", { techId: tech.id, date: day, window: "15-18" });
    expect((await db.lead.findUniqueOrThrow({ where: { id: l.id } })).stage).toBe("estimate_scheduled");
    expect(await db.bookingRequest.count({ where: { leadId: l.id, status: "confirmed" } })).toBe(1);
  });

  it("Estimate sent without a proposal is blocked with a link to create one; approved records a paper signature", async () => {
    const { owner, l } = await lead();
    expect(await planStageMove(owner, l.id, "estimate_sent")).toMatchObject({ kind: "blocked", href: `/leads/${l.id}/proposal/new` });

    const item = await savePriceBookItem(owner, { trade: "hvac", category: "labor", name: "Labor", unit: "hr", costCents: null, priceCents: 10000 });
    await saveTerms(owner, { body: "# Terms\n\n" + "These terms apply to all work we do. ".repeat(4), keyTerms: "{deposit} deposit." });
    const opt = (tier: "good" | "better" | "best") => ({ tier, title: tier, lineItems: [{ description: "Labor", qty: 1, priceBookItemId: item.id }] });
    await createProposalDraft(owner, l.id, { summary: "x", options: [opt("good"), opt("better"), opt("best")] });

    const send = await planStageMove(owner, l.id, "estimate_sent");
    expect(send).toMatchObject({ kind: "sendProposal", problems: [] });
    await performStageMove(owner, l.id, "estimate_sent", { textCustomer: true });
    expect((await db.lead.findUniqueOrThrow({ where: { id: l.id } })).stage).toBe("estimate_sent");

    const approve = await planStageMove(owner, l.id, "estimate_approved");
    expect(approve.kind).toBe("recordApproval");
    const optionId = approve.kind === "recordApproval" ? approve.options[0]!.id : "";
    await performStageMove(owner, l.id, "estimate_approved", { optionId, signerName: "Pat" });
    expect((await db.lead.findUniqueOrThrow({ where: { id: l.id } })).stage).toBe("estimate_approved");
    expect((await db.signature.findFirstOrThrow()).method).toBe("paper");

    // Next: no job yet → record the deposit (creates the job), then the same stage schedules the visit.
    expect((await planStageMove(owner, l.id, "job_scheduled")).kind).toBe("recordDeposit");
    await performStageMove(owner, l.id, "job_scheduled", { method: "check", amountDollars: "50" });
    expect(await db.job.count({ where: { leadId: l.id } })).toBe(1);
    expect((await planStageMove(owner, l.id, "job_scheduled")).kind).toBe("scheduleJob");
  });

  it("techs can't do owner steps; moving backwards just moves", async () => {
    const { tech, owner, l } = await lead();
    await db.lead.update({ where: { id: l.id }, data: { assignedToId: tech.id } });
    expect((await planStageMove(tech, l.id, "estimate_scheduled")).kind).toBe("blocked");
    await db.lead.update({ where: { id: l.id }, data: { stage: "estimate_sent" } });
    expect((await planStageMove(owner, l.id, "follow_up")).kind).toBe("simple");
  });
});
