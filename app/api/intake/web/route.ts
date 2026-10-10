import { RateLimitedError, submitWebLead, verifyTurnstile } from "@/lib/services/intake";
import { ValidationError } from "@/lib/services/actor";
import { z } from "zod";

// Public endpoint for the lead form on cincydegreeofcomfort.com.
// Accepts JSON (fetch) or a plain HTML form post. See docs/website-form.html.

function allowedOrigins(): string[] {
  return (process.env.INTAKE_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !allowedOrigins().includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin",
  };
}

export function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

const field = z.string().max(5000).optional();
const body = z.object({
  name: field,
  phone: field,
  email: field,
  street: field,
  address: field,
  unit: field,
  city: field,
  zip: field,
  service: field,
  message: field,
  company_website: field, // honeypot: real people never fill this in
  "cf-turnstile-response": field,
  redirect: field,
});

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);
  if (origin && !headers["access-control-allow-origin"]) {
    return Response.json({ error: "Origin not allowed" }, { status: 403 });
  }

  const isJson = (req.headers.get("content-type") ?? "").includes("application/json");
  let raw: Record<string, unknown>;
  try {
    raw = isJson ? await req.json() : Object.fromEntries((await req.formData()).entries());
  } catch {
    return Response.json({ error: "Invalid body" }, { status: 400, headers });
  }
  const parsed = body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: "Invalid form" }, { status: 400, headers });
  const f = parsed.data;

  // Where a plain HTML form goes afterwards: only back to an allowed origin.
  const back = (status: "ok" | "error", message?: string) => {
    if (isJson) {
      return Response.json(status === "ok" ? { ok: true } : { error: message }, {
        status: status === "ok" ? 200 : 400,
        headers,
      });
    }
    const target = f.redirect && allowedOrigins().some((o) => f.redirect!.startsWith(o + "/")) ? f.redirect : null;
    if (!target) return new Response(status === "ok" ? "Thanks! We'll be in touch shortly." : (message ?? "Error"), { status: status === "ok" ? 200 : 400 });
    const u = new URL(target);
    u.searchParams.set("lead", status === "ok" ? "thanks" : "error");
    return Response.redirect(u.toString(), 303);
  };

  // Bots: pretend it worked.
  if (f.company_website) return back("ok");

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  if (!(await verifyTurnstile(f["cf-turnstile-response"], ip))) {
    return back("error", "Please complete the verification and try again.");
  }

  try {
    await submitWebLead(
      {
        name: f.name,
        phone: f.phone,
        email: f.email,
        street: f.street ?? f.address,
        unit: f.unit,
        city: f.city,
        zip: f.zip,
        service: f.service,
        message: f.message,
      },
      { ip, userAgent: req.headers.get("user-agent"), form: "website" },
    );
  } catch (err) {
    if (err instanceof RateLimitedError) return Response.json({ error: err.message }, { status: 429, headers });
    if (err instanceof ValidationError) return back("error", err.message);
    console.error("[intake/web]", err);
    return back("error", "Something went wrong. Please call us.");
  }
  return back("ok");
}
