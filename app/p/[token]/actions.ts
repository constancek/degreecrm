"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import {
  GATE_COOKIE_DAYS,
  checkGate,
  clientState,
  gateCookieName,
  gateCookieValid,
  gateCookieValue,
  loadByToken,
  recordTermsAccepted,
  requestFreshLink,
  selectOption,
} from "@/lib/services/client-proposals";
import { requestMeta } from "@/lib/server/request-meta";

export type GateState = { error?: string; locked?: boolean } | undefined;

export async function gateAction(token: string, _prev: GateState, fd: FormData): Promise<GateState> {
  const p = await loadByToken(token);
  if (!p) return { error: "This link isn't valid." };
  if (clientState(p) !== "ok") {
    revalidatePath(`/p/${token}`);
    return {};
  }
  const answer = String(fd.get("answer") ?? "");
  const result = await checkGate(p, answer, await requestMeta());
  if (!result.ok) {
    if (result.locked) {
      revalidatePath(`/p/${token}`);
      return { locked: true, error: "This link is now locked. Please call us and we'll send you a new one." };
    }
    return { error: `That doesn't match our records. ${result.remaining} attempt${result.remaining === 1 ? "" : "s"} left.` };
  }
  (await cookies()).set(gateCookieName(p.id), gateCookieValue(p.id, token), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: `/p/${token}`,
    maxAge: GATE_COOKIE_DAYS * 86_400,
  });
  revalidatePath(`/p/${token}`);
  return {};
}

/** Loads the proposal only when the caller passed the gate and the link is live. */
async function authorized(token: string) {
  const p = await loadByToken(token);
  if (!p || clientState(p) !== "ok") return null;
  const cookie = (await cookies()).get(gateCookieName(p.id))?.value;
  return gateCookieValid(p.id, token, cookie) ? p : null;
}

export async function selectOptionAction(token: string, optionId: string): Promise<{ error?: string }> {
  const p = await authorized(token);
  if (!p) return { error: "This proposal is no longer available. Please refresh the page." };
  await selectOption(p, optionId, await requestMeta());
  return {};
}

export async function termsCheckedAction(token: string): Promise<void> {
  const p = await authorized(token);
  if (p) await recordTermsAccepted(p, await requestMeta());
}

export async function freshLinkAction(token: string): Promise<{ done: boolean }> {
  const p = await loadByToken(token);
  if (!p || clientState(p) === "ok") return { done: false };
  await requestFreshLink(p);
  return { done: true };
}

// ---- Phase 3: signing + deposit ------------------------------------------------

async function authorizedAny(token: string) {
  // Signed proposals stay reachable (for the deposit step) but still require the gate.
  const p = await loadByToken(token);
  if (!p || p.lockedAt) return null;
  const cookie = (await cookies()).get(gateCookieName(p.id))?.value;
  return gateCookieValid(p.id, token, cookie) ? p : null;
}

export async function startSigningAction(
  token: string,
  input: { optionId: string; name: string; email: string; termsAccepted: boolean },
): Promise<{ url?: string; error?: string }> {
  const p = await authorized(token);
  if (!p) return { error: "This proposal is no longer available. Please refresh the page." };
  const { startSigning } = await import("@/lib/services/signing");
  const { ValidationError } = await import("@/lib/services/actor");
  const { ZodError } = await import("zod");
  try {
    return { url: await startSigning(p, { ...input, termsAccepted: input.termsAccepted as true }, await requestMeta()) };
  } catch (err) {
    if (err instanceof ZodError) return { error: err.issues[0]?.message ?? "Please check the form" };
    if (err instanceof ValidationError) return { error: err.message };
    console.error("[sign]", err);
    return { error: "We couldn't start signing just now. Please try again in a minute or call us." };
  }
}

export async function payDepositAction(token: string, cardToken: string): Promise<{ ok?: boolean; error?: string }> {
  const p = await authorizedAny(token);
  if (!p) return { error: "Please refresh the page and try again." };
  const { chargeDeposit } = await import("@/lib/services/payments");
  const { ValidationError } = await import("@/lib/services/actor");
  try {
    await chargeDeposit(p.id, cardToken, await requestMeta());
  } catch (err) {
    if (err instanceof ValidationError) return { error: err.message };
    console.error("[deposit]", err);
    return { error: "The payment didn't go through. No charge was made. Please try again or call us." };
  }
  revalidatePath(`/p/${token}`);
  return { ok: true };
}

export async function financingAction(token: string): Promise<void> {
  const p = await authorizedAny(token);
  if (!p) return;
  const { recordFinancingInterest } = await import("@/lib/services/payments");
  await recordFinancingInterest(p.id).catch((e) => console.error("[financing click]", e));
}
