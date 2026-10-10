import { timingSafeEqual } from "node:crypto";
import { mapJotform, RateLimitedError, submitWebLead } from "@/lib/services/intake";
import { ValidationError } from "@/lib/services/actor";

// Jotform → Settings → Integrations → WebHooks:
//   https://app.cincydegreeofcomfort.com/api/intake/jotform?secret=INTAKE_WEBHOOK_SECRET
// Jotform doesn't sign webhooks, so the shared secret in the URL is the authentication.

function secretOk(given: string | null): boolean {
  const expected = process.env.INTAKE_WEBHOOK_SECRET;
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  if (!secretOk(new URL(req.url).searchParams.get("secret"))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let answers: Record<string, unknown> = {};
  try {
    const form = await req.formData();
    const rawRequest = form.get("rawRequest");
    answers = typeof rawRequest === "string" ? JSON.parse(rawRequest) : Object.fromEntries(form.entries());
  } catch {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }

  try {
    const lead = await submitWebLead(mapJotform(answers), {
      ip: typeof answers.ip === "string" ? answers.ip : null,
      userAgent: null,
      form: "jotform",
    });
    return Response.json({ ok: true, leadId: lead.id });
  } catch (err) {
    if (err instanceof ValidationError || err instanceof RateLimitedError) {
      // 200 so Jotform doesn't retry a submission that will never succeed.
      return Response.json({ ok: false, error: err.message });
    }
    throw err;
  }
}
