import { getCurrentUser } from "@/lib/session";
import { clientUrl } from "@/lib/env";
import { getProposal } from "@/lib/services/proposals";
import { presentLinkToken } from "@/lib/services/client-proposals";

// Staff "Present to customer": open the client page on this device without the phone check.
export async function GET(req: Request, ctx: RouteContext<"/proposals/[id]/present">) {
  const user = await getCurrentUser();
  if (!user) return Response.redirect(new URL("/login", req.url), 303);
  const { id } = await ctx.params;
  const p = await getProposal(user, id).catch(() => null);
  if (!p?.token || p.status === "draft" || p.status === "superseded") return Response.redirect(new URL(`/proposals/${id}`, req.url), 303);
  return Response.redirect(`${clientUrl()}/p/${p.token}/present?t=${encodeURIComponent(presentLinkToken(p.id, user.id))}`, 303);
}
