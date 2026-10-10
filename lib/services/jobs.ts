// Jobs after the deposit: completion → final invoice → payment → review (SPEC.md pipeline stages 8–11).

import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { formatCents } from "@/lib/money";
import type { Prisma } from "@/generated/prisma/client";
import { QuickBooksError } from "@/lib/integrations/quickbooks";
import { getQuickBooksClient } from "./quickbooks-auth";
import { NotFoundError, SYSTEM, ValidationError, isOwner, ForbiddenError, type Actor } from "./actor";
import { recordActivity } from "./activity";
import { changeStage, leadScope } from "./leads";
import { enqueueDiscord, flushOutboxSoon } from "./outbox";
import { sendCustomerText } from "./messages";
import { enroll } from "./sequences";
import { getCompany } from "./company";

const jobInclude = {
  lead: { include: { customer: true, property: true, assignedTo: { select: { id: true, name: true } } } },
  proposal: { include: { options: { include: { lineItems: { orderBy: { sortOrder: "asc" } } } } } },
  visits: { orderBy: { start: "asc" }, include: { tech: { select: { id: true, name: true } } } },
  payments: { orderBy: { createdAt: "asc" } },
  assignedTo: { select: { id: true, name: true } },
} satisfies Prisma.JobInclude;
export type FullJob = Prisma.JobGetPayload<{ include: typeof jobInclude }>;

export async function getJob(actor: Actor, id: string) {
  const job = await db.job.findFirst({
    where: { id, ...(isOwner(actor) ? {} : { OR: [{ assignedToId: (actor as { id: string }).id }, { lead: leadScope(actor) }, { visits: { some: { techId: (actor as { id: string }).id } } }] }) },
    include: jobInclude,
  });
  if (!job) throw new NotFoundError("Job not found");
  return job;
}

export async function listJobs(actor: Actor, opts: { status?: string[] } = {}) {
  return db.job.findMany({
    where: {
      ...(opts.status ? { status: { in: opts.status as never } } : {}),
      ...(isOwner(actor) ? {} : { assignedToId: (actor as { id: string }).id }),
    },
    include: { lead: { include: { customer: true, property: true } }, visits: { where: { status: { not: "cancelled" } }, orderBy: { start: "asc" } } },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
}

export function balanceCents(job: { totalCents: number; payments: { status: string; amountCents: number }[] }) {
  return job.totalCents - job.payments.filter((p) => p.status === "succeeded").reduce((s, p) => s + p.amountCents, 0);
}

export async function updateJob(actor: Actor, id: string, input: { durationHours?: number; assignedToId?: string | null }) {
  if (!isOwner(actor)) throw new ForbiddenError("Only the owner can change jobs");
  if (input.durationHours !== undefined && !(input.durationHours > 0 && input.durationHours <= 80)) throw new ValidationError("Hours must be between 0 and 80");
  return db.job.update({ where: { id }, data: input });
}

/** Last job visit done → job completed → final invoice for the balance. */
export async function completeJob(actor: Actor, jobId: string) {
  const job = await db.job.findUnique({ where: { id: jobId }, include: { lead: true } });
  if (!job || ["completed", "invoiced", "paid", "cancelled"].includes(job.status)) return;
  await db.$transaction(async (tx) => {
    await tx.job.update({ where: { id: jobId }, data: { status: "completed", completedAt: new Date() } });
    await recordActivity(tx, actor, { type: "job_completed", leadId: job.leadId, body: "Job completed" });
  });
  await changeStage(actor, job.leadId, "job_completed");
  await createFinalInvoice(actor, jobId).catch((e) => console.error("[final invoice]", e));
}

/** Creates and sends the QuickBooks invoice for the balance, then texts the payment link. */
export async function createFinalInvoice(actor: Actor, jobId: string) {
  const job = await db.job.findUniqueOrThrow({ where: { id: jobId }, include: { payments: true, lead: { include: { customer: true, property: true, assignedTo: { select: { name: true } } } } } });
  if (job.quickbooksInvoiceId) return job;
  const balance = balanceCents(job);
  if (balance <= 0) return markJobPaid(jobId, null);
  const qbo = await getQuickBooksClient();
  if (!qbo) {
    await db.$transaction((tx) =>
      enqueueDiscord(tx, { content: `🧾 Job done: ${job.lead.customer.name} owes ${formatCents(balance, { cents: true })}. Connect QuickBooks or invoice it by hand: ${appUrl()}/jobs/${jobId}` }),
    );
    await flushOutboxSoon();
    return job;
  }
  try {
    let customerId = job.lead.customer.quickbooksId;
    if (!customerId) {
      customerId = await qbo.findOrCreateCustomer({
        name: job.lead.customer.name,
        email: job.lead.customer.email,
        phone: job.lead.customer.phone,
        address: job.lead.property ? { street: job.lead.property.street, city: job.lead.property.city, state: job.lead.property.state, zip: job.lead.property.zip } : null,
      });
      await db.customer.update({ where: { id: job.lead.customerId }, data: { quickbooksId: customerId } });
    }
    const paid = job.totalCents - balance;
    const invoice = await qbo.createInvoice({
      customerId,
      lines: [{ description: `${job.title}: balance due (total ${formatCents(job.totalCents, { cents: true })} less ${formatCents(paid, { cents: true })} paid)`, qty: 1, unitCents: balance }],
      memo: `Thank you for choosing Degree of Comfort.`,
      email: job.lead.customer.email,
      estimateId: job.quickbooksEstimateId,
    });
    if (job.lead.customer.email) await qbo.sendInvoice(invoice.id, job.lead.customer.email);
    await db.$transaction(async (tx) => {
      await tx.job.update({ where: { id: jobId }, data: { status: "invoiced", quickbooksInvoiceId: invoice.id, invoiceLink: invoice.link, invoiceSentAt: new Date() } });
      await recordActivity(tx, actor, { type: "invoice_sent", leadId: job.leadId, body: `Final invoice #${invoice.id} for ${formatCents(balance, { cents: true })}` });
    });
    await changeStage(actor, job.leadId, "invoiced");
    const first = job.lead.customer.name.split(/\s+/)[0];
    await sendCustomerText(actor, {
      customerId: job.lead.customerId,
      leadId: job.leadId,
      body: `Hi ${first}, thanks for choosing Degree of Comfort! Your balance of ${formatCents(balance, { cents: true })} is ready to pay${invoice.link ? `: ${invoice.link}` : " (check your email for the invoice)"}.`,
    });
    return job;
  } catch (err) {
    const detail = err instanceof QuickBooksError ? `${err.message} ${err.detail ?? ""}` : String(err);
    await db.$transaction(async (tx) => {
      await recordActivity(tx, SYSTEM("QuickBooks"), { type: "quickbooks_error", leadId: job.leadId, body: `Creating the final invoice: ${detail.slice(0, 500)}` });
      await enqueueDiscord(tx, { content: `⚠️ QuickBooks couldn't create the final invoice for ${appUrl()}/jobs/${jobId}` });
    });
    await flushOutboxSoon();
    throw err;
  }
}

/** Owner records the final payment by hand (check, cash…). */
export async function recordFinalPayment(actor: Actor, jobId: string, input: { method: "check" | "cash" | "card" | "other"; amountCents: number; note?: string }) {
  if (!isOwner(actor)) throw new ForbiddenError("Only the owner can record payments");
  if (!(input.amountCents > 0)) throw new ValidationError("Enter the amount received");
  await db.payment.create({
    data: { jobId, kind: "final", method: input.method, amountCents: input.amountCents, status: "succeeded", note: input.note, createdById: (actor as { id: string }).id },
  });
  const job = await db.job.findUniqueOrThrow({ where: { id: jobId }, include: { payments: true } });
  if (balanceCents(job) <= 0) await markJobPaid(jobId, null);
}

async function markJobPaid(jobId: string, invoiceAmountCents: number | null) {
  const job = await db.job.findUniqueOrThrow({ where: { id: jobId }, include: { lead: { include: { customer: true, property: true, assignedTo: { select: { name: true } } } } } });
  if (job.status === "paid") return job;
  await db.$transaction(async (tx) => {
    if (invoiceAmountCents) {
      await tx.payment.create({ data: { jobId, kind: "final", method: "quickbooks_invoice", amountCents: invoiceAmountCents, status: "succeeded" } });
    }
    await tx.job.update({ where: { id: jobId }, data: { status: "paid", paidAt: new Date() } });
    await recordActivity(tx, SYSTEM("Payments"), { type: "job_paid", leadId: job.leadId, body: "Paid in full" });
  });
  await changeStage(SYSTEM("Payments"), job.leadId, "payment_complete");
  const first = job.lead.customer.name.split(/\s+/)[0];
  await sendCustomerText(SYSTEM("Payments"), {
    customerId: job.lead.customerId,
    leadId: job.leadId,
    body: `Thanks ${first}, we received your payment in full for ${job.title.split(" — ")[0]}. We appreciate your business!`,
  });
  return job;
}

/** Scheduler: invoiced jobs whose QuickBooks balance hit zero are paid. */
export async function pollInvoices(limit = 30) {
  const qbo = await getQuickBooksClient();
  if (!qbo) return 0;
  const jobs = await db.job.findMany({ where: { status: "invoiced", quickbooksInvoiceId: { not: null } }, take: limit, orderBy: { invoiceSentAt: "asc" } });
  let paid = 0;
  for (const job of jobs) {
    try {
      const balance = await qbo.invoiceBalanceCents(job.quickbooksInvoiceId!);
      if (balance <= 0) {
        const withPayments = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { payments: true } });
        await markJobPaid(job.id, balanceCents(withPayments));
        paid++;
      }
    } catch (err) {
      console.error("[qbo poll]", job.id, err);
    }
  }
  return paid;
}

/** Texts the review link (if set), moves the lead to review_requested, enrolls HVAC in maintenance. */
export async function sendReviewRequest(leadId: string, actor: Actor = SYSTEM("Reviews")) {
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, include: { customer: true } });
  const company = await getCompany();
  if (company.googleReviewUrl) {
    await sendCustomerText(actor, {
      customerId: lead.customerId,
      leadId: lead.id,
      body: `Hi ${lead.customer.name.split(/\s+/)[0]}, thank you for choosing ${company.name}! If we did a great job, would you leave us a quick review? ${company.googleReviewUrl}`,
    });
  }
  await changeStage(actor, lead.id, "review_requested");
  if (lead.trade === "hvac") await enroll("maintenance", lead.id);
}

/** Scheduler: the morning after payment, ask for a review and enroll HVAC customers in maintenance. */
export async function requestReviews(now = new Date()) {
  const etHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(now)) % 24;
  if (etHour < 9 || etHour >= 20) return 0;
  const startOfTodayEt = new Date(now.getTime() - etHour * 3_600_000 - now.getMinutes() * 60_000);
  const leads = await db.lead.findMany({
    where: { stage: "payment_complete", stageChangedAt: { lt: startOfTodayEt } },
    take: 50,
    select: { id: true },
  });
  for (const lead of leads) await sendReviewRequest(lead.id);
  if (leads.length) {
    await db.$transaction((tx) => enqueueDiscord(tx, { content: `⭐ Review requests sent to ${leads.length} customer(s).` }));
    await flushOutboxSoon();
  }
  return leads.length;
}

