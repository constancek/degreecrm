import { NextResponse } from "next/server";
import { clientUrl } from "@/lib/env";
import {
  GATE_COOKIE_DAYS,
  gateCookieName,
  gateCookieValue,
  loadByToken,
  presentCookieName,
  presentCookieValue,
  presenterFor,
  recordPresented,
  verifyPresentLink,
} from "@/lib/services/client-proposals";

// Lands here from the CRM's "Present to customer" link (10-minute pass) and opens the proposal.
export async function GET(req: Request, ctx: RouteContext<"/p/[token]/present">) {
  const { token } = await ctx.params;
  // Build from the configured client host: behind the proxy, req.url can carry the internal host.
  const back = new URL(`${clientUrl()}/p/${token}`);
  const p = await loadByToken(token);
  if (!p) return NextResponse.redirect(back, 303);
  const userId = verifyPresentLink(p.id, new URL(req.url).searchParams.get("t"));
  if (!userId) return NextResponse.redirect(back, 303); // expired: the normal phone check shows instead

  const res = NextResponse.redirect(back, 303);
  const opts = { httpOnly: true, secure: process.env.NODE_ENV === "production" && back.protocol === "https:", sameSite: "lax" as const, path: `/p/${token}` };
  res.cookies.set(gateCookieName(p.id), gateCookieValue(p.id, token), { ...opts, maxAge: GATE_COOKIE_DAYS * 86_400 });
  const session = presentCookieValue(p.id, userId);
  res.cookies.set(presentCookieName(p.id), session.value, { ...opts, maxAge: session.maxAge });
  const presenter = await presenterFor(p.id, session.value);
  if (presenter) await recordPresented(p, presenter);
  return res;
}
