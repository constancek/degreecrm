// Deposits (SPEC.md "Payments with the QuickBooks Payments API").
// Card data goes browser → Intuit; we only ever see a one-time token. QuickBooks Online stays the ledger.

import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { formatCents } from "@/lib/money";
import { formatAddress, leadStageEmbed } from "@/lib/notifications/discord-embeds";
import { QuickBooksError, type QboLine } from "@/lib/integrations/quickbooks";
import { getQuickBooksClient } from "./quickbooks-auth";
import { ForbiddenError, SYSTEM, ValidationError, actorUserId, isOwner, type Actor } from "./actor";
import { recordActivity } from "./activity";
import { depositPercentFor, getCompany } from "./company";
import { enqueueDiscord, flushOutboxSoon } from "./outbox";
import { alertOwner, sendCustomerText } from "./messages";
import type { PaymentMethod } from "@/generated/prisma/enums";

async function loadSigned(proposalId: string) {
  const p = await db.proposal.findUnique({
    where: { id: proposalId },
    include: {
      options: { include: { lineItems: { orderBy: { sortOrder: "asc" } } } },
      lead: { include: { customer: true, property: true, assignedTo: { select: { id: true, name: true } } } },
      job: true,
    },
  });
  if (!p) throw new ValidationError("Proposal not found");
  const option = p.options.find((o) => o.id === (p.signedOptionId ?? p.selectedOptionId));
  if (p.status !== "signed" || !option) throw new ValidationError("The proposal must be signed first");
  return { p, option };
}

export async function depositFor(proposalId: string) {
  const { p, option } = await loadSigned(proposalId);
  const company = await getCompany();
  const percent = depositPercentFor(option.totalCents, company, p.depositPercent);
  return { percent, amountCents: Math.round((option.totalCents * percent) / 100), totalCents: option.totalCents, option, proposal: p };
}

function optionLines(option: Awaited<ReturnType<typeof loadSigned>>["option"], taxLabel: string): QboLine[] {
  const lines: QboLine[] = option.lineItems
    .filter((l) => !l.isOptional)
    .map((l) => ({ description: l.description, qty: l.qty, unitCents: l.unitCents }));
  if (option.taxCents > 0) lines.push({ description: `Sales tax${taxLabel ? ` (${taxLabel})` : ""}`, qty: 1, unitCents: option.taxCents });
  return lines;
}

async function quickbooksCustomerId(customer: { id: string; name: string; email: string | null; phone: string | null; quickbooksId: string | null }, property: Parameters<typeof formatAddress>[0] & { state?: string } | null) {
  if (customer.quickbooksId) return customer.quickbooksId;
  const qbo = await getQuickBooksClient();
  if (!qbo) return null;
  const id = await qbo.findOrCreateCustomer({
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    address: property ? { street: property.street, city: property.city, state: property.state ?? "OH", zip: property.zip } : null,
  });
  await db.customer.update({ where: { id: customer.id }, data: { quickbooksId: id } });
  return id;
}

async function logQuickBooksError(leadId: string, what: string, err: unknown) {
  const detail = err instanceof QuickBooksError ? `${err.message} ${err.detail ?? ""}` : String(err);
  console.error(`[qbo] ${what}`, detail);
  await db.$transaction(async (tx) => {
    await recordActivity(tx, SYSTEM("QuickBooks"), { type: "quickbooks_error", leadId, body: `${what}: ${detail.slice(0, 500)}` });
    await enqueueDiscord(tx, { content: `⚠️ QuickBooks: ${what} failed for ${appUrl()}/leads/${leadId}. Check the lead's activity.` });
  });
  await flushOutboxSoon();
}

/** Signed proposal → QBO customer + accepted estimate. Idempotent. */
export async function ensureQuickBooksEstimate(proposalId: string) {
  const { p, option } = await loadSigned(proposalId);
  if (p.quickbooksEstimateId) return p.quickbooksEstimateId;
  const qbo = await getQuickBooksClient();
  if (!qbo) return null;
  try {
    const customerId = await quickbooksCustomerId(p.lead.customer, p.lead.property);
    if (!customerId) return null;
    const estimateId = await qbo.createEstimate({
      customerId,
      lines: optionLines(option, p.taxLabel),
      memo: `${option.title} — proposal v${p.version}`,
      email: p.lead.customer.email,
    });
    await db.proposal.update({ where: { id: p.id }, data: { quickbooksEstimateId: estimateId } });
    await db.$transaction((tx) =>
      recordActivity(tx, SYSTEM("QuickBooks"), { type: "quickbooks_estimate", leadId: p.leadId, body: `Estimate #${estimateId} created in QuickBooks` }),
    );
    return estimateId;
  } catch (err) {
    await logQuickBooksError(p.leadId, "creating the estimate", err);
    return null;
  }
}

/** Customer pays the deposit by card on the proposal page. */
export async function chargeDeposit(proposalId: string, cardToken: string, meta: { ip: string | null }) {
  const { proposal: p, amountCents, option } = await depositFor(proposalId);
  if (p.depositPaidAt) return { ok: true as const, alreadyPaid: true };
  if (!/^[\w-]{8,100}$/.test(cardToken)) throw new ValidationError("Card details didn't come through. Please try again.");
  const qbo = await getQuickBooksClient();
  if (!qbo) throw new ValidationError("Online payment isn't available yet. Please call us to pay your deposit.");

  let charge: { id: string; last4: string | null };
  try {
    charge = await qbo.charge({
      token: cardToken,
      amountCents,
      requestId: `${p.id}:deposit`,
      description: `Deposit — ${option.title} (${p.lead.customer.name})`,
    });
  } catch (err) {
    const reason = err instanceof QuickBooksError && err.status < 500 ? err.message : "The payment didn't go through.";
    await db.payment.create({
      data: { proposalId: p.id, kind: "deposit", method: "card", amountCents, status: "failed", failureReason: reason.slice(0, 500) },
    });
    await db.$transaction((tx) =>
      recordActivity(tx, SYSTEM("Customer"), { type: "payment_failed", leadId: p.leadId, body: reason, data: { proposalId: p.id, ip: meta.ip } }),
    );
    throw new ValidationError(`${reason} No charge was made. Check the card details or try another card.`);
  }

  const payment = await db.payment.upsert({
    where: { quickbooksChargeId: charge.id },
    create: {
      proposalId: p.id,
      kind: "deposit",
      method: "card",
      amountCents,
      status: "succeeded",
      quickbooksChargeId: charge.id,
      cardLast4: charge.last4,
    },
    update: {},
  });
  await markDepositPaid(p.id, payment.id, SYSTEM("Customer"));

  // Book it in QuickBooks Online; the money is already captured, so a failure here is for the owner to fix.
  try {
    const customerId = await quickbooksCustomerId(p.lead.customer, p.lead.property);
    const estimateId = p.quickbooksEstimateId ?? (await ensureQuickBooksEstimate(p.id));
    if (customerId) {
      const booked = await qbo.recordPayment({
        customerId,
        lines: [{ description: `Deposit (${Math.round((amountCents / option.totalCents) * 100)}%) — ${option.title}`, qty: 1, unitCents: amountCents }],
        memo: `Deposit for proposal v${p.version}, charge ${charge.id}`,
        chargeId: charge.id,
        method: "card",
        estimateId,
      });
      await db.payment.update({ where: { id: payment.id }, data: { quickbooksPaymentId: booked.paymentId } });
    }
  } catch (err) {
    await logQuickBooksError(p.leadId, "recording the deposit payment", err);
  }
  return { ok: true as const, alreadyPaid: false };
}

/** Owner records a deposit taken another way (check, cash, financing…). */
export async function recordManualDeposit(
  actor: Actor,
  proposalId: string,
  input: { method: PaymentMethod; amountCents: number; note?: string },
) {
  if (!isOwner(actor)) throw new ForbiddenError("Only the owner can record payments");
  const { p } = await loadSigned(proposalId);
  if (p.depositPaidAt) throw new ValidationError("The deposit is already recorded");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new ValidationError("Enter the amount received");
  const payment = await db.payment.create({
    data: {
      proposalId: p.id,
      kind: "deposit",
      method: input.method,
      amountCents: input.amountCents,
      status: "succeeded",
      note: input.note?.slice(0, 500),
      createdById: actorUserId(actor),
    },
  });
  await markDepositPaid(p.id, payment.id, actor);
  if (input.method === "check" || input.method === "cash") {
    const qbo = await getQuickBooksClient();
    if (qbo) {
      try {
        const customerId = await quickbooksCustomerId(p.lead.customer, p.lead.property);
        if (customerId) {
          const booked = await qbo.recordPayment({
            customerId,
            lines: [{ description: `Deposit — proposal v${p.version}`, qty: 1, unitCents: input.amountCents }],
            memo: input.note ?? `Deposit by ${input.method}`,
            chargeId: null,
            method: input.method,
            estimateId: p.quickbooksEstimateId,
          });
          await db.payment.update({ where: { id: payment.id }, data: { quickbooksPaymentId: booked.paymentId } });
        }
      } catch (err) {
        await logQuickBooksError(p.leadId, "recording the deposit payment", err);
      }
    }
  }
  return payment;
}

/** Deposit in: create the Job, notify everyone. Stage stays estimate_approved until a visit is booked. */
async function markDepositPaid(proposalId: string, paymentId: string, actor: Actor) {
  const { proposal: p, option, amountCents } = await depositFor(proposalId);
  const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const created = await db.$transaction(async (tx) => {
    const res = await tx.proposal.updateMany({ where: { id: p.id, depositPaidAt: null }, data: { depositPaidAt: new Date() } });
    if (res.count === 0) return null;
    // "Start work now" may already have created the job (no deposit taken then).
    const existing = await tx.job.findUnique({ where: { proposalId: p.id } });
    const job = existing
      ? await tx.job.update({ where: { id: existing.id }, data: { depositCents: existing.depositCents + payment.amountCents } })
      : await tx.job.create({
          data: {
            leadId: p.leadId,
            proposalId: p.id,
            propertyId: p.lead.propertyId,
            title: `${p.lead.title} — ${option.title}`.slice(0, 200),
            assignedToId: p.lead.assignedToId,
            totalCents: option.totalCents,
            depositCents: payment.amountCents,
            quickbooksEstimateId: p.quickbooksEstimateId,
          },
        });
    await tx.payment.update({ where: { id: paymentId }, data: { jobId: job.id } });
    await recordActivity(tx, actor, {
      type: "deposit_paid",
      leadId: p.leadId,
      body: `Deposit ${formatCents(payment.amountCents, { cents: true })} received (${payment.method}${payment.cardLast4 ? ` •••• ${payment.cardLast4}` : ""})`,
      data: { proposalId: p.id, paymentId, jobId: job.id, expectedCents: amountCents },
    });
    const embed = leadStageEmbed(p.lead);
    embed.embeds![0]!.title = `Deposit paid: ${p.lead.title} — ${formatCents(payment.amountCents)}`;
    embed.embeds![0]!.url = `${appUrl()}/jobs/${job.id}`;
    await enqueueDiscord(tx, embed);
    return job;
  });
  if (!created) return;
  await flushOutboxSoon();
  await alertOwner(`Deposit received from ${p.lead.customer.name}: ${formatCents(payment.amountCents, { cents: true })}. Schedule it: ${appUrl()}/jobs/${created.id}`);
  const first = p.lead.customer.name.split(/\s+/)[0];
  await sendCustomerText(SYSTEM("Payments"), {
    customerId: p.lead.customerId,
    leadId: p.leadId,
    body: `Thanks ${first}! We received your ${formatCents(payment.amountCents, { cents: true })} deposit for ${option.title}. We'll text you shortly to schedule your job.`,
  });
}

/** Customer tapped "Pay monthly": log it and tell the owner to start the Acorn application. */
export async function recordFinancingInterest(proposalId: string) {
  const { p, option } = await loadSigned(proposalId).catch(async () => {
    const p = await db.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { lead: { include: { customer: true } }, options: true } });
    return { p, option: p.options.find((o) => o.id === p.selectedOptionId) ?? p.options[0]! };
  });
  await db.$transaction(async (tx) => {
    await recordActivity(tx, SYSTEM("Customer"), {
      type: "financing_clicked",
      leadId: p.leadId,
      body: `Opened Acorn financing for ${formatCents(option.totalCents)}`,
      data: { proposalId },
    });
    await enqueueDiscord(tx, {
      content: `💳 ${p.lead.customer.name} tapped "Pay monthly" for ${formatCents(option.totalCents)}. Start the Acorn application while they're warm: ${appUrl()}/leads/${p.leadId}`,
    });
  });
  await flushOutboxSoon();
  await alertOwner(`${p.lead.customer.name} wants to finance ${formatCents(option.totalCents)}. Start the Acorn application.`);
}

// ---- Same-visit work and service call fees ------------------------------------------------

/**
 * "Start work now" on a small repair: the signed estimate is enough, no deposit (the customer pays the
 * full amount at the end). Returns the job (existing one if there is already one for this proposal).
 */
export async function createJobWithoutDeposit(actor: Actor, proposalId: string, techId: string | null) {
  const { p, option } = await loadSigned(proposalId);
  if (p.job) return p.job;
  return db.$transaction(async (tx) => {
    const job = await tx.job.create({
      data: {
        leadId: p.leadId,
        proposalId: p.id,
        propertyId: p.lead.propertyId,
        title: `${p.lead.title} — ${option.title}`.slice(0, 200),
        assignedToId: techId ?? p.lead.assignedToId,
        totalCents: option.totalCents,
        depositCents: 0,
        quickbooksEstimateId: p.quickbooksEstimateId,
      },
    });
    await recordActivity(tx, actor, {
      type: "job_created",
      leadId: p.leadId,
      body: `Work started the same visit (${option.title}, ${formatCents(option.totalCents, { cents: true })}); paid at the end, no deposit`,
      data: { proposalId: p.id, jobId: job.id },
    });
    return job;
  });
}

export const FEE_METHODS = ["cash", "check", "card"] as const;

/**
 * Service call fee on a declined estimate: recorded as collected at the door, or invoiced through
 * QuickBooks (emailed + the pay link texted). The visit carries the fee status for the board.
 */
export async function settleServiceFee(
  actor: Actor,
  visitId: string,
  input: { mode: "collect" | "invoice"; amountCents: number; method?: (typeof FEE_METHODS)[number] },
) {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new ValidationError("Enter the service call fee");
  const v = await db.visit.findUniqueOrThrow({
    where: { id: visitId },
    include: { lead: { include: { customer: true, property: true, proposals: { orderBy: { version: "desc" }, take: 1 } } } },
  });
  const lead = v.lead;
  const label = `Service call — ${lead.title}`.slice(0, 200);
  const qbo = await getQuickBooksClient();

  if (input.mode === "collect") {
    const method = input.method ?? "cash";
    const payment = await db.payment.create({
      data: {
        proposalId: lead.proposals[0]?.id ?? null,
        kind: "service_fee",
        method,
        amountCents: input.amountCents,
        status: "succeeded",
        note: label,
        createdById: actorUserId(actor),
      },
    });
    await db.$transaction(async (tx) => {
      await tx.visit.update({ where: { id: visitId }, data: { feeStatus: "collected", feeCents: input.amountCents } });
      await recordActivity(tx, actor, {
        type: "service_fee",
        leadId: lead.id,
        body: `Service call fee ${formatCents(input.amountCents, { cents: true })} collected (${method})`,
        data: { visitId, paymentId: payment.id },
      });
    });
    if (qbo) {
      try {
        const customerId = await quickbooksCustomerId(lead.customer, lead.property);
        if (customerId) {
          const booked = await qbo.recordPayment({
            customerId,
            lines: [{ description: label, qty: 1, unitCents: input.amountCents }],
            memo: `Service call fee by ${method}`,
            chargeId: null,
            method,
            estimateId: null,
          });
          await db.payment.update({ where: { id: payment.id }, data: { quickbooksPaymentId: booked.paymentId } });
        }
      } catch (err) {
        await logQuickBooksError(lead.id, "recording the service call fee", err);
      }
    }
    return;
  }

  // Invoice it.
  await db.visit.update({ where: { id: visitId }, data: { feeStatus: "invoiced", feeCents: input.amountCents } });
  if (!qbo) {
    await db.$transaction(async (tx) => {
      await recordActivity(tx, actor, { type: "service_fee", leadId: lead.id, body: `Service call fee ${formatCents(input.amountCents, { cents: true })} to invoice (QuickBooks not connected)`, data: { visitId } });
      await enqueueDiscord(tx, { content: `🧾 Service call fee ${formatCents(input.amountCents, { cents: true })} for ${lead.customer.name}: QuickBooks isn't connected, invoice it by hand. ${appUrl()}/leads/${lead.id}` });
    });
    await flushOutboxSoon();
    return;
  }
  try {
    const customerId = await quickbooksCustomerId(lead.customer, lead.property);
    if (!customerId) throw new ValidationError("QuickBooks customer missing");
    const invoice = await qbo.createInvoice({
      customerId,
      lines: [{ description: label, qty: 1, unitCents: input.amountCents }],
      memo: "Thank you for having Degree of Comfort out.",
      email: lead.customer.email,
      estimateId: null,
    });
    if (lead.customer.email) await qbo.sendInvoice(invoice.id, lead.customer.email);
    await db.$transaction(async (tx) => {
      await tx.visit.update({ where: { id: visitId }, data: { feeInvoiceId: invoice.id, feeInvoiceLink: invoice.link } });
      await recordActivity(tx, actor, { type: "service_fee", leadId: lead.id, body: `Service call fee invoice #${invoice.id} for ${formatCents(input.amountCents, { cents: true })}`, data: { visitId } });
    });
    const first = lead.customer.name.split(/\s+/)[0];
    await sendCustomerText(actor, {
      customerId: lead.customerId,
      leadId: lead.id,
      body: `Hi ${first}, thanks for having Degree of Comfort out today. Your service call fee of ${formatCents(input.amountCents, { cents: true })} is ready to pay${invoice.link ? `: ${invoice.link}` : " (check your email for the invoice)"}.`,
    });
  } catch (err) {
    await logQuickBooksError(lead.id, "creating the service call fee invoice", err);
  }
}

/** Scheduler: service call fee invoices paid in QuickBooks. */
export async function pollServiceFeeInvoices(limit = 30) {
  const qbo = await getQuickBooksClient();
  if (!qbo) return 0;
  const visits = await db.visit.findMany({ where: { feeStatus: "invoiced", feeInvoiceId: { not: null } }, take: limit, orderBy: { updatedAt: "asc" } });
  let paid = 0;
  for (const v of visits) {
    try {
      if ((await qbo.invoiceBalanceCents(v.feeInvoiceId!)) <= 0) {
        await db.$transaction(async (tx) => {
          await tx.visit.update({ where: { id: v.id }, data: { feeStatus: "paid" } });
          await tx.payment.create({ data: { kind: "service_fee", method: "quickbooks_invoice", amountCents: v.feeCents ?? 0, status: "succeeded", note: "Service call fee invoice paid" } });
          await recordActivity(tx, SYSTEM("Payments"), { type: "service_fee", leadId: v.leadId, body: "Service call fee paid" });
        });
        paid++;
      }
    } catch (err) {
      console.error("[qbo fee poll]", v.id, err);
    }
  }
  return paid;
}
