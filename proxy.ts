import { NextResponse, type NextRequest } from "next/server";
import { classifySite, hostnameOf, isClientPath } from "@/lib/hosts";

// Nothing on any host should be indexed: the CRM is behind login and client pages are private links.
const NOINDEX = { "X-Robots-Tag": "noindex, nofollow, noarchive" };

// Common spellings of the public policy pages (any capitalization, trailing slash) → the real path.
const POLICY_ALIASES: Record<string, string> = {
  "/privacy": "/privacy",
  "/privacy-policy": "/privacy",
  "/privacypolicy": "/privacy",
  "/terms": "/terms-of-service",
  "/tos": "/terms-of-service",
  "/terms-of-service": "/terms-of-service",
  "/termsofservice": "/terms-of-service",
  "/terms-and-conditions": "/terms-of-service",
};

export function proxy(request: NextRequest) {
  const site = classifySite(hostnameOf(request.headers.get("host")));
  const { pathname } = request.nextUrl;

  const alias = site !== "unknown" ? POLICY_ALIASES[pathname.toLowerCase().replace(/\/+$/, "")] : undefined;
  if (alias && alias !== pathname) {
    // Build from the Host header so the redirect stays on the host the visitor used.
    return NextResponse.redirect(`${request.nextUrl.protocol}//${request.headers.get("host")}${alias}${request.nextUrl.search}`, 308);
  }

  if (site === "client") {
    if (pathname === "/robots.txt") {
      return new NextResponse("User-agent: *\nDisallow: /\n", {
        headers: { "content-type": "text/plain", ...NOINDEX },
      });
    }
    if (!isClientPath(pathname)) return new NextResponse("Not found", { status: 404, headers: NOINDEX });
  } else if (site === "app") {
    // Client pages live on go. only.
    if (pathname.startsWith("/p/")) return new NextResponse("Not found", { status: 404, headers: NOINDEX });
  } else {
    return new NextResponse("Not found", { status: 404, headers: NOINDEX });
  }

  const res = NextResponse.next();
  for (const [k, v] of Object.entries(NOINDEX)) res.headers.set(k, v);
  // Only the booking form may be embedded, and only on our own website(s). Everything else: no framing.
  const allowed = (process.env.INTAKE_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean).join(" ");
  res.headers.set("Content-Security-Policy", pathname === "/book" ? `frame-ancestors 'self' ${allowed}` : "frame-ancestors 'none'");
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
