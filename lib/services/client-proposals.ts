// Everything a customer can do on go./p/[token]. No staff session: access is the token plus the
// phone-last-4 (or email) gate, remembered by a signed cookie (SPEC.md "Security").

import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { normalizeEmail } from "@/lib/phone";
import { leadStageEmbed } from "@/lib/notifications/discord-embeds";
import type { Prisma } from "@/generated/prisma/client";
import { SYSTEM, ValidationError } from "./actor";
import { estimateNumber } from "@/lib/estimate";
import { changeStage } from "./leads";
import { alertOwner } from "./messages";
import { recordActivity } from "./activity";
import { enqueueDiscord, flushOutboxSoon } from "./outbox";

export const MAX_GATE_FAILURES = 5;
export const GATE_COOKIE_DAYS = 30;
const VIEW_ACTIVITY_GAP_MS = 30 * 60 * 1000;

const clientInclude = {
  options: { orderBy: { sortOrder: "asc" }, include: { lineItems: { orderBy: { sortOrder: "asc" } } } },
  lead: { include: { customer: true, property: true, assignedTo: { select: { name: true } } } },
  terms: true,
  milestones: { orderBy: { sortOrder: "asc" } },
} satisfies Prisma.ProposalInclude;

export type ClientProposal = Prisma.ProposalGetPayload<{ include: typeof clientInclude }>;

export type ClientState = "ok" | "expired" | "superseded" | "locked" | "signed" | "declined";

export async function loadByToken(token: string): Promise<ClientProposal | null> {
  if (!/^[A-Za-z0-9_-]{24,64}$/.test(token)) return null;
  return db.proposal.findUnique({ where: { token }, include: clientInclude });
}

export function clientState(p: ClientProposal, now = new Date()): ClientState {
  if (p.lockedAt) return "locked";
  if (p.status === "signed") return "signed";
  if (p.status === "declined") return "declined";
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

// ---- Decline / request changes ----------------------------------------------

/** Customer declines on the estimate page: estimate closed, lead → Declined (follow-up texts start), owner told. */
export async function declineEstimate(p: ClientProposal, input: { reason: string; note?: string }, meta: { ip: string | null }) {
  const reason = input.reason.trim().slice(0, 100);
  if (!reason) throw new ValidationError("Pick a reason");
  const note = input.note?.trim().slice(0, 1000) || null;
  const text = note ? `${reason}: ${note}` : reason;
  await db.$transaction(async (tx) => {
    await tx.proposal.update({ where: { id: p.id }, data: { status: "declined", declinedAt: new Date(), declineReason: text } });
    await tx.lead.update({ where: { id: p.leadId }, data: { lostReason: text.slice(0, 300) } });
    await recordActivity(tx, actor, {
      type: "estimate_declined",
      leadId: p.leadId,
      body: `Customer declined estimate ${estimateNumber(p)}: ${text}`,
      data: { proposalId: p.id, ip: meta.ip },
    });
  });
  await changeStage(actor, p.leadId, "estimate_declined");
  await alertOwner(`${p.lead.customer.name} declined estimate ${estimateNumber(p)} (${text}). ${appUrl()}/leads/${p.leadId}`);
}

/** Customer asks for changes instead of declining: logged on the lead and sent to the owner. */
export async function requestChanges(p: ClientProposal, message: string, meta: { ip: string | null }) {
  const text = message.trim().slice(0, 2000);
  if (text.length < 3) throw new ValidationError("Tell us what you'd like changed");
  await db.$transaction(async (tx) => {
    await recordActivity(tx, actor, {
      type: "change_requested",
      leadId: p.leadId,
      body: `Change request on estimate ${estimateNumber(p)}: ${text}`,
      data: { proposalId: p.id, ip: meta.ip },
    });
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: p.leadId }, include: { customer: true, property: true, assignedTo: { select: { name: true } } } });
    const embed = leadStageEmbed(lead);
    embed.embeds![0]!.title = `Change request on estimate ${estimateNumber(p)}: ${lead.title}`;
    embed.embeds![0]!.description = text.slice(0, 1000);
    await enqueueDiscord(tx, embed);
  });
  await flushOutboxSoon();
  await alertOwner(`${p.lead.customer.name} asked for changes to estimate ${estimateNumber(p)}: "${text.slice(0, 300)}" ${appUrl()}/leads/${p.leadId}`);
}

// ---- "Present to customer": staff open the proposal on their own device without the phone check ----

const PRESENT_LINK_TTL_MS = 10 * 60_000;
const PRESENT_SESSION_HOURS = 12;

function presentSig(kind: "link" | "session", proposalId: string, userId: string, exp: number) {
  return createHmac("sha256", secret()).update(`present-${kind}:${proposalId}:${userId}:${exp}`).digest("base64url");
}

/** One-time-ish link (10 minutes) the CRM hands to a signed-in staff member. */
export function presentLinkToken(proposalId: string, userId: string) {
  const exp = Date.now() + PRESENT_LINK_TTL_MS;
  return `${userId}.${exp}.${presentSig("link", proposalId, userId, exp)}`;
}

function verify(kind: "link" | "session", proposalId: string, value: string | undefined): string | null {
  const [userId, expStr, sig] = (value ?? "").split(".");
  const exp = Number(expStr);
  if (!userId || !sig || !Number.isFinite(exp) || exp < Date.now()) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(presentSig(kind, proposalId, userId, exp));
  return a.length === b.length && timingSafeEqual(a, b) ? userId : null;
}

export function verifyPresentLink(proposalId: string, t: string | null) {
  return verify("link", proposalId, t ?? undefined);
}

export function presentCookieName(proposalId: string) {
  return `doc_present_${proposalId}`;
}

export function presentCookieValue(proposalId: string, userId: string) {
  const exp = Date.now() + PRESENT_SESSION_HOURS * 3_600_000;
  return { value: `${userId}.${exp}.${presentSig("session", proposalId, userId, exp)}`, maxAge: PRESENT_SESSION_HOURS * 3600 };
}

/** The staff user presenting on this device, if any. */
export async function presenterFor(proposalId: string, cookieValue: string | undefined) {
  const userId = verify("session", proposalId, cookieValue);
  if (!userId) return null;
  return db.user.findFirst({ where: { id: userId, active: true }, select: { id: true, name: true } });
}

export async function recordPresented(p: ClientProposal, user: { id: string; name: string }) {
  await db.$transaction((tx) =>
    recordActivity(tx, { kind: "user", id: user.id, role: "tech", name: user.name, email: "" }, {
      type: "proposal_presented",
      leadId: p.leadId,
      body: `Opened the proposal to show the customer in person`,
      data: { proposalId: p.id },
    }),
  );
}
