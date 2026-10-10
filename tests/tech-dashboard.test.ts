// The tech's Today screen: which step a visit is on, Customer not home, and the pre-visit brief
// (RentCast facts cached per property + our own history + talking points).

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createMockDiscordClient, setDiscordClient } from "@/lib/integrations/discord";
import { createMockGeocodingClient, setGeocodingClient } from "@/lib/integrations/google-maps";
import { createMockQuoClient, setQuoClient } from "@/lib/integrations/quo";
import { createMockEmailClient, setEmailClient } from "@/lib/integrations/email";
import { createMockQuickBooksClient } from "@/lib/integrations/quickbooks";
import { createMockCalendarClient, setCalendarClient } from "@/lib/integrations/google-calendar";
import { SAMPLE_FACTS, createMockPropertyDataClient, setPropertyDataClient } from "@/lib/integrations/rentcast";
import { setQuickBooksClient } from "@/lib/services/quickbooks-auth";
import { bookingTimes } from "@/lib/services/booking";
import { createLead } from "@/lib/services/leads";
import { customerNotHome, scheduleVisit, updateVisitStatus } from "@/lib/services/visits";
import { talkingPoints, visitBrief } from "@/lib/services/visit-brief";
import { visitPhase, visitSteps } from "@/lib/visit-steps";
import { makeUser, resetDb } from "./helpers";

const quo = createMockQuoClient();
setDiscordClient(createMockDiscordClient());
setQuoClient(quo);
setEmailClient(createMockEmailClient());
setQuickBooksClient(createMockQuickBooksClient());
setCalendarClient(createMockCalendarClient());
setGeocodingClient(createMockGeocodingClient());

beforeEach(async () => {
  await resetDb();
  await db.$executeRawUnsafe(`TRUNCATE "Payment", "Visit", "Job" CASCADE`);
  quo.sent.length = 0;
});
afterAll(() => {
  setPropertyDataClient(null);
  return db.$disconnect();
});

async function setup() {
  const owner = await makeUser("owner", "owner@test.dev");
  const mike = await makeUser("tech", "mike@test.dev");
  await db.user.update({ where: { id: mike.id }, data: { name: "Mike Reyes" } });
  mike.name = "Mike Reyes";
  const lead = await createLead(owner, {
    customer: { name: "Sarah Mitchell", phone: "513-555-0111" },
    property: { street: "3412 Erie Ave", zip: "45208", county: "Hamilton" },
    title: "AC not cooling",
    trade: "hvac",
    assignedToId: mike.id,
  });
  const v = await scheduleVisit(owner, { leadId: lead.id, kind: "estimate", techId: mike.id, ...bookingTimes({ date: "2026-11-03", window: "09-12", hours: 1 }) });
  return { owner, mike, lead, v };
}

describe("visit steps", () => {
  const base = { kind: "estimate" as const, outcome: null, hasTech: true, proposalStatus: null };

  it("walks an estimate visit: on the way → on site → estimate → signed", () => {
    expect(visitPhase({ ...base, status: "scheduled" })).toBe("scheduled");
    expect(visitPhase({ ...base, status: "in_progress" })).toBe("on_site_no_estimate");
    expect(visitPhase({ ...base, status: "in_progress", proposalStatus: "draft" })).toBe("on_site_estimate");
    expect(visitPhase({ ...base, status: "in_progress", proposalStatus: "signed" })).toBe("on_site_signed");
    expect(visitPhase({ ...base, status: "scheduled", hasTech: false })).toBe("no_tech");
    const strip = visitSteps({ ...base, status: "in_progress", proposalStatus: "sent" });
    expect(strip.map((s) => s.state)).toEqual(["done", "done", "current", "todo", "todo"]);
  });

  it("leaves Signed unchecked when the visit ended without a signature", () => {
    const strip = visitSteps({ ...base, status: "done", outcome: "no_show" });
    expect(strip.find((s) => s.label === "Signed")!.state).toBe("todo");
    expect(strip.find((s) => s.label === "Wrapped up")!.state).toBe("done");
  });

  it("job visits: on the way → working → complete", () => {
    expect(visitPhase({ ...base, kind: "job", status: "in_progress" })).toBe("working");
    expect(visitSteps({ ...base, kind: "job", status: "en_route" }).map((s) => s.state)).toEqual(["done", "current", "todo"]);
  });
});

describe("customer not home", () => {
  it("closes the visit, invoices the trip fee, texts the customer and puts the lead in Needs reschedule", async () => {
    const { mike, lead, v } = await setup();
    await expect(customerNotHome(mike, v.id, { fee: "none" })).rejects.toThrow(/On my way/);
    await updateVisitStatus(mike, v.id, "en_route");
    quo.sent.length = 0;

    await customerNotHome(mike, v.id, { fee: "invoice", feeCents: 8900 });
    expect(await db.visit.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({ status: "done", outcome: "no_show", feeStatus: "invoiced", feeCents: 8900 });
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).stage).toBe("needs_reschedule");
    expect(quo.sent.map((m) => m.content).join("\n")).toContain("Mike from Degree of Comfort stopped by");
  });

  it("no charge, no text", async () => {
    const { mike, v } = await setup();
    await updateVisitStatus(mike, v.id, "en_route");
    quo.sent.length = 0;
    await customerNotHome(mike, v.id, { fee: "none", notifyCustomer: false });
    expect((await db.visit.findUniqueOrThrow({ where: { id: v.id } })).feeStatus).toBe("waived");
    expect(quo.sent.filter((m) => m.content.includes("stopped by"))).toHaveLength(0);
  });
});

describe("pre-visit brief", () => {
  it("looks a property up once and reuses the cached facts", async () => {
    const rentcast = createMockPropertyDataClient();
    setPropertyDataClient(rentcast);
    const { mike, v } = await setup();
    const first = await visitBrief(mike, v.id);
    expect(first.facts?.yearBuilt).toBe(SAMPLE_FACTS.yearBuilt);
    await visitBrief(mike, v.id);
    expect(rentcast.calls).toHaveLength(1);
    expect(rentcast.calls[0]).toContain("3412 Erie Ave");
  });

  it("remembers a miss so the address isn't retried every visit", async () => {
    const rentcast = createMockPropertyDataClient(null);
    setPropertyDataClient(rentcast);
    const { mike, v } = await setup();
    expect((await visitBrief(mike, v.id)).facts).toBeNull();
    await visitBrief(mike, v.id);
    expect(rentcast.calls).toHaveLength(1);
  });

  it("talking points only say what the data supports", () => {
    const history = { customerSince: new Date(), otherRequests: 0, jobsDone: 0, paidCents: 0, declined: [], lastVisit: null };
    const now = new Date("2026-10-10T12:00:00Z");
    const points = talkingPoints("hvac", { ...SAMPLE_FACTS, lastSaleDate: "2026-04-01T00:00:00Z" }, history, now);
    expect(points.join(" ")).toMatch(/Built in 1998\. If the furnace \/ AC is original/);
    expect(points.join(" ")).toMatch(/Bought 6 months ago/);
    expect(talkingPoints("hvac", null, history, now)).toEqual([]);
  });
});
