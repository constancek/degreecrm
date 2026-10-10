// Dragging a pipeline card into a stage does that stage's real work (book, send, record, invoice…).
// `planStageMove` says what's needed (shown as a dialog); `performStageMove` does it.

import { db } from "@/lib/db";
import { bookableDates } from "@/lib/booking";
import { STAGES } from "@/lib/stages";
import { formatCents } from "@/lib/money";
import { formatPhone } from "@/lib/phone";
import type { LeadStage } from "@/generated/prisma/enums";
import { ValidationError, isOwner, type Actor } from "./actor";
import { changeStage, getLead } from "./leads";
import { getCompany, depositPercentFor } from "./company";
import { sendProblems, getProposal, sendProposal } from "./proposals";
import { recordPaperApproval } from "./signing";
import { recordManualDeposit } from "./payments";
import { balanceCents, completeJob, createFinalInvoice, recordFinalPayment, sendReviewRequest } from "./jobs";
import { RESCHEDULE_REASONS, needsReschedule, rescheduleVisit, scheduleVisit, updateVisitStatus, wrapUpVisit, type RescheduleReason } from "./visits";
import { confirmBooking, windowTimes } from "./booking";
import { easternMidnight } from "./dispatch";
import type { PaymentMethod } from "@/generated/prisma/enums";

const ORDER = STAGES.map((s) => s.id);

export type StagePlan =
  | { kind: "simple" }
  | { kind: "lost" }
  | { kind: "blocked"; message: string; href?: string; linkLabel?: string }
  | { kind: "scheduleEstimate"; techs: { id: string; name: string }[]; defaultTechId: string | null; dates: { ymd: string; label: string }[]; booking: { id: string; date: string; window: string } | null; noTech?: boolean }
  | { kind: "assignTech"; visitId: string; label: string; techs: { id: string; name: string }[]; defaultTechId: string | null }
  | { kind: "visitStatus"; visitId: string; status: "en_route" | "in_progress"; label: string; canText: boolean }
  | { kind: "reschedule"; visitId: string; label: string }
  | { kind: "decline"; visitId: string | null; feeDollars: string }
  | { kind: "sendProposal"; proposalId: string; problems: string[]; canText: boolean; phone: string | null }
  | { kind: "recordApproval"; proposalId: string; options: { id: string; title: string; total: string }[]; customerName: string }
  | { kind: "recordDeposit"; proposalId: string; defaultDollars: string }
  | { kind: "scheduleJob"; jobId: string; techs: { id: string; name: string }[]; defaultTechId: string | null; defaultHours: number }
  | { kind: "startVisit"; visitId: string; label: string }
  | { kind: "completeJob"; jobId: string; openVisits: number; balance: string }
  | { kind: "sendInvoice"; jobId: string; balance: string }
  | { kind: "recordPayment"; jobId: string; defaultDollars: string }
  | { kind: "requestReview"; hasReviewLink: boolean };

const ownerOnly = (actor: Actor): StagePlan | null =>
  isOwner(actor) ? null : { kind: "blocked", message: "Only the owner can do this step. Ask them, or use the job's buttons on My day." };

export async function planStageMove(actor: Actor, leadId: string, stage: LeadStage): Promise<StagePlan> {
  const lead = await getLead(actor, leadId);
  if (stage === lead.stage) return { kind: "simple" };
  if (stage === "lost") return { kind: "lost" };

  // The first visit drives the day-of columns.
  const openVisit = await db.visit.findFirst({
    where: { leadId, kind: "estimate", status: { in: ["scheduled", "en_route", "in_progress"] } },
    orderBy: { start: "desc" },
  });
  const visitLabel = openVisit
    ? new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(openVisit.start)
    : "";
  // Cancelling for a reschedule works from any column.
  if (stage === "needs_reschedule" && openVisit && ["scheduled", "en_route"].includes(openVisit.status)) {
    if (!isOwner(actor) && openVisit.techId !== (actor as { id: string }).id) return { kind: "blocked", message: "Only the owner or the assigned tech can do this." };
    return { kind: "reschedule", visitId: openVisit.id, label: visitLabel };
  }
  // Moving backwards (or to the early stages) just moves the card.
  if (ORDER.indexOf(stage) < ORDER.indexOf(lead.stage) || stage === "new" || stage === "follow_up") return { kind: "simple" };

  const [proposals, job, techs] = await Promise.all([
    db.proposal.findMany({ where: { leadId }, orderBy: { version: "desc" }, include: { options: { orderBy: { sortOrder: "asc" } } } }),
    db.job.findFirst({ where: { leadId }, orderBy: { createdAt: "desc" }, include: { visits: { orderBy: { start: "asc" } }, payments: true } }),
    db.user.findMany({ where: { active: true }, orderBy: [{ role: "asc" }, { name: "asc" }], select: { id: true, name: true } }),
  ]);
  const signed = proposals.find((p) => p.status === "signed");
  const live = proposals.find((p) => p.status === "sent" || p.status === "viewed");
  const draft = proposals.find((p) => p.status === "draft");

  switch (stage) {
    case "needs_tech":
    case "estimate_scheduled": {
      const blocked = ownerOnly(actor);
      if (blocked) return blocked;
      if (openVisit && !openVisit.techId) {
        if (stage === "needs_tech") return { kind: "simple" };
        return { kind: "assignTech", visitId: openVisit.id, label: visitLabel, techs, defaultTechId: lead.assignedToId };
      }
      if (openVisit) return { kind: "blocked", message: "This lead already has a booked visit. Change it from the lead page or the Dispatch board.", href: `/leads/${leadId}`, linkLabel: "Open lead" };
      const booking = await db.bookingRequest.findFirst({ where: { leadId, status: "pending" }, orderBy: { createdAt: "desc" } });
      return {
        kind: "scheduleEstimate",
        techs,
        defaultTechId: lead.assignedToId,
        dates: bookableDates(),
        booking: booking ? { id: booking.id, date: booking.date, window: booking.window } : null,
        noTech: stage === "needs_tech",
      };
    }
    case "on_the_way":
    case "on_site": {
      if (!openVisit) return { kind: "blocked", message: "There's no booked visit to update. Book one first." };
      if (!openVisit.techId) return { kind: "blocked", message: "Assign a tech to the visit first." };
      if (!isOwner(actor) && openVisit.techId !== (actor as { id: string }).id) return { kind: "blocked", message: "This visit belongs to another tech." };
      return {
        kind: "visitStatus",
        visitId: openVisit.id,
        status: stage === "on_the_way" ? "en_route" : "in_progress",
        label: visitLabel,
        canText: Boolean(lead.customer.phone) && !lead.customer.smsOptOut,
      };
    }
    case "estimate_declined": {
      const latest = openVisit ?? (await db.visit.findFirst({ where: { leadId, kind: "estimate", status: "done", outcome: null }, orderBy: { start: "desc" } }));
      const company = await getCompany();
      return { kind: "decline", visitId: latest?.id ?? null, feeDollars: (company.serviceCallFeeCents / 100).toFixed(2) };
    }
    case "estimate_sent": {
      const blocked = ownerOnly(actor);
      if (blocked) return blocked;
      if (!draft) {
        return live
          ? { kind: "blocked", message: "A proposal was already sent. Create a revision from it to send a new one.", href: `/proposals/${live.id}`, linkLabel: "Open proposal" }
          : { kind: "blocked", message: "Create the proposal first; you can send it from there.", href: `/leads/${leadId}/proposal/new`, linkLabel: "New proposal" };
      }
      const full = await getProposal(actor, draft.id);
      return {
        kind: "sendProposal",
        proposalId: draft.id,
        problems: sendProblems(full),
        canText: Boolean(lead.customer.phone) && !lead.customer.smsOptOut,
        phone: lead.customer.phone ? formatPhone(lead.customer.phone) : null,
      };
    }
    case "estimate_approved": {
      const blocked = ownerOnly(actor);
      if (blocked) return blocked;
      if (!live) return { kind: "blocked", message: "Send a proposal first. The card moves here by itself when the customer signs online." };
      return {
        kind: "recordApproval",
        proposalId: live.id,
        customerName: lead.customer.name,
        options: live.options.map((o) => ({ id: o.id, title: o.title, total: formatCents(o.totalCents, { cents: true }) })),
      };
    }
    case "job_scheduled": {
      const blocked = ownerOnly(actor);
      if (blocked) return blocked;
      if (job) return { kind: "scheduleJob", jobId: job.id, techs, defaultTechId: job.assignedToId ?? lead.assignedToId, defaultHours: Math.min(job.durationHours, 10) };
      if (signed) {
        const option = signed.options.find((o) => o.id === signed.signedOptionId);
        const company = await getCompany();
        const cents = option ? Math.round((option.totalCents * depositPercentFor(option.totalCents, company, signed.depositPercent)) / 100) : 0;
        return { kind: "recordDeposit", proposalId: signed.id, defaultDollars: (cents / 100).toFixed(2) };
      }
      return { kind: "blocked", message: "A job needs a signed proposal and a deposit first." };
    }
    case "job_in_progress": {
      const next = job?.visits.find((v) => ["scheduled", "en_route"].includes(v.status));
      if (!next) return { kind: "blocked", message: "Schedule a job visit first." };
      return { kind: "startVisit", visitId: next.id, label: new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(next.start) };
    }
    case "job_completed": {
      const blocked = ownerOnly(actor);
      if (blocked) return blocked;
      if (!job) return { kind: "blocked", message: "There's no job yet (it's created when the deposit is paid)." };
      return { kind: "completeJob", jobId: job.id, openVisits: job.visits.filter((v) => ["scheduled", "en_route", "in_progress"].includes(v.status)).length, balance: formatCents(Math.max(0, balanceCents(job)), { cents: true }) };
    }
    case "invoiced": {
      const blocked = ownerOnly(actor);
      if (blocked) return blocked;
      if (!job) return { kind: "blocked", message: "There's no job to invoice yet." };
      if (job.quickbooksInvoiceId) return { kind: "simple" };
      return { kind: "sendInvoice", jobId: job.id, balance: formatCents(Math.max(0, balanceCents(job)), { cents: true }) };
    }
    case "payment_complete": {
      const blocked = ownerOnly(actor);
      if (blocked) return blocked;
      if (!job) return { kind: "blocked", message: "There's no job yet." };
      const bal = balanceCents(job);
      if (bal <= 0) return { kind: "simple" };
      return { kind: "recordPayment", jobId: job.id, defaultDollars: (bal / 100).toFixed(2) };
    }
    case "review_requested": {
      const blocked = ownerOnly(actor);
      if (blocked) return blocked;
      const company = await getCompany();
      return { kind: "requestReview", hasReviewLink: Boolean(company.googleReviewUrl) };
    }
    default:
      return { kind: "simple" };
  }
}

export type StageMovePayload = {
  lostReason?: string;
  techId?: string;
  date?: string;
  window?: string;
  time?: string;
  hours?: number;
  textCustomer?: boolean;
  reason?: string;
  fee?: "none" | "collect" | "invoice";
  feeDollars?: string;
  feeMethod?: "cash" | "check" | "card";
  optionId?: string;
  signerName?: string;
  note?: string;
  method?: string;
  amountDollars?: string;
};

function dollarsToCents(v: string | undefined) {
  const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
  if (!(n > 0)) throw new ValidationError("Enter the amount received");
  return Math.round(n * 100);
}

/** Carries out the dropped stage's work. The stage itself moves as a result of that work. */
export async function performStageMove(actor: Actor, leadId: string, stage: LeadStage, payload: StageMovePayload) {
  const plan = await planStageMove(actor, leadId, stage);
  switch (plan.kind) {
    case "simple":
      return changeStage(actor, leadId, stage);
    case "lost":
      return changeStage(actor, leadId, "lost", { lostReason: payload.lostReason });
    case "blocked":
      throw new ValidationError(plan.message);
    case "scheduleEstimate": {
      if (!payload.date || !payload.window) throw new ValidationError("Pick a day and arrival window");
      const techId = payload.techId || null;
      const hours = payload.hours && payload.hours > 0 ? payload.hours : 1;
      if (plan.booking) return confirmBooking(actor, plan.booking.id, { techId, date: payload.date, window: payload.window, hours });
      const { start, end } = windowTimes(payload.date, payload.window);
      return scheduleVisit(actor, { leadId, kind: "estimate", techId, start, end: new Date(start.getTime() + hours * 3_600_000), arrivalStart: start, arrivalEnd: end });
    }
    case "assignTech": {
      if (!payload.techId) throw new ValidationError("Choose a tech");
      const v = await db.visit.findUniqueOrThrow({ where: { id: plan.visitId } });
      return rescheduleVisit(actor, plan.visitId, { start: v.start, end: v.end, techId: payload.techId });
    }
    case "visitStatus":
      return updateVisitStatus(actor, plan.visitId, plan.status, { notifyCustomer: plan.status === "en_route" && Boolean(payload.textCustomer) });
    case "reschedule": {
      const reason = (payload.reason ?? "customer_request") as RescheduleReason;
      if (!(reason in RESCHEDULE_REASONS)) throw new ValidationError("Pick a reason");
      return needsReschedule(actor, plan.visitId, { reason, note: payload.note, notifyCustomer: Boolean(payload.textCustomer) });
    }
    case "decline": {
      const reason = payload.reason?.trim();
      if (!reason) throw new ValidationError("Add a short reason");
      if (!plan.visitId) {
        await db.lead.update({ where: { id: leadId }, data: { lostReason: reason.slice(0, 300) } });
        return changeStage(actor, leadId, "estimate_declined");
      }
      const fee = payload.fee ?? "none";
      return wrapUpVisit(actor, plan.visitId, {
        outcome: "declined",
        reason,
        fee,
        feeCents: fee === "none" ? undefined : dollarsToCents(payload.feeDollars),
        method: payload.feeMethod,
      });
    }
    case "sendProposal":
      return sendProposal(actor, plan.proposalId, { textCustomer: Boolean(payload.textCustomer) });
    case "recordApproval":
      return recordPaperApproval(actor, plan.proposalId, { optionId: payload.optionId ?? "", signerName: payload.signerName ?? "", note: payload.note });
    case "recordDeposit":
      return recordManualDeposit(actor, plan.proposalId, { method: (payload.method ?? "check") as PaymentMethod, amountCents: dollarsToCents(payload.amountDollars), note: payload.note });
    case "scheduleJob": {
      if (!payload.techId || !payload.date || !payload.time) throw new ValidationError("Pick a day, start time and tech");
      const hours = payload.hours ?? plan.defaultHours;
      const [h, m] = payload.time.split(":").map(Number) as [number, number];
      const start = new Date(easternMidnight(payload.date).getTime() + (h * 60 + m) * 60_000);
      return scheduleVisit(actor, { leadId, jobId: plan.jobId, kind: "job", techId: payload.techId, start, end: new Date(start.getTime() + hours * 3_600_000) });
    }
    case "startVisit":
      return updateVisitStatus(actor, plan.visitId, "in_progress");
    case "completeJob": {
      const job = await db.job.findUniqueOrThrow({ where: { id: plan.jobId }, include: { visits: true } });
      const open = job.visits.filter((v) => ["scheduled", "en_route", "in_progress"].includes(v.status));
      // Closing the last open visit completes the job and sends the final invoice.
      for (const v of open) await updateVisitStatus(actor, v.id, "done");
      if (!open.length) await completeJob(actor, plan.jobId);
      return;
    }
    case "sendInvoice":
      await createFinalInvoice(actor, plan.jobId);
      return;
    case "recordPayment":
      return recordFinalPayment(actor, plan.jobId, { method: (payload.method ?? "check") as "check", amountCents: dollarsToCents(payload.amountDollars), note: payload.note });
    case "requestReview":
      return sendReviewRequest(leadId, actor);
  }
}
