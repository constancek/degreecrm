// Visits (estimates and job days) and their Google Calendar events (SPEC.md "Scheduling").
// The CRM owns assignment and times; each visit is mirrored onto the assigned tech's own calendar.

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { decrypt, encrypt, randomToken } from "@/lib/crypto";
import { tradeLabel } from "@/lib/stages";
import { formatPhone } from "@/lib/phone";
import { formatAddress, leadStageEmbed } from "@/lib/notifications/discord-embeds";
import { CALENDAR_SCOPE, CalendarError, getCalendarClient } from "@/lib/integrations/google-calendar";
import type { Prisma } from "@/generated/prisma/client";
import type { VisitStatus } from "@/generated/prisma/enums";
import { ForbiddenError, NotFoundError, SYSTEM, ValidationError, isOwner, type Actor } from "./actor";
import { recordActivity } from "./activity";
import { changeStage } from "./leads";
import { enqueueDiscord, flushOutboxSoon } from "./outbox";
import { sendCustomerText } from "./messages";
import { enroll, retimeVisitEnrollments, stopEnrollments } from "./sequences";

const STAGE_ORDER = [
  "new",
  "follow_up",
  "estimate_scheduled",
  "estimate_sent",
  "estimate_approved",
  "job_scheduled",
  "job_in_progress",
  "job_completed",
  "invoiced",
  "payment_complete",
  "review_requested",
];
const before = (a: string, b: string) => STAGE_ORDER.indexOf(a) < STAGE_ORDER.indexOf(b);

const visitInclude = {
  lead: {
    include: {
      customer: true,
      property: true,
      proposals: { where: { status: { in: ["sent", "viewed", "signed"] } }, orderBy: { version: "desc" }, take: 1, select: { id: true, status: true } },
    },
  },
  job: true,
  tech: { select: { id: true, name: true, phone: true, googleRefreshToken: true } },
} satisfies Prisma.VisitInclude;
export type FullVisit = Prisma.VisitGetPayload<{ include: typeof visitInclude }>;

/** Owner sees everything; techs see their own visits. */
function visitScope(actor: Actor): Prisma.VisitWhereInput {
  return isOwner(actor) ? {} : { techId: (actor as { id: string }).id };
}

export async function getVisit(actor: Actor, id: string) {
  const v = await db.visit.findFirst({ where: { id, ...visitScope(actor) }, include: visitInclude });
  if (!v) throw new NotFoundError("Visit not found");
  return v;
}

export async function listVisits(actor: Actor, opts: { from: Date; to: Date; techId?: string; includeCancelled?: boolean }) {
  return db.visit.findMany({
    where: {
      ...visitScope(actor),
      ...(opts.techId ? { techId: opts.techId } : {}),
      start: { lt: opts.to },
      end: { gt: opts.from },
      ...(opts.includeCancelled ? {} : { status: { not: "cancelled" } }),
    },
    include: visitInclude,
    orderBy: { start: "asc" },
  });
}

// ---- Create / move / cancel ------------------------------------------------------

export const scheduleInput = z
  .object({
    leadId: z.string(),
    jobId: z.string().nullable().default(null),
    kind: z.enum(["estimate", "job"]),
    techId: z.string(),
    start: z.coerce.date(),
    end: z.coerce.date(),
    notes: z.string().trim().max(2000).optional(),
  })
  .refine((v) => v.end > v.start, { message: "The end time must be after the start", path: ["end"] });

export async function scheduleVisit(actor: Actor, raw: z.input<typeof scheduleInput>) {
  if (!isOwner(actor)) throw new ForbiddenError("Only the owner schedules visits");
  const input = scheduleInput.parse(raw);
  const lead = await db.lead.findUnique({ where: { id: input.leadId } });
  if (!lead) throw new NotFoundError("Lead not found");
  const tech = await db.user.findFirst({ where: { id: input.techId, active: true } });
  if (!tech) throw new ValidationError("Choose a tech");
  let job = null;
  if (input.kind === "job") {
    job = input.jobId ? await db.job.findFirst({ where: { id: input.jobId, leadId: lead.id } }) : await db.job.findFirst({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" } });
    if (!job) throw new ValidationError("A job visit needs a job (the deposit creates it)");
  }

  const visit = await db.$transaction(async (tx) => {
    const v = await tx.visit.create({
      data: { leadId: lead.id, jobId: job?.id ?? null, kind: input.kind, techId: tech.id, start: input.start, end: input.end, notes: input.notes },
    });
    if (job) {
      await tx.job.update({
        where: { id: job.id },
        data: { status: job.status === "unscheduled" ? "scheduled" : undefined, assignedToId: job.assignedToId ?? tech.id },
      });
    }
    if (!lead.assignedToId) await tx.lead.update({ where: { id: lead.id }, data: { assignedToId: tech.id } });
    if (input.kind === "estimate") {
      // However it's booked (confirm button, dispatch drag, slot finder), a pending request is now handled.
      await tx.bookingRequest.updateMany({ where: { leadId: lead.id, status: "pending" }, data: { status: "confirmed", visitId: v.id } });
    }
    await recordActivity(tx, actor, {
      type: "visit_scheduled",
      leadId: lead.id,
      body: `${input.kind === "estimate" ? "Estimate" : "Job"} visit with ${tech.name} on ${when(input.start)}`,
      data: { visitId: v.id },
    });
    return v;
  });

  if (input.kind === "estimate" && before(lead.stage, "estimate_scheduled")) {
    await changeStage(actor, lead.id, "estimate_scheduled");
  }
  if (input.kind === "job" && before(lead.stage, "job_scheduled")) {
    await changeStage(actor, lead.id, "job_scheduled");
  }
  await enroll(input.kind === "estimate" ? "estimate_visit" : "job_visit", lead.id, { visitId: visit.id });
  await syncVisitSoon(visit.id);
  return getVisit(actor, visit.id);
}

const TIME = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const when = (d: Date) => TIME.format(d);

export async function rescheduleVisit(
  actor: Actor,
  id: string,
  input: { start: Date; end: Date; techId?: string },
  opts: { source?: "crm" | "google" } = {},
) {
  if (opts.source !== "google" && !isOwner(actor)) throw new ForbiddenError("Only the owner reschedules visits");
  if (!(input.end > input.start)) throw new ValidationError("The end time must be after the start");
  const v = await db.visit.findUnique({ where: { id }, include: { tech: true, lead: { include: { customer: true, property: true, assignedTo: { select: { name: true } } } } } });
  if (!v) throw new NotFoundError("Visit not found");
  if (["done", "cancelled"].includes(v.status)) throw new ValidationError("That visit is already closed");
  const tech = input.techId && input.techId !== v.techId ? await db.user.findFirst({ where: { id: input.techId, active: true } }) : v.tech;
  if (!tech) throw new ValidationError("Choose a tech");
  const moved = v.start.getTime() !== input.start.getTime() || v.end.getTime() !== input.end.getTime();
  if (!moved && tech.id === v.techId) return v;

  await db.$transaction(async (tx) => {
    await tx.visit.update({
      where: { id },
      data: { start: input.start, end: input.end, techId: tech.id, syncState: opts.source === "google" ? v.syncState : "pending" },
    });
    await recordActivity(tx, actor, {
      type: "visit_rescheduled",
      leadId: v.leadId,
      body: `Visit moved to ${when(input.start)}${tech.id !== v.techId ? ` with ${tech.name}` : ""}${opts.source === "google" ? " (changed in Google Calendar)" : ""}`,
      data: { visitId: id, from: v.start.toISOString(), to: input.start.toISOString() },
    });
    const embed = leadStageEmbed({ ...v.lead, assignedTo: { name: tech.name } });
    embed.embeds![0]!.title = `Rescheduled: ${v.lead.title} → ${when(input.start)}`;
    await enqueueDiscord(tx, embed);
  });
  await flushOutboxSoon();
  await retimeVisitEnrollments(id);
  if (opts.source !== "google") await syncVisitSoon(id);
  return getVisit(SYSTEM("internal"), id);
}

export async function cancelVisit(
  actor: Actor,
  id: string,
  reason?: string,
  opts: { notifyCustomer?: boolean; source?: "crm" | "google" } = {},
) {
  if (opts.source !== "google" && !isOwner(actor)) throw new ForbiddenError("Only the owner cancels visits");
  const v = await db.visit.findUnique({ where: { id }, include: { lead: { include: { customer: true, property: true, assignedTo: { select: { name: true } } } } } });
  if (!v) throw new NotFoundError("Visit not found");
  if (v.status === "cancelled") return;
  await db.$transaction(async (tx) => {
    await tx.visit.update({
      where: { id },
      // A visit deleted in Google has no event left to remove.
      data: { status: "cancelled", syncState: opts.source === "google" ? "synced" : "pending", googleEventId: opts.source === "google" ? null : undefined },
    });
    await recordActivity(tx, actor, { type: "visit_cancelled", leadId: v.leadId, body: reason ? `Visit cancelled: ${reason}` : "Visit cancelled", data: { visitId: id } });
    const embed = leadStageEmbed(v.lead);
    embed.embeds![0]!.title = `Cancelled: ${v.lead.title} (${when(v.start)})${reason ? ` — ${reason}` : ""}`;
    await enqueueDiscord(tx, embed);
  });
  await stopEnrollments({ visitId: id }, "visit cancelled");
  await flushOutboxSoon();
  if (opts.notifyCustomer) {
    const first = v.lead.customer.name.split(/\s+/)[0];
    await sendCustomerText(actor, {
      customerId: v.lead.customerId,
      leadId: v.leadId,
      body: `Hi ${first}, your Degree of Comfort appointment on ${when(v.start)} has been cancelled. We'll reach out shortly to find a new time.`,
    });
  }
  if (opts.source !== "google") await syncVisitSoon(id);
}

// ---- Tech status buttons -----------------------------------------------------------

export async function updateVisitStatus(actor: Actor, id: string, status: VisitStatus, opts: { notifyCustomer?: boolean } = {}) {
  const v = await getVisit(actor, id);
  if (!["en_route", "in_progress", "done"].includes(status)) throw new ValidationError("Unknown status");
  if (["done", "cancelled"].includes(v.status)) throw new ValidationError("That visit is already closed");
  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.visit.update({
      where: { id },
      data: {
        status,
        enRouteAt: status === "en_route" ? now : undefined,
        startedAt: status === "in_progress" ? (v.startedAt ?? now) : undefined,
        completedAt: status === "done" ? now : undefined,
      },
    });
    await recordActivity(tx, actor, {
      type: "visit_status",
      leadId: v.leadId,
      body: { en_route: "On the way", in_progress: "Started work", done: "Finished the visit" }[status as "en_route"],
      data: { visitId: id, status },
    });
  });

  if (status === "en_route" && opts.notifyCustomer) {
    const first = v.lead.customer.name.split(/\s+/)[0];
    await sendCustomerText(actor, {
      customerId: v.lead.customerId,
      leadId: v.leadId,
      body: `Hi ${first}, ${v.tech.name.split(/\s+/)[0]} from Degree of Comfort is on the way and should arrive shortly.`,
    });
  }
  if (status === "in_progress" && v.kind === "job") {
    if (v.jobId) await db.job.update({ where: { id: v.jobId }, data: { status: "in_progress" } });
    if (before(v.lead.stage, "job_in_progress")) await changeStage(actor, v.leadId, "job_in_progress");
  }
  if (status === "done") {
    await stopEnrollments({ visitId: id }, "visit done");
    if (v.kind === "job" && v.jobId) {
      const open = await db.visit.count({ where: { jobId: v.jobId, id: { not: id }, status: { in: ["scheduled", "en_route", "in_progress"] } } });
      if (open === 0) {
        const { completeJob } = await import("./jobs");
        await completeJob(actor, v.jobId);
      }
    }
  }
  return getVisit(actor, id);
}

// ---- Google Calendar: outbound ------------------------------------------------------

async function syncVisitSoon(visitId: string) {
  const run = () => syncVisit(visitId).catch((e) => console.error("[gcal sync]", e));
  try {
    const { after } = await import("next/server");
    after(run);
  } catch {
    await run();
  }
}

/** Pushes one visit to its tech's calendar (create / move / delete). */
export async function syncVisit(visitId: string) {
  const v = await db.visit.findUnique({ where: { id: visitId }, include: visitInclude });
  if (!v) return;
  const cal = getCalendarClient();
  try {
    // Moved to another tech: remove it from the previous tech's calendar.
    if (v.googleEventId && v.googleEventOwnerId && v.googleEventOwnerId !== v.techId) {
      const prev = await db.user.findUnique({ where: { id: v.googleEventOwnerId } });
      if (prev?.googleRefreshToken) await cal.deleteEvent(decrypt(prev.googleRefreshToken), v.googleEventId);
      await db.visit.update({ where: { id: v.id }, data: { googleEventId: null, googleEventOwnerId: null } });
      v.googleEventId = null;
    }
    if (!v.tech.googleRefreshToken) {
      await db.visit.update({ where: { id: v.id }, data: { syncState: "skipped", syncError: "Tech hasn't connected Google Calendar" } });
      return;
    }
    const token = decrypt(v.tech.googleRefreshToken);
    if (v.status === "cancelled") {
      if (v.googleEventId) await cal.deleteEvent(token, v.googleEventId);
      await db.visit.update({ where: { id: v.id }, data: { syncState: "synced", syncError: null } });
      return;
    }
    const address = formatAddress(v.lead.property);
    const eventId = await cal.upsertEvent(token, {
      eventId: v.googleEventId,
      visitId: v.id,
      summary: `DoC – ${tradeLabel(v.lead.trade)} – ${v.lead.customer.name}${v.kind === "estimate" ? " (estimate)" : ""}`,
      location: address,
      description: [
        v.job?.title ?? v.lead.title,
        v.lead.customer.phone ? `Customer: ${formatPhone(v.lead.customer.phone)}` : null,
        v.lead.property?.notes ? `Access: ${v.lead.property.notes}` : null,
        v.notes,
        `${appUrl()}/leads/${v.leadId}`,
      ]
        .filter(Boolean)
        .join("\n"),
      start: v.start,
      end: v.end,
    });
    await db.visit.update({ where: { id: v.id }, data: { googleEventId: eventId, googleEventOwnerId: v.techId, syncState: "synced", syncError: null } });
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 300) : String(err);
    await db.visit.update({ where: { id: v.id }, data: { syncState: "error", syncError: msg } });
    if (err instanceof CalendarError && err.status === 401) {
      // Token revoked: ask the tech to reconnect.
      await db.user.update({ where: { id: v.techId }, data: { googleRefreshToken: null, googleCalendarConnectedAt: null } });
    }
  }
}

/** Scheduler: retry anything not yet synced. */
export async function syncPendingVisits(limit = 25) {
  const pending = await db.visit.findMany({
    where: { syncState: { in: ["pending", "error"] }, updatedAt: { lt: new Date(Date.now() - 30_000) } },
    select: { id: true },
    take: limit,
  });
  for (const { id } of pending) await syncVisit(id);
  return pending.length;
}

// ---- Google Calendar: inbound (V1 polling, every 5 minutes) ---------------------------------

export async function pollCalendars(now = new Date()) {
  const users = await db.user.findMany({
    where: {
      googleRefreshToken: { not: null },
      OR: [{ googleCalendarPolledAt: null }, { googleCalendarPolledAt: { lt: new Date(now.getTime() - 5 * 60_000) } }],
    },
  });
  const cal = getCalendarClient();
  let changed = 0;
  for (const u of users) {
    const since = u.googleCalendarPolledAt ?? new Date(now.getTime() - 86_400_000);
    try {
      const events = await cal.listChanged(decrypt(u.googleRefreshToken!), new Date(since.getTime() - 60_000));
      for (const e of events) {
        const v = await db.visit.findFirst({ where: { id: e.visitId!, googleEventId: e.id, techId: u.id } });
        if (!v || ["done", "cancelled"].includes(v.status)) continue;
        if (e.status === "cancelled") {
          // Deleted in Google by the tech: cancel the visit and let the customer know.
          const actor = { kind: "user" as const, id: u.id, role: u.role, name: u.name, email: u.email };
          await cancelVisit(actor, v.id, `deleted from ${u.name}'s Google Calendar`, { notifyCustomer: true, source: "google" });
          changed++;
          continue;
        }
        if (e.start && e.end && (e.start.getTime() !== v.start.getTime() || e.end.getTime() !== v.end.getTime())) {
          await rescheduleVisit({ kind: "user", id: u.id, role: u.role, name: u.name, email: u.email }, v.id, { start: e.start, end: e.end }, { source: "google" });
          changed++;
        }
      }
      await db.user.update({ where: { id: u.id }, data: { googleCalendarPolledAt: now } });
    } catch (err) {
      console.error("[gcal poll]", u.email, err);
      if (err instanceof CalendarError && err.status === 401) {
        await db.user.update({ where: { id: u.id }, data: { googleRefreshToken: null, googleCalendarConnectedAt: null } });
      }
    }
  }
  if (changed) await flushOutboxSoon();
  return changed;
}

/** The tech's other appointments (grey blocks on the dispatch board). */
export async function busyBlocks(techIds: string[], from: Date, to: Date) {
  const users = await db.user.findMany({ where: { id: { in: techIds }, googleRefreshToken: { not: null } } });
  const cal = getCalendarClient();
  const out: { techId: string; start: Date; end: Date; title: string }[] = [];
  await Promise.all(
    users.map(async (u) => {
      try {
        const events = await cal.listBetween(decrypt(u.googleRefreshToken!), from, to);
        for (const e of events) {
          if (e.visitId || e.transparent || e.allDay || !e.start || !e.end) continue; // our own visits are drawn separately
          out.push({ techId: u.id, start: e.start, end: e.end, title: "Busy" });
        }
      } catch (err) {
        console.error("[gcal busy]", u.email, err);
      }
    }),
  );
  return out;
}

// ---- Connect / disconnect ------------------------------------------------------------

function stateSig(userId: string, nonce: string) {
  return createHmac("sha256", process.env.AUTH_SECRET ?? "").update(`gcal:${userId}:${nonce}`).digest("base64url");
}

export function calendarConnectUrl(user: { id: string; email: string }) {
  const nonce = randomToken(12);
  const qs = new URLSearchParams({
    client_id: process.env.AUTH_GOOGLE_ID ?? "",
    redirect_uri: `${appUrl()}/api/google/callback`,
    response_type: "code",
    scope: `openid email ${CALENDAR_SCOPE}`,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    login_hint: user.email,
    state: `${user.id}.${nonce}.${stateSig(user.id, nonce)}`,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${qs}`;
}

export function calendarStateUser(state: string | null): string | null {
  const [userId, nonce, sig] = (state ?? "").split(".");
  if (!userId || !nonce || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(stateSig(userId, nonce));
  return a.length === b.length && timingSafeEqual(a, b) ? userId : null;
}

export async function completeCalendarConnect(userId: string, code: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      code,
      client_id: process.env.AUTH_GOOGLE_ID ?? "",
      client_secret: process.env.AUTH_GOOGLE_SECRET ?? "",
      redirect_uri: `${appUrl()}/api/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { refresh_token?: string; id_token?: string; scope?: string; error?: string };
  if (!res.ok || !data.refresh_token) throw new ValidationError(`Google didn't return calendar access (${data.error ?? res.status}). Try again.`);
  if (!data.scope?.includes(CALENDAR_SCOPE)) throw new ValidationError("Calendar access wasn't granted. Tick the calendar permission and try again.");
  let email: string | null = null;
  try {
    email = JSON.parse(Buffer.from(data.id_token!.split(".")[1]!, "base64url").toString()).email ?? null;
  } catch {
    /* optional */
  }
  await db.user.update({
    where: { id: userId },
    data: { googleRefreshToken: encrypt(data.refresh_token), googleCalendarEmail: email, googleCalendarConnectedAt: new Date(), googleCalendarPolledAt: new Date() },
  });
  // Push their upcoming visits.
  await db.visit.updateMany({ where: { techId: userId, start: { gt: new Date() }, status: { notIn: ["done", "cancelled"] } }, data: { syncState: "pending" } });
}

export async function disconnectCalendar(userId: string) {
  await db.user.update({ where: { id: userId }, data: { googleRefreshToken: null, googleCalendarConnectedAt: null, googleCalendarEmail: null } });
}

