import { getCurrentUser } from "@/lib/session";
import { getProposalPdf } from "@/lib/pdf";
import { getProposal } from "@/lib/services/proposals";

export const maxDuration = 60;

// Staff download of any option (drafts included). Not cached: drafts change.
export async function GET(req: Request, ctx: RouteContext<"/proposals/[id]/pdf">) {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  const p = await getProposal(user, id).catch(() => null);
  const optionId = new URL(req.url).searchParams.get("option");
  const option = p?.options.find((o) => o.id === optionId);
  if (!p || !option) return new Response("Not found", { status: 404 });
  const pdf = await getProposalPdf(p.id, option.id, { cache: false });
  return new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="proposal-v${p.version}-${option.tier}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
