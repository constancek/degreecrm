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
    const job = await tx.job.create({
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
