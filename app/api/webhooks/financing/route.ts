import { timingSafeEqual } from "node:crypto";
import { handleFinancingEmail } from "@/lib/services/financing";

export const maxDuration = 60;

// Inbound email (Resend / Postmark inbound, or a Zapier Gmail trigger) for financing@…:
//   POST https://app.cincydegreeofcomfort.com/api/webhooks/financing?secret=FINANCING_WEBHOOK_SECRET
function secretOk(given: string | null) {
  const expected = process.env.FINANCING_WEBHOOK_SECRET || process.env.INTAKE_WEBHOOK_SECRET;
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  if (!secretOk(new URL(req.url).searchParams.get("secret"))) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const type = req.headers.get("content-type") ?? "";
  const payload = type.includes("application/json")
    ? ((await req.json().catch(() => ({}))) as Record<string, unknown>)
    : Object.fromEntries((await req.formData()).entries());
  try {
    return Response.json({ ok: true, ...(await handleFinancingEmail(payload as Record<string, unknown>)) });
  } catch (err) {
    console.error("[financing]", err);
    return Response.json({ ok: false }, { status: 500 });
  }
}
