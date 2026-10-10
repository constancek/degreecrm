import { cookies } from "next/headers";
import { clientUrl } from "@/lib/env";
import { getProposalPdf } from "@/lib/pdf";
import { clientState, gateCookieName, gateCookieValid, loadByToken } from "@/lib/services/client-proposals";

export const maxDuration = 60;

// Customer download: the selected option only (SPEC.md "PDF download").
export async function GET(_req: Request, ctx: RouteContext<"/p/[token]/pdf">) {
  const { token } = await ctx.params;
  const p = await loadByToken(token);
  if (!p || clientState(p) === "locked") return new Response("Not found", { status: 404 });
  const cookie = (await cookies()).get(gateCookieName(p.id))?.value;
  if (!gateCookieValid(p.id, token, cookie)) return Response.redirect(`${clientUrl()}/p/${token}`, 303);
  if (!p.selectedOptionId) return new Response("Choose an option first, then download the PDF.", { status: 409 });

  const pdf = await getProposalPdf(p.id, p.selectedOptionId, { cache: true });
  return new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="Degree-of-Comfort-proposal-v${p.version}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
