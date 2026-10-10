// Host-based routing (SPEC.md "Domains"): app. serves the CRM, go. serves client pages only.

export type Site = "app" | "client" | "unknown";

export function hostnameOf(hostHeader: string | null | undefined): string {
  return (hostHeader ?? "").toLowerCase().replace(/:\d+$/, "");
}

export function classifySite(
  hostname: string,
  env: { APP_HOST?: string; CLIENT_HOST?: string } = { APP_HOST: process.env.APP_HOST, CLIENT_HOST: process.env.CLIENT_HOST },
): Site {
  const app = env.APP_HOST?.toLowerCase();
  const client = env.CLIENT_HOST?.toLowerCase();
  if (client && hostname === client) return "client";
  if (app && hostname === app) return "app";
  // Vercel preview / default deployment URLs act as the CRM.
  if (hostname.endsWith(".vercel.app")) return "app";
  return "unknown";
}

/** Paths the client host (go.) may serve. Everything else 404s there. */
export function isClientPath(pathname: string): boolean {
  return (
    pathname.startsWith("/p/") ||
    pathname.startsWith("/terms/") ||
    pathname === "/book" ||
    pathname === "/privacy" ||
    pathname === "/terms-of-service" ||
    pathname.startsWith("/brand/") ||
    // Test-only stand-ins (404 unless MOCK_INTEGRATIONS=1).
    pathname.startsWith("/api/dev/") ||
    pathname === "/robots.txt"
  );
}
