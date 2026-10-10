"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { parseDollars } from "@/lib/money";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/services/actor";
import {
  RESCHEDULE_REASONS,
  cancelVisit,
  disconnectCalendar,
  needsReschedule,
  rescheduleVisit,
  runningLate,
  scheduleVisit,
  updateVisitStatus,
  wrapUpVisit,
  type RescheduleReason,
  type WrapUp,
  customerNotHome,
  type NoShow,
} from "@/lib/services/visits";
import { recordManualDeposit } from "@/lib/services/payments";
import { createFinalInvoice, recordFinalPayment, updateJob } from "@/lib/services/jobs";
import { sendCustomerText } from "@/lib/services/messages";
import { saveSequence, stopEnrollmentManually } from "@/lib/services/sequences";
import { findSlots } from "@/lib/services/dispatch";
import { disconnect as disconnectQuickBooks, getQuickBooksClient, setIncomeAccount } from "@/lib/services/quickbooks-auth";
import { db } from "@/lib/db";
import type { PaymentMethod, VisitStatus } from "@/generated/prisma/enums";

export type Result = { error?: string; ok?: string };

function fail(err: unknown): Result {
  if (err instanceof z.ZodError) return { error: err.issues[0]?.message ?? "Please check the form" };
  if (err instanceof ValidationError || err instanceof ForbiddenError || err instanceof NotFoundError) return { error: err.message };
  console.error(err);
  return { error: err instanceof Error && err.message.startsWith("QuickBooks") ? err.message : "Something went wrong. Please try again." };
}

function refresh(...paths: string[]) {
  for (const p of paths) revalidatePath(p);
  revalidatePath("/dispatch");
  revalidatePath("/my-day");
}

export async function scheduleVisitAction(_prev: Result | undefined, fd: FormData): Promise<Result> {
  const user = await requireUser();
  const s = (k: string) => String(fd.get(k) ?? "");
  try {
    const { bookingTimes } = await import("@/lib/services/booking");
    await scheduleVisit(user, {
      leadId: s("leadId"),
      jobId: s("jobId") || null,
      kind: s("kind") === "job" ? "job" : "estimate",
      techId: s("techId") || null,
      ...bookingTimes({ date: s("date"), window: s("window"), time: s("time"), hours: Number(s("hours") || "1") }),
      notes: s("notes") || undefined,
    });
  } catch (err) {
    return fail(err);
  }
  refresh(`/leads/${s("leadId")}`, s("jobId") ? `/jobs/${s("jobId")}` : "/jobs", "/pipeline", "/calendar");
  return { ok: s("techId") ? "Booked. The customer gets the confirmation text." : "Booked without a tech (Needs tech)." };
}

/** Lead page "Reschedule": new day/window and/or tech; texts the customer unless unchecked. */
export async function rescheduleVisitAction(visitId: string, _prev: Result | undefined, fd: FormData): Promise<Result> {
  const user = await requireUser();
  const s = (k: string) => String(fd.get(k) ?? "");
  try {
    const { bookingTimes } = await import("@/lib/services/booking");
    const t = bookingTimes({ date: s("date"), window: s("window"), time: s("time"), hours: Number(s("hours") || "1") });
    await rescheduleVisit(user, visitId, { ...t, techId: s("techId") || undefined }, { notifyCustomer: fd.get("notify") === "on" });
  } catch (err) {
    return fail(err);
  }
  refresh("/pipeline", "/calendar");
  return { ok: "Updated" };
}

/** Dispatch board drag & drop and slot-finder clicks. */
export async function placeOnBoardAction(input: {
  visitId?: string;
  leadId?: string;
  jobId?: string;
  kind?: "estimate" | "job";
  techId: string;
  start: string;
  durationMinutes: number;
  notifyCustomer?: boolean;
}): Promise<Result> {
  const user = await requireUser();
  try {
    const start = new Date(input.start);
    const end = new Date(start.getTime() + input.durationMinutes * 60_000);
    if (input.visitId) {
      await rescheduleVisit(user, input.visitId, { start, end, techId: input.techId }, { notifyCustomer: input.notifyCustomer ?? false });
    } else if (input.leadId) {
      await scheduleVisit(user, { leadId: input.leadId, jobId: input.jobId ?? null, kind: input.kind ?? "estimate", techId: input.techId, start, end });
    }
  } catch (err) {
    return fail(err);
  }
  refresh("/dispatch");
  return { ok: "Saved" };
}

/** Tech: "Running late" — texts the customer the new approximate arrival time. */
export async function runningLateAction(visitId: string, minutes: number): Promise<Result> {
  const user = await requireUser();
  try {
    await runningLate(user, visitId, minutes);
  } catch (err) {
    return fail(err);
  }
  refresh("/pipeline", "/calendar");
  return { ok: "Customer texted the new arrival time" };
}

/** Tech or owner: the visit can't happen as booked → cancelled, lead to Needs reschedule. */
export async function needsRescheduleAction(visitId: string, input: { reason: string; note?: string; notifyCustomer: boolean }): Promise<Result> {
  const user = await requireUser();
  try {
    if (!(input.reason in RESCHEDULE_REASONS)) throw new ValidationError("Pick a reason");
    await needsReschedule(user, visitId, { reason: input.reason as RescheduleReason, note: input.note, notifyCustomer: input.notifyCustomer });
  } catch (err) {
    return fail(err);
  }
  refresh("/pipeline", "/calendar");
  return { ok: "Moved to Needs reschedule" };
}

/** Tech wraps up the first visit: work now, return visit, declined, or estimate to follow. */
export async function wrapUpVisitAction(visitId: string, input: WrapUp & { feeDollars?: string }): Promise<Result & { jobId?: string }> {
  const user = await requireUser();
  try {
    const payload: WrapUp =
      input.outcome === "declined"
        ? {
            ...input,
            feeCents: input.fee === "none" ? undefined : parseDollars(input.feeDollars ?? "") ?? undefined,
          }
        : input;
    if (payload.outcome === "declined" && payload.fee !== "none" && !payload.feeCents) throw new ValidationError("Enter the service call fee");
    const res = await wrapUpVisit(user, visitId, payload);
    refresh("/pipeline", "/calendar", "/jobs");
    return { ok: "Saved", jobId: "jobId" in res ? res.jobId : undefined };
  } catch (err) {
    return fail(err);
  }
}

export async function customerNotHomeAction(visitId: string, input: NoShow & { feeDollars?: string }): Promise<Result> {
  const user = await requireUser();
  try {
    const feeCents = input.fee === "none" ? undefined : (parseDollars(input.feeDollars ?? "") ?? undefined);
    if (input.fee !== "none" && !feeCents) throw new ValidationError("Enter the trip fee");
    await customerNotHome(user, visitId, { fee: input.fee, feeCents, method: input.method, notifyCustomer: input.notifyCustomer });
    refresh("/pipeline", "/calendar", "/jobs");
    return { ok: "Saved. The office will rebook it." };
  } catch (err) {
    return fail(err);
  }
}

export async function cancelVisitAction(visitId: string, reason?: string): Promise<Result> {
  const user = await requireUser();
  try {
    await cancelVisit(user, visitId, reason);
  } catch (err) {
    return fail(err);
  }
  refresh("/jobs");
  return { ok: "Cancelled" };
}

export async function visitStatusAction(visitId: string, status: VisitStatus, notifyCustomer: boolean): Promise<Result> {
  const user = await requireUser();
  try {
    await updateVisitStatus(user, visitId, status, { notifyCustomer });
  } catch (err) {
    return fail(err);
  }
  refresh("/jobs");
  return { ok: "Updated" };
}

export async function recordDepositAction(proposalId: string, _prev: Result | undefined, fd: FormData): Promise<Result> {
  const user = await requireUser();
  try {
    const amountCents = parseDollars(String(fd.get("amount") ?? ""));
    if (amountCents == null) throw new ValidationError("Enter the amount received");
    await recordManualDeposit(user, proposalId, {
      method: String(fd.get("method")) as PaymentMethod,
      amountCents,
      note: String(fd.get("note") ?? "") || undefined,
    });
  } catch (err) {
    return fail(err);
  }
  refresh(`/proposals/${proposalId}`);
  return { ok: "Deposit recorded" };
}

export async function finalInvoiceAction(jobId: string): Promise<Result> {
  const user = await requireUser();
  if (user.role !== "owner") return { error: "Only the owner can invoice" };
  try {
    await createFinalInvoice(user, jobId);
  } catch (err) {
    return fail(err);
  }
  refresh(`/jobs/${jobId}`);
  return { ok: "Invoice created" };
}

export async function recordFinalPaymentAction(jobId: string, _prev: Result | undefined, fd: FormData): Promise<Result> {
  const user = await requireUser();
  try {
    const amountCents = parseDollars(String(fd.get("amount") ?? ""));
    if (amountCents == null) throw new ValidationError("Enter the amount received");
    await recordFinalPayment(user, jobId, {
      method: String(fd.get("method")) as "check",
      amountCents,
      note: String(fd.get("note") ?? "") || undefined,
    });
  } catch (err) {
    return fail(err);
  }
  refresh(`/jobs/${jobId}`);
  return { ok: "Payment recorded" };
}

export async function updateJobAction(jobId: string, _prev: Result | undefined, fd: FormData): Promise<Result> {
  const user = await requireUser();
  try {
    await updateJob(user, jobId, { durationHours: Number(fd.get("durationHours")) });
  } catch (err) {
    return fail(err);
  }
  refresh(`/jobs/${jobId}`);
  return { ok: "Saved" };
}

export async function sendTextAction(leadId: string, _prev: Result | undefined, fd: FormData): Promise<Result> {
  const user = await requireUser();
  try {
    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
    if (user.role !== "owner" && lead.assignedToId !== user.id) throw new ForbiddenError("Not your lead");
    const res = await sendCustomerText(user, { customerId: lead.customerId, leadId, body: String(fd.get("body") ?? "") });
    if (!res.ok) return { error: `Not sent: ${res.reason}` };
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/leads/${leadId}`);
  return { ok: "Sent" };
}

export async function stopEnrollmentAction(enrollmentId: string, leadId: string): Promise<void> {
  const user = await requireUser();
  await stopEnrollmentManually(user, enrollmentId);
  revalidatePath(`/leads/${leadId}`);
}

export async function saveSequenceAction(sequenceId: string, payload: unknown): Promise<Result> {
  const user = await requireUser();
  try {
    await saveSequence(user, sequenceId, payload as never);
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/settings/texts");
  return { ok: "Saved" };
}

export async function findSlotsAction(input: {
  leadId: string;
  durationHours: number;
  maxDriveMinutes: number;
  request?: string;
}): Promise<{ error?: string; slots?: { techId: string; techName: string; start: string; end: string; driveMinutes: number | null; fromWhere: string }[]; parsed?: string }> {
  const user = await requireUser();
  try {
    let params: { durationHours: number; maxDriveMinutes: number; fromDate?: string; days?: number } = {
      durationHours: input.durationHours,
      maxDriveMinutes: input.maxDriveMinutes,
    };
    let parsed: string | undefined;
    if (input.request?.trim()) {
      const { parseSlotRequest } = await import("@/lib/integrations/claude-text");
      const { easternYmd } = await import("@/lib/services/dispatch");
      const p = await parseSlotRequest(input.request, easternYmd(new Date()));
      params = { durationHours: p.durationHours, maxDriveMinutes: Math.round(p.maxDriveMinutes), fromDate: p.fromDate, days: Math.round(p.days) };
      parsed = `${p.durationHours} h, within ${Math.round(p.maxDriveMinutes)} min, from ${p.fromDate} for ${Math.round(p.days)} days`;
    }
    const { slots } = await findSlots(user, { leadId: input.leadId, ...params });
    return { slots: slots.map((s) => ({ ...s, start: s.start.toISOString(), end: s.end.toISOString() })), parsed };
  } catch (err) {
    return { error: fail(err).error };
  }
}

export async function disconnectCalendarAction(): Promise<void> {
  const user = await requireUser();
  await disconnectCalendar(user.id);
  revalidatePath("/settings");
}

export async function disconnectQuickBooksAction(): Promise<void> {
  const user = await requireUser();
  if (user.role !== "owner") return;
  await disconnectQuickBooks();
  revalidatePath("/settings");
}

export async function setIncomeAccountAction(fd: FormData): Promise<void> {
  const user = await requireUser();
  if (user.role !== "owner") return;
  const id = String(fd.get("accountId") ?? "");
  const qbo = await getQuickBooksClient();
  const account = (await qbo?.listIncomeAccounts())?.find((a) => a.id === id);
  if (account) await setIncomeAccount(account);
  revalidatePath("/settings");
}

export async function confirmBookingAction(bookingId: string, leadId: string, _prev: Result | undefined, fd: FormData): Promise<Result> {
  const user = await requireUser();
  try {
    const { confirmBooking } = await import("@/lib/services/booking");
    const techId = String(fd.get("techId") ?? "") || null;
    await confirmBooking(user, bookingId, { techId, date: String(fd.get("date")), window: String(fd.get("window")), hours: Number(fd.get("hours") || 1) });
    refresh(`/leads/${leadId}`, "/pipeline", "/calendar");
    return { ok: techId ? "Booked. The customer gets a confirmation text." : "Booked without a tech (Needs tech). The customer is texted once you assign one." };
  } catch (err) {
    return fail(err);
  }
}

export async function declineBookingAction(bookingId: string, leadId: string, _prev: Result | undefined, fd: FormData): Promise<Result> {
  const user = await requireUser();
  try {
    const { declineBooking } = await import("@/lib/services/booking");
    const text = String(fd.get("text") ?? "").trim();
    await declineBooking(user, bookingId, { textCustomer: text || undefined });
  } catch (err) {
    return fail(err);
  }
  refresh(`/leads/${leadId}`);
  return { ok: "Declined" };
}
