import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { createMockDiscordClient, setDiscordClient } from "@/lib/integrations/discord";
import { createMockQuoClient, setQuoClient } from "@/lib/integrations/quo";
import { createMockGeocodingClient, setGeocodingClient } from "@/lib/integrations/google-maps";
import { setCalendarClient, type CalendarClient, type CalendarEvent } from "@/lib/integrations/google-calendar";
import { holidaysBetween, holidaysForYear } from "@/lib/holidays";
import { calendarItems, calendarUsers } from "@/lib/services/calendar";
import { createLead } from "@/lib/services/leads";
import { scheduleVisit } from "@/lib/services/visits";
import { easternMidnight } from "@/lib/services/dispatch";
import { ensureDefaultSequences } from "@/lib/services/sequences";
import { makeUser, resetDb } from "./helpers";

setDiscordClient(createMockDiscordClient());
setQuoClient(createMockQuoClient());
setGeocodingClient(createMockGeocodingClient());

const at = (iso: string) => new Date(iso);
const ev = (p: Partial<CalendarEvent> & { id: string }): CalendarEvent => ({
  status: "confirmed",
  start: null,
  end: null,
  visitId: null,
  summary: "",
  allDay: false,
  transparent: false,
  ...p,
});

// Each refresh token's calendar.
const calendars: Record<string, CalendarEvent[]> = {
  "rt-owner": [
    ev({ id: "dentist", summary: "Dentist cleaning", start: at("2026-10-07T18:30:00Z"), end: at("2026-10-07T19:00:00Z"), htmlLink: "https://calendar.google.com/e/1" }),
    ev({ id: "trip", summary: "Fall trip", allDay: true, startDate: "2026-10-16", endDate: "2026-10-18" }),
  ],
  "rt-tech": [
    ev({ id: "court", summary: "Small claims court", start: at("2026-10-07T13:30:00Z"), end: at("2026-10-07T13:45:00Z") }),
    ev({ id: "free", summary: "Gym (free)", start: at("2026-10-08T12:00:00Z"), end: at("2026-10-08T13:00:00Z"), transparent: true }),
    ev({ id: "crm", summary: "CRM visit", start: at("2026-10-09T13:00:00Z"), end: at("2026-10-09T14:00:00Z"), visitId: "v1" }),
  ],
};
const stub: CalendarClient = {
  async upsertEvent() {
    return "evt";
  },
  async deleteEvent() {},
  async listChanged() {
    return [];
  },
  async listBetween(rt) {
    if (rt === "rt-broken") throw new Error("invalid_grant");
    return calendars[rt] ?? [];
  },
};
setCalendarClient(stub);

beforeEach(async () => {
  await resetDb();
  await db.$executeRawUnsafe(`TRUNCATE "Sequence" CASCADE`);
  await ensureDefaultSequences();
});
afterAll(() => db.$disconnect());

const range = { from: easternMidnight("2026-10-01"), to: easternMidnight("2026-11-01") };

async function staff() {
  const owner = await makeUser("owner", "owner@test.dev");
  const tech = await makeUser("tech", "tech@test.dev");
  const other = await makeUser("tech", "other@test.dev");
  await db.user.update({ where: { id: owner.id }, data: { googleRefreshToken: encrypt("rt-owner") } });
  await db.user.update({ where: { id: tech.id }, data: { googleRefreshToken: encrypt("rt-tech") } });
  return { owner, tech, other };
}

describe("holidays", () => {
  it("computes floating and fixed holidays", () => {
    const h = Object.fromEntries(holidaysForYear(2026).map((x) => [x.name, x.date]));
    expect(h["Columbus Day"]).toBe("2026-10-12");
    expect(h["Thanksgiving"]).toBe("2026-11-26");
    expect(h["Memorial Day"]).toBe("2026-05-25");
    expect(h["Labor Day"]).toBe("2026-09-07");
    expect(holidaysBetween("2026-12-27", "2027-01-04").map((x) => x.date)).toEqual(["2026-12-31", "2027-01-01"]);
  });
});

describe("calendar page data", () => {
  it("owner sees CRM visits plus Google events: own with titles, a tech's as Busy, CRM-made and free events skipped", async () => {
    const { owner, tech } = await staff();
    const lead = await createLead(owner, { customer: { name: "Wes Stone", phone: "513-555-0199" }, title: "Furnace check", trade: "hvac" });
    await scheduleVisit(owner, { leadId: lead.id, kind: "estimate", techId: tech.id, start: at("2026-10-02T18:00:00Z"), end: at("2026-10-02T19:00:00Z") });

    const users = await calendarUsers(owner);
    const { items, failed } = await calendarItems(owner, { ...range, userIds: users.map((u) => u.id), google: true });
    expect(failed).toEqual([]);

    const visit = items.find((i) => i.type === "visit");
    expect(visit).toMatchObject({ kind: "estimate", customer: "Wes Stone", userId: tech.id, leadId: lead.id });

    const google = items.filter((i) => i.type === "google");
    expect(google.map((g) => g.title).sort()).toEqual(["Busy", "Dentist cleaning", "Fall trip"]);
    expect(google.find((g) => g.title === "Dentist cleaning")).toMatchObject({ mine: true, link: "https://calendar.google.com/e/1" });
    expect(google.find((g) => g.title === "Fall trip")).toMatchObject({ startDate: "2026-10-16", endDate: "2026-10-18", start: null });
    expect(google.find((g) => g.title === "Busy")).toMatchObject({ userId: tech.id, mine: false, link: null });
  });

  it("a tech sees only their own calendar, with their own titles", async () => {
    const { owner, tech } = await staff();
    const asTech = (await calendarUsers(tech)).map((u) => u.id);
    expect(asTech).toEqual([tech.id]);
    const { items } = await calendarItems(tech, { ...range, userIds: [owner.id, tech.id], google: true });
    expect(items.every((i) => i.userId === tech.id)).toBe(true);
    expect(items.map((i) => i.type === "google" && i.title)).toEqual(["Small claims court", "Gym (free)"]);
  });

  it("reports a calendar it couldn't read instead of failing the page", async () => {
    const { owner, other } = await staff();
    await db.user.update({ where: { id: other.id }, data: { googleRefreshToken: encrypt("rt-broken") } });
    const { items, failed } = await calendarItems(owner, { ...range, userIds: [owner.id, other.id], google: true });
    expect(failed).toEqual(["other"]);
    expect(items.length).toBe(2);
  });

  it("skips Google entirely when only CRM visits are wanted", async () => {
    const { owner } = await staff();
    const { items } = await calendarItems(owner, { ...range, userIds: [owner.id], google: false });
    expect(items).toEqual([]);
  });
});
