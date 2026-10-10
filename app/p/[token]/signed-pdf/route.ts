import { cookies } from "next/headers";
import { clientUrl } from "@/lib/env";
import { db } from "@/lib/db";
import { getBlobStore } from "@/lib/integrations/blob";
import { gateCookieName, gateCookieValid, loadByToken } from "@/lib/services/client-proposals";

// The Documenso-sealed PDF (includes the signing certificate).
export async function GET(req: Request, ctx: RouteContext<"/p/[token]/signed-pdf">) {
  const { token } = await ctx.params;
  const p = await loadByToken(token);
  if (!p || p.lockedAt) return new Response("Not found", { status: 404 });
  if (!gateCookieValid(p.id, token, (await cookies()).get(gateCookieName(p.id))?.value)) {
    return Response.redirect(`${clientUrl()}/p/${token}`, 303);
  }
  const sig = await db.signature.findUnique({ where: { proposalId: p.id } });
  const file = sig?.signedPdfPath ? await getBlobStore().get(sig.signedPdfPath) : null;
  if (!file) return new Response("The signed copy isn't ready yet. Please try again in a minute.", { status: 404 });
  return new Response(new Uint8Array(file.body), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="Degree-of-Comfort-signed-proposal-v${p.version}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
