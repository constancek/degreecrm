import { handleQuoEvent, verifyQuoSignature } from "@/lib/services/messages";

// Quo → Webhooks: URL https://app.cincydegreeofcomfort.com/api/webhooks/quo, events message.received /
// message.delivered / message.failed. Signing secret = QUO_WEBHOOK_SECRET.
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyQuoSignature(req.headers.get("openphone-signature"), raw, process.env.QUO_WEBHOOK_SECRET)) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }
  let body: { object?: unknown; type?: string; data?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  // Quo wraps the event in { object: { type, data } }.
  const event = (body.object && typeof body.object === "object" ? body.object : body) as Parameters<typeof handleQuoEvent>[0];
  await handleQuoEvent(event);
  return Response.json({ ok: true });
}
