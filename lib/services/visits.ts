// Visits (estimates and job days) and their Google Calendar events (SPEC.md "Scheduling").
// The CRM owns assignment and times; each visit is mirrored onto the assigned tech's own calendar.

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { decrypt, encrypt, randomToken } from "@/lib/crypto";
import { stageIndex, tradeLabel } from "@/lib/stages";
import { arrivalOf, arrivalPhrase } from "@/lib/booking";
import { formatPhone } from "@/lib/phone";
import { formatAddress, leadStageEmbed } from "@/lib/notifications/discord-embeds";
import { CALENDAR_SCOPE, CalendarError, getCalendarClient } from "@/lib/integrations/google-calendar";
import type { Prisma } from "@/generated/prisma/client";
import type { LeadStage, VisitStatus } from "@/generated/prisma/enums";
import { ForbiddenError, NotFoundError, SYSTEM, ValidationError, isOwner, type Actor } from "./actor";
import { recordActivity } from "./activity";
import { changeStage } from "./leads";
import { enqueueDiscord, flushOutboxSoon } from "./outbox";
import { alertOwner, sendCustomerText } from "./messages";
import { enroll, retimeVisitEnrollments, stopEnrollments } from "./sequences";

const before = (a: LeadStage, b: LeadStage) => stageIndex(a) < stageIndex(b);
/** Stages where a lead is still waiting for its first visit to be booked / assigned. */
const BOOKING_STAGES: LeadStage[] = ["new", "follow_up", "needs_tech", "needs_reschedule", "lost"];

const visitInclude = {
  lead: {
    include: {
      customer: true,
      property: true,
      // Latest live estimate (a draft can be presented on site, which finalizes it).
      proposals: { where: { status: { in: ["draft", "sent", "viewed", "signed"] } }, orderBy: { version: "desc" }, take: 1, select: { id: true, status: true } },
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
    /** Null/empty = book the time now, pick the tech later ("Needs tech"). */
    techId: z.string().nullish().transform((v) => v || null),
    start: z.coerce.date(),
    end: z.coerce.date(),
    /** Arrival window told to the customer; defaults to none (arrive at `start`). */
    arrivalStart: z.coerce.date().nullish(),
    arrivalEnd: z.coerce.date().nullish(),
    notes: z.string().trim().max(2000).optional(),
  })
  .refine((v) => v.end > v.start, { message: "The end time must be after the start", path: ["end"] })
  .refine((v) => !v.arrivalStart || !v.arrivalEnd || v.arrivalEnd > v.arrivalStart, { message: "The arrival window must end after it starts", path: ["arrivalEnd"] });

const DAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });

/** What the customer is told about a visit: "Tue, Oct 14" + "between 9 am and 12 pm". */
export function visitWording(v: { start: Date; end: Date; arrivalStart?: Date | null; arrivalEnd?: Date | null }) {
  const a = arrivalOf(v);
  return { day: DAY.format(a.start), window: arrivalPhrase(a) };
}

const firstName = (name: string) => name.split(/\s+/)[0] ?? name;
const visitNoun = (v: { kind: string; job?: { title: string } | null }) => (v.kind === "job" && v.job ? `your ${v.job.title.split(" — ")[0]!.toLowerCase()}` : "your service call");

export async function scheduleVisit(actor: Actor, raw: z.input<typeof scheduleInput>) {
  if (!isOwner(actor)) throw new ForbiddenError("Only the owner schedules visits");
  const input = scheduleInput.parse(raw);
  const lead = await db.lead.findUnique({ where: { id: input.leadId } });
  if (!lead) throw new NotFoundError("Lead not found");
  const tech = input.techId ? await db.user.findFirst({ where: { id: input.techId, active: true } }) : null;
  if (input.techId && !tech) throw new ValidationError("Choose a tech");
  let job = null;
  if (input.kind === "job") {
    job = input.jobId ? await db.job.findFirst({ where: { id: input.jobId, leadId: lead.id } }) : await db.job.findFirst({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" } });
    if (!job) throw new ValidationError("A job visit needs a job (the deposit creates it)");
  }
  const wasRescheduling = lead.stage === "needs_reschedule";

  const visit = await db.$transaction(async (tx) => {
    const v = await tx.visit.create({
      data: {
        leadId: lead.id,
        jobId: job?.id ?? null,
        kind: input.kind,
        techId: tech?.id ?? null,
        start: input.start,
        end: input.end,
        arrivalStart: input.arrivalStart ?? null,
        arrivalEnd: input.arrivalEnd ?? null,
        notes: input.notes,
        syncState: tech ? "pending" : "skipped",
      },
    });
    if (job) {
      await tx.job.update({
        where: { id: job.id },
        data: { status: job.status === "unscheduled" ? "scheduled" : undefined, assignedToId: job.assignedToId ?? tech?.id ?? null },
      });
    }
    if (tech && !lead.assignedToId) await tx.lead.update({ where: { id: lead.id }, data: { assignedToId: tech.id } });
    if (input.kind === "estimate") {
      // However it's booked (confirm button, dispatch drag, slot finder), a pending request is now handled.
      await tx.bookingRequest.updateMany({ where: { leadId: lead.id, status: "pending" }, data: { status: "confirmed", visitId: v.id } });
    }
    await recordActivity(tx, actor, {
      type: "visit_scheduled",
      leadId: lead.id,
      body: `${input.kind === "estimate" ? "Service call" : "Job visit"} ${tech ? `with ${tech.name}` : "booked (no tech yet)"} on ${when(input.start)}`,
      data: { visitId: v.id },
    });
    return v;
  });

  if (input.kind === "estimate" && BOOKING_STAGES.includes(lead.stage)) {
    await changeStage(actor, lead.id, tech ? "estimate_scheduled" : "needs_tech");
  }
  if (input.kind === "job" && before(lead.stage, "job_scheduled")) {
    await changeStage(actor, lead.id, "job_scheduled");
  }
  if (tech) await confirmToCustomer(actor, visit.id, wasRescheduling ? "moved" : "confirmed");
  if (tech) await syncVisitSoon(visit.id);
  return getVisit(actor, visit.id);
}

/**
 * Tells the customer about a booked visit. "confirmed" runs the appointment sequence (confirmation +
 * reminder); "moved" / "tech_changed" send a one-off text and keep (or start) only the reminders.
 */
async function confirmToCustomer(actor: Actor, visitId: string, what: "confirmed" | "moved" | "tech_changed", previousTech?: string) {
  const v = await db.visit.findUnique({ where: { id: visitId }, include: { tech: true, job: true, lead: { include: { customer: true } } } });
  if (!v?.tech) return;
  const trigger = v.kind === "estimate" ? "estimate_visit" : "job_visit";
  if (what === "confirmed") {
    await enroll(trigger, v.leadId, { visitId });
    return;
  }
  const { day, window } = visitWording(v);
  const first = firstName(v.lead.customer.name);
  const body =
    what === "moved"
      ? `Hi ${first}, this is Degree of Comfort. ${visitNoun(v)[0]!.toUpperCase()}${visitNoun(v).slice(1)} has been moved to ${day}. ${v.tech.name} will arrive ${window}. Reply here with any questions.`
      : `Hi ${first}, this is Degree of Comfort. Change of technician: ${v.tech.name} will come${previousTech ? ` instead of ${previousTech}` : ""}, same time (${day}, ${window}). Reply here with any questions.`;
  await sendCustomerText(actor, { customerId: v.lead.customerId, leadId: v.leadId, body });
  // Keep the reminder, without a second "you're confirmed".
  await enroll(trigger, v.leadId, { visitId, skipImmediate: true });
  await retimeVisitEnrollments(visitId);
}

const TIME = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const when = (d: Date) => TIME.format(d);

/**
 * Move a visit and/or change its tech. Assigning a tech to an unassigned visit sends the confirmation;
 * otherwise the customer gets a "moved" or "change of technician" text unless `notifyCustomer` is false.
 */
export async function rescheduleVisit(
  actor: Actor,
  id: string,
  input: { start: Date; end: Date; techId?: string; arrivalStart?: Date | null; arrivalEnd?: Date | null },
  opts: { source?: "crm" | "google"; notifyCustomer?: boolean } = {},
) {
  if (opts.source !== "google" && !isOwner(actor)) throw new ForbiddenError("Only the owner reschedules visits");
  if (!(input.end > input.start)) throw new ValidationError("The end time must be after the start");
  const v = await db.visit.findUnique({ where: { id }, include: { tech: true, lead: { include: { customer: true, property: true, assignedTo: { select: { name: true } } } } } });
  if (!v) throw new NotFoundError("Visit not found");
  if (["done", "cancelled"].includes(v.status)) throw new ValidationError("That visit is already closed");
  const tech = input.techId && input.techId !== v.techId ? await db.user.findFirst({ where: { id: input.techId, active: true } }) : v.tech;
  if (input.techId && !tech) throw new ValidationError("Choose a tech");
  const moved = v.start.getTime() !== input.start.getTime() || v.end.getTime() !== input.end.getTime();
  const techChanged = (tech?.id ?? null) !== v.techId;
  if (!moved && !techChanged && input.arrivalStart === undefined) return getVisit(SYSTEM("internal"), id);

  // The promised window: as given, or shifted along with the visit.
  const shift = input.start.getTime() - v.start.getTime();
  const arrivalStart = input.arrivalStart !== undefined ? input.arrivalStart : v.arrivalStart ? new Date(v.arrivalStart.getTime() + shift) : null;
  const arrivalEnd = input.arrivalEnd !== undefined ? input.arrivalEnd : v.arrivalEnd ? new Date(v.arrivalEnd.getTime() + shift) : null;
  const windowChanged = (arrivalStart?.getTime() ?? null) !== (v.arrivalStart?.getTime() ?? null);

  await db.$transaction(async (tx) => {
    await tx.visit.update({
      where: { id },
      data: {
        start: input.start,
        end: input.end,
        arrivalStart,
        arrivalEnd,
        lateEta: moved ? null : undefined,
        techId: tech?.id ?? null,
        syncState: opts.source === "google" ? v.syncState : "pending",
      },
    });
    if (tech && !v.lead.assignedToId) await tx.lead.update({ where: { id: v.leadId }, data: { assignedToId: tech.id } });
    await recordActivity(tx, actor, {
      type: "visit_rescheduled",
      leadId: v.leadId,
      body: !v.techId && tech
        ? `${tech.name} assigned to the visit on ${when(input.start)}`
        : `Visit ${moved ? `moved to ${when(input.start)}` : "updated"}${techChanged && tech ? ` with ${tech.name}` : ""}${opts.source === "google" ? " (changed in Google Calendar)" : ""}`,
      data: { visitId: id, from: v.start.toISOString(), to: input.start.toISOString() },
    });
    const embed = leadStageEmbed({ ...v.lead, assignedTo: tech ? { name: tech.name } : v.lead.assignedTo });
    embed.embeds![0]!.title = !v.techId && tech ? `Tech assigned: ${v.lead.title} → ${tech.name}` : `Rescheduled: ${v.lead.title} → ${when(input.start)}`;
    await enqueueDiscord(tx, embed);
  });
  await flushOutboxSoon();
  await retimeVisitEnrollments(id);

  if (!v.techId && tech) {
    // First tech on a "Needs tech" visit: now the customer hears about it.
    if (v.kind === "estimate" && v.lead.stage === "needs_tech") await changeStage(actor, v.leadId, "estimate_scheduled");
    await confirmToCustomer(actor, id, "confirmed");
  } else if (tech && opts.source !== "google" && opts.notifyCustomer !== false) {
    if (moved || windowChanged) await confirmToCustomer(actor, id, "moved");
    else if (techChanged) await confirmToCustomer(actor, id, "tech_changed", v.tech?.name);
  }
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
    const first = firstName(v.lead.customer.name);
    await sendCustomerText(actor, {
      customerId: v.lead.customerId,
      leadId: v.leadId,
      body: `Hi ${first}, your Degree of Comfort appointment on ${when(v.start)} has been cancelled. We'll reach out shortly to find a new time.`,
    });
  }
  if (opts.source !== "google") await syncVisitSoon(id);
}

// ---- Day-of: running late, can't make it ------------------------------------------------

export const LATE_OPTIONS = [30, 60, 120] as const;

/** Tech is held up: tell the customer the new approximate arrival time and move the calendar block. */
export async function runningLate(actor: Actor, id: string, minutes: number, now = new Date()) {
  if (!LATE_OPTIONS.includes(minutes as never)) throw new ValidationError("Pick how late");
  const v = await getVisit(actor, id);
  if (!["scheduled", "en_route"].includes(v.status)) throw new ValidationError("This visit isn't upcoming");
  if (!v.tech) throw new ValidationError("Assign a tech first");
  // Rounded up to the next 5 minutes so the text reads naturally.
  const eta = new Date(Math.ceil((now.getTime() + minutes * 60_000) / 300_000) * 300_000);
  const length = v.end.getTime() - v.start.getTime();
  await db.$transaction(async (tx) => {
    await tx.visit.update({
      where: { id },
      data: { lateEta: eta, ...(eta > v.start ? { start: eta, end: new Date(eta.getTime() + length), syncState: "pending" } : {}) },
    });
    await recordActivity(tx, actor, { type: "visit_late", leadId: v.leadId, body: `Running late: new arrival about ${clockEt(eta)}`, data: { visitId: id } });
  });
  await sendCustomerText(actor, {
    customerId: v.lead.customerId,
    leadId: v.leadId,
    body: `Hi ${firstName(v.lead.customer.name)}, ${firstName(v.tech.name)} from Degree of Comfort is running behind at a previous call. New arrival time is about ${clockEt(eta)}. Sorry for the wait!`,
  });
  await syncVisitSoon(id);
  return getVisit(actor, id);
}

const CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const clockEt = (d: Date) => CLOCK.format(d).replace(" AM", " am").replace(" PM", " pm");

export const RESCHEDULE_REASONS = {
  tech_delayed: { label: "Tech held up at a previous call", phrase: "our technician is held up at a previous call" },
  tech_unavailable: { label: "Tech unavailable", phrase: "our technician is unavailable" },
  customer_request: { label: "Customer asked to reschedule", phrase: "" },
  other: { label: "Other", phrase: "" },
} as const;
export type RescheduleReason = keyof typeof RESCHEDULE_REASONS;

/**
 * The visit can't happen as booked: cancel it, tell the customer we'll call (unless they asked for the
 * change), alert the owner, and put the lead in "Needs reschedule".
 */
export async function needsReschedule(actor: Actor, id: string, input: { reason: RescheduleReason; note?: string; notifyCustomer?: boolean }) {
  const v = await getVisit(actor, id);
  if (!["scheduled", "en_route"].includes(v.status)) throw new ValidationError("This visit isn't upcoming");
  const reason = RESCHEDULE_REASONS[input.reason];
  if (!reason) throw new ValidationError("Pick a reason");
  const note = input.note?.trim().slice(0, 300);
  await db.$transaction(async (tx) => {
    await tx.visit.update({ where: { id }, data: { status: "cancelled", syncState: "pending" } });
    await recordActivity(tx, actor, {
      type: "visit_needs_reschedule",
      leadId: v.leadId,
      body: `Needs reschedule: ${reason.label}${note ? ` — ${note}` : ""} (was ${when(v.start)})`,
      data: { visitId: id, reason: input.reason },
    });
  });
  await stopEnrollments({ visitId: id }, "needs reschedule");
  if (v.kind === "estimate") await changeStage(actor, v.leadId, "needs_reschedule");
  else {
    await db.$transaction(async (tx) => {
      const embed = leadStageEmbed({ ...v.lead, assignedTo: v.tech ? { name: v.tech.name } : null });
      embed.embeds![0]!.title = `Job visit needs rescheduling: ${v.lead.title} (${when(v.start)}) — ${reason.label}`;
      await enqueueDiscord(tx, embed);
    });
    await flushOutboxSoon();
  }
  if (actor.kind === "user" && !isOwner(actor)) {
    await alertOwner(`${actor.name} can't make ${v.lead.customer.name} (${when(v.start)}): ${reason.label}${note ? ` — ${note}` : ""}. Reschedule: ${appUrl()}/leads/${v.leadId}`);
  }
  const notify = input.notifyCustomer ?? input.reason !== "customer_request";
  if (notify) {
    const { day } = visitWording(v);
    await sendCustomerText(actor, {
      customerId: v.lead.customerId,
      leadId: v.leadId,
      body: `Hi ${firstName(v.lead.customer.name)}, this is Degree of Comfort. We're sorry${reason.phrase ? `, ${reason.phrase}` : ""}, so we need to reschedule ${visitNoun(v)} on ${day}. We'll call you shortly to find a new time.`,
    });
  }
  await syncVisitSoon(id);
}

// ---- Tech status buttons -----------------------------------------------------------

export async function updateVisitStatus(actor: Actor, id: string, status: VisitStatus, opts: { notifyCustomer?: boolean } = {}) {
  const v = await getVisit(actor, id);
  if (!["en_route", "in_progress", "done"].includes(status)) throw new ValidationError("Unknown status");
  if (["done", "cancelled"].includes(v.status)) throw new ValidationError("That visit is already closed");
  if (!v.tech && status !== "done") throw new ValidationError("Assign a tech first");
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
      body: { en_route: "On the way", in_progress: v.kind === "estimate" ? "Arrived on site" : "Started work", done: "Finished the visit" }[status as "en_route"],
      data: { visitId: id, status },
    });
  });

  if (status === "en_route" && opts.notifyCustomer) {
    await sendCustomerText(actor, {
      customerId: v.lead.customerId,
      leadId: v.leadId,
      body: `Hi ${firstName(v.lead.customer.name)}, ${firstName(v.tech!.name)} from Degree of Comfort is on the way and should arrive shortly.`,
    });
  }
  // First visit: the card follows the tech (On the way → On site).
  if (v.kind === "estimate") {
    const target: LeadStage | null = status === "en_route" ? "on_the_way" : status === "in_progress" ? "on_site" : null;
    if (target && v.lead.stage !== "lost" && before(v.lead.stage, target)) await changeStage(actor, v.leadId, target);
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

// ---- On site: how the first visit ends ------------------------------------------------------

export type WrapUp =
  | { outcome: "work_now" }
  | { outcome: "return_visit" }
  | { outcome: "declined"; reason: string; fee: "none" | "collect" | "invoice"; feeCents?: number; method?: "cash" | "check" | "card" }
  | { outcome: "estimate_later" };

/**
 * The tech finishes the first visit:
 * - work_now: signed estimate → create the job (no deposit), start a job visit now → In progress
 * - return_visit: signed → owner schedules the work (deposit rules apply) → stays Approved
 * - declined: reason (+ optional service call fee) → Declined, gentle follow-up texts
 * - estimate_later: no estimate yet; the owner sends it later
 */
export async function wrapUpVisit(actor: Actor, id: string, input: WrapUp, now = new Date()) {
  const v = await getVisit(actor, id);
  if (v.kind !== "estimate") throw new ValidationError("Only the first (estimate) visit has an outcome");
  if (v.status === "cancelled") throw new ValidationError("That visit was cancelled");
  const signed = await db.proposal.findFirst({ where: { leadId: v.leadId, status: "signed" }, orderBy: { version: "desc" } });

  if (input.outcome === "work_now" || input.outcome === "return_visit") {
    if (!signed) throw new ValidationError("The customer needs to sign the estimate first (Present to customer).");
  }
  if (input.outcome === "declined" && !input.reason?.trim()) throw new ValidationError("Add a short reason");

  if (v.status !== "done") {
    await db.visit.update({ where: { id }, data: { status: "done", completedAt: now, startedAt: v.startedAt ?? now, outcome: input.outcome } });
    await stopEnrollments({ visitId: id }, "visit done");
  } else {
    await db.visit.update({ where: { id }, data: { outcome: input.outcome } });
  }

  if (input.outcome === "work_now") {
    const { createJobWithoutDeposit } = await import("./payments");
    const job = await createJobWithoutDeposit(actor, signed!.id, v.techId);
    const jobVisit = await db.$transaction(async (tx) => {
      const jv = await tx.visit.create({
        data: {
          leadId: v.leadId,
          jobId: job.id,
          kind: "job",
          techId: v.techId,
          start: now,
          end: new Date(now.getTime() + Math.max(1, job.durationHours) * 3_600_000),
          status: "in_progress",
          startedAt: now,
          syncState: v.techId ? "pending" : "skipped",
        },
      });
      await tx.job.update({ where: { id: job.id }, data: { status: "in_progress" } });
      await recordActivity(tx, actor, { type: "visit_status", leadId: v.leadId, body: "Started the work right away", data: { visitId: jv.id } });
      return jv;
    });
    await changeStage(actor, v.leadId, "job_in_progress");
    await syncVisitSoon(jobVisit.id);
    return { jobId: job.id, jobVisitId: jobVisit.id };
  }

  if (input.outcome === "return_visit") {
    await db.$transaction((tx) =>
      recordActivity(tx, actor, { type: "visit_outcome", leadId: v.leadId, body: "Signed; work to be scheduled as a return visit", data: { visitId: id } }),
    );
    await alertOwner(`${v.lead.customer.name} signed and needs a return visit scheduled (${v.lead.title}). ${appUrl()}/leads/${v.leadId}`);
    return {};
  }

  if (input.outcome === "declined") {
    await db.$transaction(async (tx) => {
      await tx.lead.update({ where: { id: v.leadId }, data: { lostReason: input.reason.trim().slice(0, 300) } });
      await recordActivity(tx, actor, { type: "estimate_declined", leadId: v.leadId, body: `Estimate declined: ${input.reason.trim().slice(0, 300)}`, data: { visitId: id } });
    });
    await changeStage(actor, v.leadId, "estimate_declined");
    if (input.fee === "none") {
      await db.visit.update({ where: { id }, data: { feeStatus: "waived" } });
    } else {
      const { settleServiceFee } = await import("./payments");
      const { getCompany } = await import("./company");
      const amount = input.feeCents ?? (await getCompany()).serviceCallFeeCents;
      await settleServiceFee(actor, id, { mode: input.fee, amountCents: amount, method: input.method });
    }
    return {};
  }

  await db.$transaction((tx) =>
    recordActivity(tx, actor, { type: "visit_outcome", leadId: v.leadId, body: "Visit done; estimate to follow", data: { visitId: id } }),
  );
  return {};
}

// ---- Customer not home ----------------------------------------------------------------

export type NoShow = { fee: "none" | "collect" | "invoice"; feeCents?: number; method?: "cash" | "check" | "card"; notifyCustomer?: boolean };

/**
 * The tech got there and nobody answered: close the visit as a no-show, settle the trip fee the tech picked,
 * text the customer we'll call to rebook, and put the lead back in "Needs reschedule" for the office.
 */
export async function customerNotHome(actor: Actor, id: string, input: NoShow, now = new Date()) {
  const v = await getVisit(actor, id);
  if (!["en_route", "in_progress"].includes(v.status)) throw new ValidationError("Tap “On my way” first");
  await db.$transaction(async (tx) => {
    await tx.visit.update({
      where: { id },
      data: { status: "done", outcome: "no_show", completedAt: now, startedAt: v.startedAt ?? now, feeStatus: input.fee === "none" ? "waived" : undefined },
    });
    await recordActivity(tx, actor, { type: "visit_no_show", leadId: v.leadId, body: `Customer not home at ${clockEt(now)}`, data: { visitId: id, fee: input.fee } });
  });
  await stopEnrollments({ visitId: id }, "no show");

  if (input.fee !== "none") {
    const { settleServiceFee } = await import("./payments");
    const { getCompany } = await import("./company");
    const amount = input.feeCents ?? (await getCompany()).serviceCallFeeCents;
    await settleServiceFee(actor, id, { mode: input.fee, amountCents: amount, method: input.method });
  }

  if (v.kind === "estimate") await changeStage(actor, v.leadId, "needs_reschedule");
  else {
    await db.$transaction(async (tx) => {
      const embed = leadStageEmbed({ ...v.lead, assignedTo: v.tech ? { name: v.tech.name } : null });
      embed.embeds![0]!.title = `Customer not home — job visit needs rescheduling: ${v.lead.title} (${when(v.start)})`;
      await enqueueDiscord(tx, embed);
    });
    await flushOutboxSoon();
  }
  const fee = input.fee === "none" ? "no trip fee" : input.fee === "collect" ? "trip fee collected" : "trip fee invoiced";
  await alertOwner(`${v.lead.customer.name} wasn't home for ${v.tech ? firstName(v.tech.name) : "the tech"} (${when(v.start)}, ${fee}). Reschedule: ${appUrl()}/leads/${v.leadId}`);
  if (input.notifyCustomer ?? true) {
    await sendCustomerText(actor, {
      customerId: v.lead.customerId,
      leadId: v.leadId,
      body: `Hi ${firstName(v.lead.customer.name)}, ${v.tech ? firstName(v.tech.name) : "your technician"} from Degree of Comfort stopped by at ${clockEt(now)} but couldn't reach anyone. We'll call you to find a new time.`,
    });
  }
  return {};
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
    if (!v.tech) {
      await db.visit.update({ where: { id: v.id }, data: { syncState: "skipped", syncError: "No tech assigned yet" } });
      return;
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
      summary: `DoC – ${tradeLabel(v.lead.trade)} – ${v.lead.customer.name}${v.kind === "estimate" ? " (service call)" : ""}`,
      location: address,
      description: [
        v.job?.title ?? v.lead.title,
        v.lead.customer.phone ? `Customer: ${formatPhone(v.lead.customer.phone)}` : null,
        v.arrivalStart && v.arrivalEnd ? `Arrival window told to the customer: ${arrivalPhrase(arrivalOf(v))}` : null,
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
      await db.user.update({ where: { id: v.techId! }, data: { googleRefreshToken: null, googleCalendarConnectedAt: null } });
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


// ---- Pipeline card badges -----------------------------------------------------------------

/** Per lead: the next open visit (time, tech or "no tech", late) and the service call fee, for pipeline cards. */
export async function boardVisitInfo(leadIds: string[]) {
  const [open, fees] = await Promise.all([
    db.visit.findMany({
      where: { leadId: { in: leadIds }, status: { in: ["scheduled", "en_route", "in_progress"] } },
      orderBy: { start: "asc" },
      select: { leadId: true, start: true, end: true, arrivalStart: true, arrivalEnd: true, techId: true, lateEta: true, kind: true },
    }),
    db.visit.findMany({
      where: { leadId: { in: leadIds }, feeStatus: { in: ["collected", "invoiced", "paid"] } },
      orderBy: { updatedAt: "desc" },
      select: { leadId: true, feeStatus: true, feeCents: true },
    }),
  ]);
  const out = new Map<string, { visit: (typeof open)[number] | null; fee: (typeof fees)[number] | null }>();
  for (const v of open) if (!out.get(v.leadId)?.visit) out.set(v.leadId, { visit: v, fee: out.get(v.leadId)?.fee ?? null });
  for (const f of fees) if (!out.get(f.leadId)?.fee) out.set(f.leadId, { visit: out.get(f.leadId)?.visit ?? null, fee: f });
  return out;
}
