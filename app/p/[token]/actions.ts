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
