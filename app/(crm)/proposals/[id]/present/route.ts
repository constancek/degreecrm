import { getCurrentUser } from "@/lib/session";
import { clientUrl } from "@/lib/env";
import { getProposal, sendProposal } from "@/lib/services/proposals";
import { presentLinkToken } from "@/lib/services/client-proposals";

// Staff "Present to customer": open the client page on this device without the phone check.
export async function GET(req: Request, ctx: RouteContext<"/proposals/[id]/present">) {
  const user = await getCurrentUser();
  if (!user) return Response.redirect(new URL("/login", req.url), 303);
  const { id } = await ctx.params;
  let p = await getProposal(user, id).catch(() => null);
  // On site: presenting a finished draft finalizes it (no text to the customer), so it can be signed now.
  if (p?.status === "draft") {
    p = await sendProposal(user, id, { textCustomer: false })
      .then(() => getProposal(user, id))
      .catch(() => p);
  }
  if (!p?.token || p.status === "draft" || p.status === "superseded") return Response.redirect(new URL(`/proposals/${id}`, req.url), 303);
  return Response.redirect(`${clientUrl()}/p/${p.token}/present?t=${encodeURIComponent(presentLinkToken(p.id, user.id))}`, 303);
}
