// Dispatch board data + the slot finder (SPEC.md "Dispatch board").

import { z } from "zod";
import { db } from "@/lib/db";
import { driveMinutesTo, type LatLng } from "@/lib/integrations/google-maps";
import { geocodeProperty } from "./geocode";
import { busyBlocks, listVisits } from "./visits";
import type { Actor } from "./actor";

const TZ = "America/New_York";
export const WORKDAY = { startHour: 8, endHour: 17 };

/** Midnight (Eastern) of the given Eastern calendar date "YYYY-MM-DD", as a UTC Date. */
export function easternMidnight(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  // Find the UTC offset for that date in New York (handles DST).
  const probe = new Date(Date.UTC(y, m - 1, d, 12));
  const tzName = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "shortOffset" }).formatToParts(probe).find((p) => p.type === "timeZoneName")!.value;
  const offsetHours = Number(tzName.replace("GMT", "") || 0);
  return new Date(Date.UTC(y, m - 1, d, -offsetHours));
}

export function easternYmd(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function boardData(actor: Actor, opts: { from: Date; to: Date }) {
  const techs = await db.user.findMany({ where: { active: true }, orderBy: [{ role: "asc" }, { name: "asc" }] });
  const [visits, busy, unscheduledJobs, leadsNeedingEstimate] = await Promise.all([
    listVisits(actor, { from: opts.from, to: opts.to }),
    busyBlocks(techs.map((t) => t.id), opts.from, opts.to),
    db.job.findMany({
      where: { status: "unscheduled" },
      include: { lead: { include: { customer: true, property: true } } },
      orderBy: { createdAt: "asc" },
    }),
    db.lead.findMany({
      where: {
        OR: [
          { stage: { in: ["new", "follow_up"] }, visits: { none: { kind: "estimate", status: { notIn: ["cancelled"] } } } },
          { bookings: { some: { status: "pending" } } },
        ],
      },
      include: { customer: true, property: true, bookings: { where: { status: "pending" }, take: 1 } },
      orderBy: { createdAt: "asc" },
      take: 50,
    }),
  ]);
  return { techs, visits, busy, unscheduledJobs, leadsNeedingEstimate };
}

// ---- Slot finder ------------------------------------------------------------------

export const slotQuery = z.object({
  leadId: z.string(),
  durationHours: z.number().min(0.5).max(12),
  maxDriveMinutes: z.number().int().min(5).max(180).default(30),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  days: z.number().int().min(1).max(21).default(10),
  techId: z.string().nullable().default(null),
  count: z.number().int().min(1).max(10).default(3),
});

export type Slot = { techId: string; techName: string; start: Date; end: Date; driveMinutes: number | null; fromWhere: string };

type Busy = { start: number; end: number; loc: LatLng | null; label: string };

/**
 * Next openings for a job at the lead's address: inside 8–5 Mon–Sat, not overlapping the tech's
 * visits or Google busy time, with drive time from the tech's previous stop (when known) within the limit.
 */
export async function findSlots(actor: Actor, raw: z.input<typeof slotQuery>, now = new Date()): Promise<{ slots: Slot[]; target: LatLng | null }> {
  const q = slotQuery.parse(raw);
  const lead = await db.lead.findUniqueOrThrow({ where: { id: q.leadId }, include: { property: true } });
  let target: LatLng | null = null;
  if (lead.property) {
    if (lead.property.lat == null) await geocodeProperty(lead.property.id);
    const p = await db.property.findUnique({ where: { id: lead.property.id } });
    if (p?.lat != null && p.lng != null) target = { lat: p.lat, lng: p.lng };
  }

  const startYmd = q.fromDate ?? easternYmd(now);
  const from = easternMidnight(startYmd);
  const to = easternMidnight(addDaysYmd(startYmd, q.days));
  const techs = await db.user.findMany({ where: { active: true, ...(q.techId ? { id: q.techId } : {}) }, orderBy: { name: "asc" } });
  const visits = await db.visit.findMany({
    where: { techId: { in: techs.map((t) => t.id) }, status: { notIn: ["cancelled"] }, start: { lt: to }, end: { gt: from } },
    include: { lead: { include: { property: true } } },
  });
  const external = await busyBlocks(techs.map((t) => t.id), from, to);

  const busyByTech = new Map<string, Busy[]>();
  for (const t of techs) busyByTech.set(t.id, []);
  for (const v of visits) {
    const loc = v.lead.property?.lat != null ? { lat: v.lead.property.lat, lng: v.lead.property.lng! } : null;
    busyByTech.get(v.techId)?.push({ start: v.start.getTime(), end: v.end.getTime(), loc, label: v.lead.property?.street ?? "previous job" });
  }
  for (const b of external) busyByTech.get(b.techId)?.push({ start: b.start.getTime(), end: b.end.getTime(), loc: null, label: "appointment" });
  for (const list of busyByTech.values()) list.sort((a, b) => a.start - b.start);

  const durMs = q.durationHours * 3_600_000;
  const stepMs = 30 * 60_000;
  type Candidate = { techId: string; start: number; prev: Busy | null; next: Busy | null };
  const candidates: Candidate[] = [];

  for (let day = 0; day < q.days && candidates.length < 200; day++) {
    const ymd = addDaysYmd(startYmd, day);
    const midnight = easternMidnight(ymd);
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(new Date(midnight.getTime() + 12 * 3_600_000));
    if (weekday === "Sun") continue;
    const dayStart = midnight.getTime() + WORKDAY.startHour * 3_600_000;
    const dayEnd = midnight.getTime() + WORKDAY.endHour * 3_600_000;
    for (const t of techs) {
      const busy = busyByTech.get(t.id)!;
      for (let s = dayStart; s + durMs <= dayEnd; s += stepMs) {
        if (s < now.getTime() + 60 * 60_000) continue; // at least an hour out
        const e = s + durMs;
        if (busy.some((b) => b.start < e && b.end > s)) continue;
        const prev = [...busy].reverse().find((b) => b.end <= s && b.end >= dayStart) ?? null;
        const next = busy.find((b) => b.start >= e && b.start <= dayEnd) ?? null;
        candidates.push({ techId: t.id, start: s, prev, next });
      }
    }
  }
  candidates.sort((a, b) => a.start - b.start);

  // Drive-time check on the earliest candidates (batched per unique previous stop).
  const slots: Slot[] = [];
  const driveCache = new Map<string, number>();
  for (const c of candidates) {
    if (slots.length >= q.count) break;
    // One suggestion per tech per day keeps the list useful.
    if (slots.some((s) => s.techId === c.techId && easternYmd(s.start) === easternYmd(new Date(c.start)))) continue;
    let drive: number | null = null;
    if (target && c.prev?.loc) {
      const key = `${c.prev.loc.lat},${c.prev.loc.lng}`;
      if (!driveCache.has(key)) driveCache.set(key, (await driveMinutesTo([c.prev.loc], target))[0]!);
      drive = driveCache.get(key)!;
      if (drive > q.maxDriveMinutes) continue;
      if (c.start - c.prev.end < drive * 60_000) continue; // not enough time to get there
    }
    if (target && c.next?.loc) {
      const back = (await driveMinutesTo([target], c.next.loc))[0]!;
      if (c.next.start - (c.start + durMs) < back * 60_000) continue;
    }
    const tech = techs.find((t) => t.id === c.techId)!;
    slots.push({
      techId: c.techId,
      techName: tech.name,
      start: new Date(c.start),
      end: new Date(c.start + durMs),
      driveMinutes: drive,
      fromWhere: c.prev ? c.prev.label : "start of day",
    });
  }
  return { slots, target };
}
