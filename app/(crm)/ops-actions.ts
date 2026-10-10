"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { parseDollars } from "@/lib/money";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/services/actor";
import { cancelVisit, disconnectCalendar, rescheduleVisit, scheduleVisit, updateVisitStatus } from "@/lib/services/visits";
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

/** "2026-10-14" + "09:30" in Eastern time → Date. */
function easternDateTime(date: string, time: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new ValidationError("Pick a date and time");
  const probe = new Date(`${date}T12:00:00Z`);
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" })
    .formatToParts(probe)
    .find((p) => p.type === "timeZoneName")!
    .value.replace("GMT", "");
  const sign = offset.startsWith("-") ? "-" : "+";
  const hours = String(Math.abs(Number(offset || 0))).padStart(2, "0");
  return new Date(`${date}T${time}:00${sign}${hours}:00`);
}

export async function scheduleVisitAction(_prev: Result | undefined, fd: FormData): Promise<Result> {
  const user = await requireUser();
  const s = (k: string) => String(fd.get(k) ?? "");
  try {
    const start = easternDateTime(s("date"), s("time"));
    const hours = Number(s("hours") || "1");
    if (!(hours > 0 && hours <= 12)) throw new ValidationError("Length must be between 0.5 and 12 hours");
    await scheduleVisit(user, {
      leadId: s("leadId"),
      jobId: s("jobId") || null,
      kind: s("kind") === "job" ? "job" : "estimate",
      techId: s("techId"),
      start,
      end: new Date(start.getTime() + hours * 3_600_000),
      notes: s("notes") || undefined,
    });
  } catch (err) {
    return fail(err);
  }
  refresh(`/leads/${s("leadId")}`, s("jobId") ? `/jobs/${s("jobId")}` : "/jobs");
  return { ok: "Scheduled" };
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
}): Promise<Result> {
  const user = await requireUser();
  try {
    const start = new Date(input.start);
    const end = new Date(start.getTime() + input.durationMinutes * 60_000);
    if (input.visitId) {
      await rescheduleVisit(user, input.visitId, { start, end, techId: input.techId });
    } else if (input.leadId) {
      await scheduleVisit(user, { leadId: input.leadId, jobId: input.jobId ?? null, kind: input.kind ?? "estimate", techId: input.techId, start, end });
    }
  } catch (err) {
    return fail(err);
  }
  refresh("/dispatch");
  return { ok: "Saved" };
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
    await confirmBooking(user, bookingId, { techId: String(fd.get("techId")), date: String(fd.get("date")), window: String(fd.get("window")) });
  } catch (err) {
    return fail(err);
  }
  refresh(`/leads/${leadId}`, "/pipeline");
  return { ok: "Confirmed. The customer gets a confirmation text." };
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
