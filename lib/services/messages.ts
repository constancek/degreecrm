// Every text in or out goes through here and is logged as a Message (one thread per customer).

import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { normalizePhone, formatPhone } from "@/lib/phone";
import { getQuoClient } from "@/lib/integrations/quo";
import { actorUserId, ValidationError, type Actor } from "./actor";
import { recordActivity } from "./activity";
import { enqueueDiscord, flushOutboxSoon } from "./outbox";
import { getCompany } from "./company";

export const STOP_WORDS = ["stop", "stopall", "unsubscribe", "cancel", "end", "quit"];
export const START_WORDS = ["start", "unstop", "yes"];
const URGENT = /\b(urgent|emergency|asap|flood(ing)?|leak(ing)?|no heat|gas smell|smell gas|sparks?|smoke|burning)\b/i;

export type SendResult = { ok: true; messageId: string } | { ok: false; reason: string };

/**
 * Sends a text to a customer from the company number and logs it. Never throws for delivery problems;
 * returns { ok: false, reason } so callers (drips, buttons) can decide what to do.
 */
export async function sendCustomerText(
  actor: Actor,
  input: { customerId: string; leadId?: string | null; body: string; enrollmentId?: string | null },
): Promise<SendResult> {
  const body = input.body.trim();
  if (!body) throw new ValidationError("The message is empty");
  if (body.length > 1600) throw new ValidationError("Texts can be up to 1,600 characters");
  const customer = await db.customer.findUnique({ where: { id: input.customerId } });
  if (!customer) throw new ValidationError("Customer not found");
  if (!customer.phone) return { ok: false, reason: "no phone number" };
  if (customer.smsOptOut) return { ok: false, reason: "customer opted out of texts" };
  const quo = getQuoClient();
  if (!quo) return { ok: false, reason: "texting isn't set up (QUO_API_KEY / QUO_INBOX_ID)" };

  const msg = await db.message.create({
    data: {
      customerId: customer.id,
      leadId: input.leadId ?? null,
      direction: "out",
      body,
      status: "queued",
      enrollmentId: input.enrollmentId ?? null,
      sentById: actorUserId(actor),
    },
  });
  try {
    const sent = await quo.sendText({ to: customer.phone, content: body });
    await db.message.update({ where: { id: msg.id }, data: { status: "sent", quoMessageId: sent.id } });
    return { ok: true, messageId: msg.id };
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 300) : "send failed";
    await db.message.update({ where: { id: msg.id }, data: { status: "failed", error: reason } });
    return { ok: false, reason };
  }
}

/** Has this customer ever received an automated (drip) text? The first one must carry STOP wording. */
export async function hasReceivedAutomatedText(customerId: string) {
  return (await db.message.count({ where: { customerId, direction: "out", enrollmentId: { not: null } } })) > 0;
}

/** Text the owner's alert phone (Settings) — e.g. a proposal was signed. Falls back to Discord only. */
export async function alertOwner(text: string) {
  const company = await getCompany();
  const quo = getQuoClient();
  if (company.ownerAlertPhone && quo) {
    await quo.sendText({ to: company.ownerAlertPhone, content: text }).catch((e) => console.error("[owner alert]", e));
  }
}

// ---- Inbound (Quo webhook) ----------------------------------------------------------

/**
 * Quo signs webhooks: header `openphone-signature: hmac;1;<timestamp>;<base64 sig>`,
 * sig = HMAC-SHA256(base64-decoded key, `${timestamp}.${payload}`).
 */
export function verifyQuoSignature(header: string | null, rawBody: string, signingKeyB64: string | undefined): boolean {
  if (!header || !signingKeyB64) return false;
  const [scheme, version, timestamp, signature] = header.split(";");
  if (scheme !== "hmac" || version !== "1" || !timestamp || !signature) return false;
  // Reject replays older than 15 minutes.
  if (Math.abs(Date.now() - Number(timestamp)) > 15 * 60_000) return false;
  const key = Buffer.from(signingKeyB64, "base64");
  // Quo signs the compact JSON; accept the raw body too in case it's already compact.
  const candidates = [rawBody];
  try {
    candidates.push(JSON.stringify(JSON.parse(rawBody)));
  } catch {
    /* not JSON */
  }
  const given = Buffer.from(signature);
  return candidates.some((payload) => {
    const expected = Buffer.from(createHmac("sha256", key).update(`${timestamp}.${payload}`).digest("base64"));
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}

type QuoEvent = {
  type?: string;
  data?: { object?: { id?: string; from?: string; to?: string[] | string; text?: string; body?: string; direction?: string; status?: string } };
};

export async function handleQuoEvent(event: QuoEvent) {
  const type = event.type ?? "";
  const m = event.data?.object ?? {};
  if (type === "message.received") return handleInbound({ quoId: m.id ?? null, from: m.from ?? "", body: m.text ?? m.body ?? "" });
  if (type === "message.delivered" || type === "message.failed" || type === "message.sent") {
    if (!m.id) return;
    const status = type === "message.delivered" ? "delivered" : type === "message.failed" ? "failed" : "sent";
    const msg = await db.message.findUnique({ where: { quoMessageId: m.id } });
    if (!msg) return;
    await db.message.update({ where: { id: msg.id }, data: { status } });
    if (status === "failed" && msg.enrollmentId) {
      const { recordDeliveryFailure } = await import("./sequences");
      await recordDeliveryFailure(msg.enrollmentId);
    }
  }
}

export async function handleInbound(input: { quoId: string | null; from: string; body: string }) {
  const phone = normalizePhone(input.from);
  if (!phone) return;
  if (input.quoId && (await db.message.findUnique({ where: { quoMessageId: input.quoId } }))) return; // duplicate delivery

  const customer = await db.customer.findFirst({ where: { phone }, orderBy: { createdAt: "asc" } });
  if (!customer) {
    // Not a customer in the CRM: don't create anything (leads come from the website form, booking and staff).
    // Just let the team know so someone can answer it in Quo.
    await db.$transaction((tx) =>
      enqueueDiscord(tx, { content: `💬 Text from a number not in the CRM, ${formatPhone(phone)}: "${input.body.slice(0, 500)}" (answer it in Quo)` }),
    );
    await flushOutboxSoon();
    return;
  }
  const lead = await db.lead.findFirst({ where: { customerId: customer.id }, orderBy: { lastActivityAt: "desc" } });
  await db.message.create({
    data: { customerId: customer.id, leadId: lead?.id ?? null, direction: "in", body: input.body, status: "received", quoMessageId: input.quoId },
  });

  const word = input.body.trim().toLowerCase();
  const { stopEnrollments } = await import("./sequences");
  const system = { kind: "system" as const, label: "Text message" };
  if (STOP_WORDS.includes(word)) {
    await db.customer.update({ where: { id: customer.id }, data: { smsOptOut: true } });
    await stopEnrollments({ customerId: customer.id }, "opted out");
    await db.$transaction((tx) =>
      recordActivity(tx, system, { type: "sms_opt_out", leadId: lead?.id, customerId: customer.id, body: "Customer replied STOP" }),
    );
    return;
  }
  if (START_WORDS.includes(word) && customer.smsOptOut) {
    await db.customer.update({ where: { id: customer.id }, data: { smsOptOut: false } });
  }

  await stopEnrollments({ customerId: customer.id }, "customer replied");
  const urgent = URGENT.test(input.body);
  await db.$transaction(async (tx) => {
    await recordActivity(tx, system, { type: "sms_received", leadId: lead?.id, customerId: customer.id, body: input.body });
    await enqueueDiscord(tx, {
      content: `${urgent ? "🚨 URGENT text" : "💬 Text"} from ${customer.name} (${formatPhone(phone)}): "${input.body.slice(0, 500)}"${lead ? `\n${appUrl()}/leads/${lead.id}` : ""}`,
    });
  });
  await flushOutboxSoon();
  if (urgent) await alertOwner(`URGENT text from ${customer.name}: "${input.body.slice(0, 200)}"`);
}
