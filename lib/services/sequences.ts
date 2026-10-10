// Drip / reminder sequences (SPEC.md "SMS follow-ups via Quo").
// Enrollment.nextSendAt drives everything; the scheduler sends what's due within quiet hours.

import { db } from "@/lib/db";
import { formatPhone } from "@/lib/phone";
import type { Prisma } from "@/generated/prisma/client";
import { SYSTEM, ValidationError, isOwner, ForbiddenError, type Actor } from "./actor";
import { getCompany } from "./company";
import { hasReceivedAutomatedText, sendCustomerText } from "./messages";
import { proposalLink } from "./proposals";

export const TRIGGERS = [
  { id: "follow_up", label: "Lead moves to Follow up" },
  { id: "estimate_sent", label: "Proposal sent" },
  { id: "estimate_visit", label: "Estimate visit booked" },
  { id: "job_visit", label: "Job visit booked" },
  { id: "maintenance", label: "HVAC job paid (maintenance)" },
] as const;

const STAGE_TRIGGERS = ["follow_up", "estimate_sent"];
const MAX_FAILURES = 3;
const TZ = "America/New_York";

type StepSeed = { anchor?: string; offsetHours: number; template: string };
export const DEFAULT_SEQUENCES: { key: string; name: string; trigger: string; steps: StepSeed[] }[] = [
  {
    key: "book_estimate",
    name: "Book an estimate",
    trigger: "follow_up",
    steps: [
      { offsetHours: 0, template: "Hi {firstName}, it's {companyName} following up on your request ({jobTitle}). When's a good time for us to come take a look? Reply here or call {companyPhone}." },
      { offsetHours: 48, template: "Hi {firstName}, just checking in. We'd be glad to stop by for your {jobTitle}. Reply with a day that works and we'll get you on the schedule." },
    ],
  },
  {
    key: "proposal_followup",
    name: "Proposal follow-up",
    trigger: "estimate_sent",
    steps: [
      { offsetHours: 24, template: "Hi {firstName}, did the proposal link come through? Here it is again: {proposalLink}" },
      { offsetHours: 72, template: "Hi {firstName}, any questions on the options? Happy to help you pick: {proposalLink}" },
      { offsetHours: 168, template: "Hi {firstName}, happy to walk through your proposal by phone. Call or text us at {companyPhone}." },
      { offsetHours: 336, template: "Hi {firstName}, a reminder that your pricing holds until {expiry}: {proposalLink}" },
      { offsetHours: 720, template: "Hi {firstName}, we're still here when you're ready. Just reply to this text." },
    ],
  },
  {
    key: "estimate_visit",
    name: "Estimate booked",
    trigger: "estimate_visit",
    steps: [
      { anchor: "enrolled", offsetHours: 0, template: "Hi {firstName}, you're booked with {companyName} on {visitTime} for your estimate. {techName} will text when on the way." },
      { anchor: "visit_start", offsetHours: -24, template: "Reminder: {techName} from {companyName} is coming {visitTime}. Reply here if you need to reschedule." },
    ],
  },
  {
    key: "job_visit",
    name: "Job scheduled",
    trigger: "job_visit",
    steps: [
      { anchor: "enrolled", offsetHours: 0, template: "Hi {firstName}, your {jobTitle} is scheduled for {visitTime}. Thank you for choosing {companyName}!" },
      { anchor: "visit_start", offsetHours: -48, template: "Reminder: we'll see you {visitTime} for your {jobTitle}. Reply here with any questions." },
    ],
  },
  {
    key: "maintenance",
    name: "Maintenance",
    trigger: "maintenance",
    steps: [
      { offsetHours: 24 * 182, template: "Hi {firstName}, it's been about 6 months since your HVAC work. Time for a tune-up? Reply to book or call {companyPhone}." },
      { offsetHours: 24 * 365, template: "Hi {firstName}, your yearly HVAC tune-up is due. Reply here and we'll find a time." },
      { offsetHours: 24 * 365, template: "Hi {firstName}, yearly tune-up time again! Reply to book." },
    ],
  },
];

/** Creates the default sequences the first time (later edits in Settings are kept). */
export async function ensureDefaultSequences() {
  for (const s of DEFAULT_SEQUENCES) {
    const existing = await db.sequence.findUnique({ where: { key: s.key } });
    if (existing) continue;
    await db.sequence.create({
      data: {
        key: s.key,
        name: s.name,
        trigger: s.trigger,
        steps: {
          create: s.steps.map((st, i) => ({ sortOrder: i, anchor: st.anchor ?? "enrolled", offsetHours: st.offsetHours, template: st.template })),
        },
      },
    });
  }
}

// ---- Timing -------------------------------------------------------------------

function etParts(d: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", hour12: false }).formatToParts(d);
  return { weekday: parts.find((p) => p.type === "weekday")!.value, hour: Number(parts.find((p) => p.type === "hour")!.value) % 24 };
}

/** Texts go out 9 am–8 pm Eastern, Monday–Saturday. Returns `d` or the next allowed time. */
export function nextAllowedSendTime(d: Date): Date {
  let t = new Date(d);
  for (let i = 0; i < 24 * 8; i++) {
    const { weekday, hour } = etParts(t);
    if (weekday !== "Sun" && hour >= 9 && hour < 20) return t;
    t = new Date(Math.ceil((t.getTime() + 1) / 3_600_000) * 3_600_000); // next whole hour
  }
  return t;
}

/** "enrolled" offsets count from enrollment (Day 1, Day 3, Day 7…); visit anchors from the appointment. */
function stepTime(step: { anchor: string; offsetHours: number }, enrolledAt: Date, visit: { start: Date; end: Date } | null) {
  const h = step.offsetHours * 3_600_000;
  if (step.anchor === "visit_start" && visit) return new Date(visit.start.getTime() + h);
  if (step.anchor === "visit_end" && visit) return new Date(visit.end.getTime() + h);
  return new Date(enrolledAt.getTime() + h);
}

/** Finds the next step at or after `fromIndex` that isn't already stale; returns null when done. */
function nextStep(
  steps: { anchor: string; offsetHours: number }[],
  fromIndex: number,
  enrolledAt: Date,
  visit: { start: Date; end: Date } | null,
  now: Date,
): { index: number; at: Date } | null {
  for (let i = fromIndex; i < steps.length; i++) {
    const at = stepTime(steps[i]!, enrolledAt, visit);
    // Skip appointment reminders whose moment has passed (e.g. booked 2 hours before the visit).
    if (steps[i]!.anchor !== "enrolled" && at.getTime() < now.getTime() - 3_600_000) continue;
    return { index: i, at: at < now ? now : at };
  }
  return null;
}

// ---- Enroll / stop --------------------------------------------------------------

export async function enroll(trigger: string, leadId: string, opts: { visitId?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const lead = await db.lead.findUnique({ where: { id: leadId }, include: { customer: true } });
  if (!lead || !lead.customer.phone || lead.customer.smsOptOut) return 0;
  const sequences = await db.sequence.findMany({ where: { trigger, active: true }, include: { steps: { orderBy: { sortOrder: "asc" } } } });
  const visit = opts.visitId ? await db.visit.findUnique({ where: { id: opts.visitId } }) : null;
  let count = 0;
  for (const seq of sequences) {
    const active = await db.enrollment.findFirst({
      where: { sequenceId: seq.id, leadId, status: "active", ...(opts.visitId ? { visitId: opts.visitId } : {}) },
    });
    if (active) continue;
    const first = nextStep(seq.steps, 0, now, visit, now);
    if (!first) continue;
    await db.enrollment.create({
      data: {
        sequenceId: seq.id,
        leadId,
        visitId: opts.visitId ?? null,
        stepIndex: first.index,
        nextSendAt: nextAllowedSendTime(first.at),
      },
    });
    count++;
  }
  return count;
}

export async function stopEnrollments(
  where: { customerId?: string; leadId?: string; visitId?: string; enrollmentId?: string; triggers?: string[] },
  reason: string,
) {
  const filter: Prisma.EnrollmentWhereInput = {
    status: "active",
    ...(where.enrollmentId ? { id: where.enrollmentId } : {}),
    ...(where.leadId ? { leadId: where.leadId } : {}),
    ...(where.visitId ? { visitId: where.visitId } : {}),
    ...(where.customerId ? { lead: { customerId: where.customerId } } : {}),
    ...(where.triggers ? { sequence: { trigger: { in: where.triggers } } } : {}),
  };
  const res = await db.enrollment.updateMany({ where: filter, data: { status: "stopped", stoppedReason: reason, nextSendAt: null } });
  return res.count;
}

/** Owner/tech "Stop" button on the lead page. */
export async function stopEnrollmentManually(actor: Actor, enrollmentId: string) {
  return stopEnrollments({ enrollmentId }, actor.kind === "user" ? `stopped by ${actor.name}` : "stopped");
}

/** Stage drips run only while the lead stays in their trigger stage. */
export async function onLeadStageChanged(leadId: string, to: string) {
  const others = STAGE_TRIGGERS.filter((t) => t !== to);
  await stopEnrollments({ leadId, triggers: others }, `moved to ${to}`);
  if (to === "lost") await stopEnrollments({ leadId }, "marked lost");
  if (STAGE_TRIGGERS.includes(to)) await enroll(to, leadId);
}

/** Visit rescheduled: re-time pending reminders. */
export async function retimeVisitEnrollments(visitId: string) {
  const visit = await db.visit.findUnique({ where: { id: visitId } });
  if (!visit) return;
  const enrollments = await db.enrollment.findMany({
    where: { visitId, status: "active" },
    include: { sequence: { include: { steps: { orderBy: { sortOrder: "asc" } } } } },
  });
  const now = new Date();
  for (const e of enrollments) {
    const next = nextStep(e.sequence.steps, e.stepIndex, e.createdAt, visit, now);
    await db.enrollment.update({
      where: { id: e.id },
      data: next
        ? { stepIndex: next.index, nextSendAt: nextAllowedSendTime(next.at) }
        : { status: "completed", nextSendAt: null },
    });
  }
}

export async function recordDeliveryFailure(enrollmentId: string) {
  const e = await db.enrollment.update({ where: { id: enrollmentId }, data: { failures: { increment: 1 } } });
  if (e.failures >= MAX_FAILURES && e.status === "active") {
    await stopEnrollments({ enrollmentId }, `${MAX_FAILURES} failed deliveries`);
  }
}

// ---- Rendering + sending -----------------------------------------------------------

const DATE_TIME = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const DATE = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "long", day: "numeric" });

export function renderTemplate(template: string, vars: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k]! : m)).replace(/\s+/g, " ").trim();
}

async function varsFor(leadId: string, visitId: string | null) {
  const [lead, company] = await Promise.all([
    db.lead.findUniqueOrThrow({
      where: { id: leadId },
      include: {
        customer: true,
        proposals: { where: { status: { in: ["sent", "viewed"] } }, orderBy: { version: "desc" }, take: 1 },
      },
    }),
    getCompany(),
  ]);
  const visit = visitId ? await db.visit.findUnique({ where: { id: visitId }, include: { tech: true } }) : null;
  const proposal = lead.proposals[0];
  return {
    firstName: lead.customer.name.split(/\s+/)[0] ?? "",
    jobTitle: lead.title.toLowerCase(),
    companyName: company.name,
    companyPhone: formatPhone(company.phone) || company.name,
    proposalLink: proposal?.token ? proposalLink(proposal.token) : "",
    expiry: proposal?.expiresAt ? DATE.format(proposal.expiresAt) : "",
    techName: visit?.tech.name.split(/\s+/)[0] ?? "our technician",
    visitTime: visit ? DATE_TIME.format(visit.start) : "",
    reviewLink: company.googleReviewUrl,
  };
}

async function personalize(text: string, leadId: string): Promise<string> {
  try {
    const lead = await db.lead.findUnique({ where: { id: leadId } });
    if (!lead?.notes || process.env.AI_MOCK === "1") return text;
    const { personalizeText } = await import("@/lib/integrations/claude-text");
    return await personalizeText(text, lead.notes);
  } catch (err) {
    console.error("[personalize]", err);
    return text;
  }
}

/** Sends every due enrollment step. Safe to run concurrently (rows are claimed). */
export async function processDueEnrollments(now = new Date(), limit = 50) {
  const claimed = await db.$queryRaw<{ id: string }[]>`
    UPDATE "Enrollment" SET "nextSendAt" = (now() AT TIME ZONE 'UTC') + interval '10 minutes', "updatedAt" = (now() AT TIME ZONE 'UTC')
    WHERE id IN (
      SELECT id FROM "Enrollment"
      WHERE status = 'active' AND "nextSendAt" <= (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      ORDER BY "nextSendAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`;
  let sent = 0;
  for (const { id } of claimed) {
    const e = await db.enrollment.findUnique({
      where: { id },
      include: { sequence: { include: { steps: { orderBy: { sortOrder: "asc" } } } }, lead: { include: { customer: true } }, visit: true },
    });
    if (!e || e.status !== "active") continue;
    if (!e.sequence.active) {
      await stopEnrollments({ enrollmentId: e.id }, "sequence turned off");
      continue;
    }
    const allowed = nextAllowedSendTime(now);
    if (allowed.getTime() > now.getTime()) {
      await db.enrollment.update({ where: { id: e.id }, data: { nextSendAt: allowed } });
      continue;
    }
    if (e.visit && ["cancelled", "done"].includes(e.visit.status)) {
      await stopEnrollments({ enrollmentId: e.id }, `visit ${e.visit.status}`);
      continue;
    }
    const step = e.sequence.steps[e.stepIndex];
    if (!step) {
      await db.enrollment.update({ where: { id: e.id }, data: { status: "completed", nextSendAt: null } });
      continue;
    }

    let body = renderTemplate(step.template, await varsFor(e.leadId, e.visitId));
    if (step.personalize) body = await personalize(body, e.leadId);
    if (!(await hasReceivedAutomatedText(e.lead.customerId)) && !/stop/i.test(body)) {
      body = `${body} Reply STOP to opt out.`;
    }
    const result = await sendCustomerText(SYSTEM(`Sequence: ${e.sequence.name}`), {
      customerId: e.lead.customerId,
      leadId: e.leadId,
      body,
      enrollmentId: e.id,
    });
    if (!result.ok) {
      if (result.reason.includes("opted out") || result.reason.includes("no phone")) {
        await stopEnrollments({ enrollmentId: e.id }, result.reason);
      } else {
        await recordDeliveryFailure(e.id);
        await db.enrollment.updateMany({ where: { id: e.id, status: "active" }, data: { nextSendAt: new Date(now.getTime() + 3_600_000) } });
      }
      continue;
    }
    sent++;
    const next = nextStep(e.sequence.steps, e.stepIndex + 1, e.createdAt, e.visit, now);
    await db.enrollment.update({
      where: { id: e.id },
      data: next ? { stepIndex: next.index, nextSendAt: nextAllowedSendTime(next.at) } : { status: "completed", stepIndex: e.stepIndex + 1, nextSendAt: null },
    });
  }
  return sent;
}

// ---- Editing (Settings → Texts) ---------------------------------------------------------

export async function listSequences() {
  await ensureDefaultSequences();
  return db.sequence.findMany({ orderBy: { createdAt: "asc" }, include: { steps: { orderBy: { sortOrder: "asc" } } } });
}

export async function saveSequence(
  actor: Actor,
  id: string,
  input: { name: string; active: boolean; steps: { anchor: string; offsetHours: number; template: string; personalize: boolean }[] },
) {
  if (!isOwner(actor)) throw new ForbiddenError("Only the owner can edit texts");
  if (!input.name.trim()) throw new ValidationError("Name is required");
  if (!input.steps.length) throw new ValidationError("Add at least one step");
  for (const s of input.steps) {
    if (!s.template.trim()) throw new ValidationError("Every step needs a message");
    if (s.template.length > 600) throw new ValidationError("Keep each message under 600 characters");
    if (!["enrolled", "visit_start", "visit_end"].includes(s.anchor)) throw new ValidationError("Unknown timing");
    if (!Number.isFinite(s.offsetHours)) throw new ValidationError("Timing must be a number of hours");
  }
  await db.$transaction([
    db.sequence.update({ where: { id }, data: { name: input.name.trim(), active: input.active } }),
    db.sequenceStep.deleteMany({ where: { sequenceId: id } }),
    db.sequenceStep.createMany({
      data: input.steps.map((s, i) => ({ sequenceId: id, sortOrder: i, anchor: s.anchor, offsetHours: s.offsetHours, template: s.template.trim(), personalize: s.personalize })),
    }),
  ]);
}

export async function leadEnrollments(leadId: string) {
  return db.enrollment.findMany({
    where: { leadId },
    orderBy: { createdAt: "desc" },
    include: { sequence: { include: { steps: { select: { id: true } } } } },
  });
}

export const SEQUENCE_PLACEHOLDERS = "{firstName} {jobTitle} {companyName} {companyPhone} {proposalLink} {expiry} {techName} {visitTime} {reviewLink}";
