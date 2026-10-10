// Acorn Finance status emails → lead activity (SPEC.md "Financing (Acorn Finance)").
// Acorn has no API for contractors; its notification emails are forwarded to /api/webhooks/financing.

import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { formatCents } from "@/lib/money";
import { normalizeEmail } from "@/lib/phone";
import { extractFinancingEmail, type FinancingEmail } from "@/lib/integrations/claude-text";
import { SYSTEM } from "./actor";
import { recordActivity } from "./activity";
import { enqueueDiscord, flushOutboxSoon } from "./outbox";
import { alertOwner } from "./messages";

/** Pulls subject + text out of Resend / Postmark / Zapier inbound payloads. */
export function inboundEmailText(payload: Record<string, unknown>): { subject: string; text: string } {
  const p = (payload.data as Record<string, unknown> | undefined) ?? payload;
  const pick = (...keys: string[]) => keys.map((k) => p[k]).find((v): v is string => typeof v === "string" && v.trim().length > 0) ?? "";
  const subject = pick("subject", "Subject");
  let text = pick("text", "TextBody", "body_plain", "plain", "body");
  if (!text) {
    const html = pick("html", "HtmlBody", "body_html");
    text = html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  }
  return { subject, text };
}

export async function handleFinancingEmail(payload: Record<string, unknown>, extract: (s: string, t: string) => Promise<FinancingEmail> = extractFinancingEmail) {
  const { subject, text } = inboundEmailText(payload);
  if (!text && !subject) return { matched: false, reason: "empty email" };
  const info = await extract(subject, text);
  if (!info.isFinancingUpdate) return { matched: false, reason: "not a financing update" };

  const email = normalizeEmail(info.customerEmail);
  const customer =
    (email && (await db.customer.findFirst({ where: { email } }))) ||
    (info.customerName && (await db.customer.findFirst({ where: { name: { equals: info.customerName, mode: "insensitive" } } }))) ||
    null;
  const lead = customer ? await db.lead.findFirst({ where: { customerId: customer.id }, orderBy: { lastActivityAt: "desc" } }) : null;
  const amount = info.amountDollars != null ? formatCents(Math.round(info.amountDollars * 100)) : null;
  const label = `Financing ${info.status}${amount ? ` (${amount})` : ""}`;

  await db.$transaction(async (tx) => {
    await recordActivity(tx, SYSTEM("Acorn Finance"), {
      type: "financing",
      leadId: lead?.id ?? null,
      customerId: customer?.id ?? null,
      body: `${label}: ${info.summary}`,
      data: { status: info.status, amountDollars: info.amountDollars, subject, raw: text.slice(0, 5000) },
    });
    await enqueueDiscord(tx, {
      content: `💳 ${label} for ${info.customerName ?? info.customerEmail ?? "unknown customer"}${lead ? `: ${appUrl()}/leads/${lead.id}` : " (no matching lead found)"}${
        info.status === "funded" ? "\nFunded: record the deposit as paid by financing on the proposal." : ""
      }`,
    });
  });
  await flushOutboxSoon();
  if (info.status === "funded") await alertOwner(`Acorn funded ${info.customerName ?? "a customer"}${amount ? ` (${amount})` : ""}. Record the deposit as financing.`);
  return { matched: Boolean(lead), status: info.status };
}
