import { mockIntegrations } from "@/lib/env";

// Stands in for Intuit's card tokenization endpoint when MOCK_INTEGRATIONS=1 (tests).
export async function POST(req: Request) {
  if (!mockIntegrations()) return new Response("Not found", { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { card?: { number?: string } };
  const number = body.card?.number?.replace(/\D/g, "") ?? "";
  if (number.length < 13) return Response.json({ errors: [{ message: "card number is invalid" }] }, { status: 400 });
  return Response.json({ value: number.endsWith("0002") ? "tok_declined" : `tok_${Date.now()}` }, { status: 201 });
}
