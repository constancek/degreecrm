import { db } from "@/lib/db";
import { completeSigning, documensoSecretValid } from "@/lib/services/signing";

// Documenso → Settings → Webhooks: URL https://app.cincydegreeofcomfort.com/api/webhooks/documenso,
// event DOCUMENT_COMPLETED, secret = DOCUMENSO_WEBHOOK_SECRET (sent as X-Documenso-Secret).
export async function POST(req: Request) {
  if (!documensoSecretValid(req.headers.get("x-documenso-secret"))) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { event?: string; payload?: { id?: number; externalId?: string | null } };
  if (body.event !== "DOCUMENT_COMPLETED" && body.event !== "DOCUMENT_SIGNED") return Response.json({ ok: true, ignored: body.event });
  const docId = Number(body.payload?.id);
  const proposal = await db.proposal.findFirst({
    where: { OR: [...(Number.isFinite(docId) ? [{ documensoDocumentId: docId }] : []), ...(body.payload?.externalId ? [{ id: body.payload.externalId }] : [])] },
  });
  if (!proposal) return Response.json({ ok: true, matched: false });
  const done = await completeSigning(proposal.id);
  return Response.json({ ok: true, signed: done });
}
