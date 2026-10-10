// The calendar page: CRM visits plus each person's own Google Calendar events, for a date range.
// Google events are read live and never stored. Event details are shown only to the calendar's owner;
// everyone else (the owner looking at a tech's day) sees "Busy".

import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { formatAddress } from "@/lib/notifications/discord-embeds";
import { getCalendarClient } from "@/lib/integrations/google-calendar";
import { isOwner, type Actor } from "./actor";
import { listVisits } from "./visits";

export type CalendarUser = { id: string; name: string; connected: boolean; calendarEmail: string | null };

export type CalendarItem =
  | {
      type: "visit";
      id: string;
      kind: "estimate" | "job";
      status: string;
      userId: string;
      start: number;
      end: number;
      title: string;
      customer: string;
      address: string;
      leadId: string;
    }
  | {
      type: "google";
      id: string;
      userId: string;
      title: string;
      /** Timed events. */
      start: number | null;
      end: number | null;
      /** All-day events: "YYYY-MM-DD", end exclusive. */
      startDate: string | null;
      endDate: string | null;
      link: string | null;
      mine: boolean;
    };

/** Staff whose calendars this person may look at: the owner sees everyone, a tech only themselves. */
export async function calendarUsers(actor: Actor): Promise<CalendarUser[]> {
  const me = (actor as { id: string }).id;
  const users = await db.user.findMany({
    where: { active: true, ...(isOwner(actor) ? {} : { id: me }) },
    orderBy: [{ role: "asc" }, { name: "asc" }],
    select: { id: true, name: true, googleRefreshToken: true, googleCalendarEmail: true },
  });
  return users.map((u) => ({ id: u.id, name: u.name, connected: Boolean(u.googleRefreshToken), calendarEmail: u.googleCalendarEmail }));
}

export async function calendarItems(
  actor: Actor,
  opts: { from: Date; to: Date; userIds: string[]; google: boolean },
): Promise<{ items: CalendarItem[]; failed: string[] }> {
  const me = (actor as { id: string }).id;
  const allowed = new Set((await calendarUsers(actor)).map((u) => u.id));
  const userIds = opts.userIds.filter((id) => allowed.has(id));
  if (userIds.length === 0) return { items: [], failed: [] };

  const visits = (await listVisits(actor, { from: opts.from, to: opts.to })).filter((v) => userIds.includes(v.techId));
  const items: CalendarItem[] = visits.map((v) => ({
    type: "visit",
    id: v.id,
    kind: v.kind,
    status: v.status,
    userId: v.techId,
    start: v.start.getTime(),
    end: v.end.getTime(),
    title: v.job?.title ?? v.lead.title,
    customer: v.lead.customer.name,
    address: formatAddress(v.lead.property) ?? "",
    leadId: v.leadId,
  }));

  const failed: string[] = [];
  if (opts.google) {
    const users = await db.user.findMany({ where: { id: { in: userIds }, googleRefreshToken: { not: null } } });
    const cal = getCalendarClient();
    await Promise.all(
      users.map(async (u) => {
        try {
          const events = await cal.listBetween(decrypt(u.googleRefreshToken!), opts.from, opts.to);
          const mine = u.id === me;
          for (const e of events) {
            if (e.visitId) continue; // CRM visits are drawn from the database
            if (!mine && e.transparent) continue; // "free" time on someone else's calendar isn't busy
            const allDay = e.allDay && e.startDate;
            if (!allDay && (!e.start || !e.end)) continue;
            items.push({
              type: "google",
              id: `${u.id}:${e.id}`,
              userId: u.id,
              title: mine ? e.summary || "(No title)" : "Busy",
              start: allDay ? null : e.start!.getTime(),
              end: allDay ? null : e.end!.getTime(),
              startDate: allDay ? e.startDate! : null,
              endDate: allDay ? (e.endDate ?? null) : null,
              link: mine ? (e.htmlLink ?? null) : null,
              mine,
            });
          }
        } catch (err) {
          console.error("[calendar page]", u.email, err);
          failed.push(u.name);
        }
      }),
    );
  }
  return { items, failed };
}
