import { db } from "@/lib/db";
import { tradeLabel } from "@/lib/stages";
import type { Trade } from "@/generated/prisma/enums";
import { SYSTEM, ValidationError } from "./actor";
import { createLead } from "./leads";

export type WebLeadInput = {
  name?: string;
  phone?: string;
  email?: string;
  street?: string;
  unit?: string;
  city?: string;
  zip?: string;
  service?: string;
  message?: string;
};

export type IntakeMeta = { ip: string | null; userAgent: string | null; form: string; raw?: unknown };

export class RateLimitedError extends Error {}

/** Map free text like "Plumbing - leaky faucet" to a trade. Defaults to HVAC. */
export function guessTrade(...texts: (string | undefined)[]): Trade {
  const t = texts.join(" ").toLowerCase();
  if (/plumb|drain|water heater|leak|toilet|faucet|sewer|pipe/.test(t)) return "plumbing";
  if (/electric|panel|outlet|breaker|wiring|generator|ev charger|light/.test(t)) return "electrical";
  return "hvac";
}

const MAX_PER_IP_PER_HOUR = 5;

export async function submitWebLead(input: WebLeadInput, meta: IntakeMeta) {
  const name = input.name?.trim();
  if (!name) throw new ValidationError("Please enter your name");
  if (!input.phone?.trim() && !input.email?.trim()) throw new ValidationError("Please enter a phone number or email");

  if (meta.ip) {
    const recent = await db.activity.count({
      where: {
        type: "web_form",
        createdAt: { gte: new Date(Date.now() - 3_600_000) },
        data: { path: ["ip"], equals: meta.ip },
      },
    });
    if (recent >= MAX_PER_IP_PER_HOUR) throw new RateLimitedError("Too many submissions. Please call us instead.");
  }

  const trade = guessTrade(input.service, input.message);
  const message = input.message?.trim();
  const title = (message ? message.split(/\n/)[0]!.slice(0, 80) : "") || `${tradeLabel(trade)} request from website`;

  const actor = SYSTEM(meta.form === "jotform" ? "Jotform" : "Website form");
  const lead = await createLead(actor, {
    customer: { name, phone: input.phone, email: input.email },
    property: input.street?.trim()
      ? { street: input.street, unit: input.unit, city: input.city, zip: input.zip }
      : undefined,
    title,
    trade,
    source: "web_form",
    notes: [input.service && `Service: ${input.service}`, message].filter(Boolean).join("\n\n") || undefined,
  });

  await db.activity.create({
    data: {
      type: "web_form",
      leadId: lead.id,
      customerId: lead.customerId,
      body: message ?? null,
      data: { ip: meta.ip, userAgent: meta.userAgent, form: meta.form, system: actor.kind === "system" ? actor.label : undefined },
    },
  });
  return lead;
}

/** Cloudflare Turnstile check; skipped when TURNSTILE_SECRET_KEY isn't set. */
export async function verifyTurnstile(token: string | undefined, ip: string | null): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (!token) return false;
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
  });
  const data = (await res.json().catch(() => ({}))) as { success?: boolean };
  return data.success === true;
}

/**
 * Jotform sends answers keyed like "q3_fullName", "q4_phoneNumber" with nested objects.
 * Match by what the field name contains so the form can be edited without a deploy.
 */
export function mapJotform(raw: Record<string, unknown>): WebLeadInput {
  const out: WebLeadInput = {};
  for (const [key, value] of Object.entries(raw)) {
    const k = key.replace(/^q\d+_/, "").toLowerCase();
    if (value == null || value === "") continue;
    const obj = typeof value === "object" ? (value as Record<string, string>) : null;
    const text = obj ? "" : String(value);

    if (k.includes("name") && !out.name) {
      out.name = obj ? [obj.first, obj.last].filter(Boolean).join(" ") : text;
    } else if (k.includes("phone")) {
      out.phone = obj ? (obj.full ?? [obj.area, obj.phone].filter(Boolean).join("")) : text;
    } else if (k.includes("email")) {
      out.email = text;
    } else if (k.includes("address")) {
      if (obj) {
        out.street = obj.addr_line1;
        out.unit = obj.addr_line2 || undefined;
        out.city = obj.city;
        out.zip = obj.postal;
      } else {
        out.street = text;
      }
    } else if (/service|trade|type|help/.test(k)) {
      out.service = Array.isArray(value) ? value.join(", ") : text;
    } else if (/message|describe|detail|comment|issue|problem/.test(k)) {
      out.message = text;
    }
  }
  return out;
}
