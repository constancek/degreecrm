// Everything a customer can do on go./p/[token]. No staff session: access is the token plus the
// phone-last-4 (or email) gate, remembered by a signed cookie (SPEC.md "Security").

import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { normalizeEmail } from "@/lib/phone";
import { leadStageEmbed } from "@/lib/notifications/discord-embeds";
import type { Prisma } from "@/generated/prisma/client";
import { SYSTEM } from "./actor";
import { recordActivity } from "./activity";
import { enqueueDiscord, flushOutboxSoon } from "./outbox";

export const MAX_GATE_FAILURES = 5;
export const GATE_COOKIE_DAYS = 30;
const VIEW_ACTIVITY_GAP_MS = 30 * 60 * 1000;

const clientInclude = {
  options: { orderBy: { sortOrder: "asc" }, include: { lineItems: { orderBy: { sortOrder: "asc" } } } },
  lead: { include: { customer: true, property: true, assignedTo: { select: { name: true } } } },
  terms: true,
} satisfies Prisma.ProposalInclude;

export type ClientProposal = Prisma.ProposalGetPayload<{ include: typeof clientInclude }>;

export type ClientState = "ok" | "expired" | "superseded" | "locked" | "signed";

export async function loadByToken(token: string): Promise<ClientProposal | null> {
  if (!/^[A-Za-z0-9_-]{24,64}$/.test(token)) return null;
  return db.proposal.findUnique({ where: { token }, include: clientInclude });
}

export function clientState(p: ClientProposal, now = new Date()): ClientState {
  if (p.lockedAt) return "locked";
  if (p.status === "signed") return "signed";
  if (p.status === "superseded") return "superseded";
  if (p.expiresAt && p.expiresAt < now) return "expired";
  return "ok";
}

const actor = SYSTEM("Customer");

// ---- Gate -------------------------------------------------------------------

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return s;
}

export function gateCookieName(proposalId: string) {
  return `doc_gate_${proposalId}`;
}

export function gateCookieValue(proposalId: string, token: string) {
  return createHmac("sha256", secret()).update(`gate:${proposalId}:${token}`).digest("base64url");
}

export function gateCookieValid(proposalId: string, token: string, value: string | undefined) {
  if (!value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(gateCookieValue(proposalId, token));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** What the customer is asked for: last 4 of the phone, or the email when there's no phone. */
export function gateKind(p: ClientProposal): "phone" | "email" {
  return p.lead.customer.phone ? "phone" : "email";
}

function answerMatches(p: ClientProposal, answer: string): boolean {
  const c = p.lead.customer;
  if (c.phone) return answer.replace(/\D/g, "") === c.phone.slice(-4);
  const email = normalizeEmail(answer);
  return Boolean(email && c.email && email === c.email.toLowerCase());
}

export type GateResult = { ok: true } | { ok: false; locked: boolean; remaining: number };

export async function checkGate(p: ClientProposal, answer: string, meta: { ip: string | null }): Promise<GateResult> {
  if (p.lockedAt) return { ok: false, locked: true, remaining: 0 };
  if (answerMatches(p, answer)) return { ok: true };

  const failures = p.gateFailures + 1;
  const locked = failures >= MAX_GATE_FAILURES;
  await db.$transaction(async (tx) => {
    await tx.proposal.update({
      where: { id: p.id },
      data: { gateFailures: failures, lockedAt: locked ? new Date() : undefined },
    });
    if (locked) {
      await recordActivity(tx, actor, {
        type: "proposal_locked",
        leadId: p.leadId,
        body: `Proposal link locked after ${MAX_GATE_FAILURES} wrong answers`,
        data: { proposalId: p.id, ip: meta.ip },
      });
      await enqueueDiscord(tx, {
        content: `⚠️ Proposal link locked after ${MAX_GATE_FAILURES} wrong answers: ${p.lead.customer.name} (${appUrl()}/leads/${p.leadId}). Send a new link if it was the customer.`,
      });
    }
  });
  if (locked) await flushOutboxSoon();
  return { ok: false, locked, remaining: Math.max(0, MAX_GATE_FAILURES - failures) };
}

// ---- Tracking ---------------------------------------------------------------

export async function recordView(p: ClientProposal, meta: { ip: string | null; userAgent: string | null }) {
  const now = new Date();
  const logActivity = !p.lastViewedAt || now.getTime() - p.lastViewedAt.getTime() > VIEW_ACTIVITY_GAP_MS;
  await db.$transaction(async (tx) => {
    await tx.proposal.update({
      where: { id: p.id },
      data: {
        viewCount: { increment: 1 },
        lastViewedAt: now,
        firstViewedAt: p.firstViewedAt ?? now,
        status: p.status === "sent" ? "viewed" : undefined,
      },
    });
    if (logActivity) {
      await recordActivity(tx, actor, {
        type: "proposal_viewed",
        leadId: p.leadId,
        data: { proposalId: p.id, version: p.version, ip: meta.ip, userAgent: meta.userAgent },
      });
    }
  });
}

export async function selectOption(p: ClientProposal, optionId: string, meta: { ip: string | null }) {
  const option = p.options.find((o) => o.id === optionId);
  if (!option) throw new Error("Unknown option");
  if (p.selectedOptionId === optionId) return;
  await db.$transaction(async (tx) => {
    await tx.proposal.update({ where: { id: p.id }, data: { selectedOptionId: optionId } });
    await recordActivity(tx, actor, {
      type: "option_selected",
      leadId: p.leadId,
      body: `Picked "${option.title}"`,
      data: { proposalId: p.id, optionId, tier: option.tier, ip: meta.ip },
    });
  });
}

export async function recordTermsAccepted(p: ClientProposal, meta: { ip: string | null; userAgent: string | null }) {
  await db.$transaction((tx) =>
    recordActivity(tx, actor, {
      type: "terms_checked",
      leadId: p.leadId,
      data: { proposalId: p.id, termsVersion: p.terms?.version ?? null, ip: meta.ip, userAgent: meta.userAgent },
    }),
  );
}

/** Expired / superseded link: tell the owner the customer wants a fresh one. */
export async function requestFreshLink(p: ClientProposal) {
  await db.$transaction(async (tx) => {
    await recordActivity(tx, actor, {
      type: "fresh_link_requested",
      leadId: p.leadId,
      body: "Customer asked for an updated proposal",
      data: { proposalId: p.id },
    });
    const lead = await tx.lead.findUniqueOrThrow({
      where: { id: p.leadId },
      include: { customer: true, property: true, assignedTo: { select: { name: true } } },
    });
    const embed = leadStageEmbed(lead);
    embed.embeds![0]!.title = `Customer wants an updated proposal: ${lead.title}`;
    await enqueueDiscord(tx, embed);
  });
  await flushOutboxSoon();
}
