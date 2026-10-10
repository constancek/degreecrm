import { getCurrentUser } from "@/lib/session";
import { authorizeUrl } from "@/lib/services/quickbooks-auth";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "owner") return Response.redirect(new URL("/settings", req.url), 303);
  return Response.redirect(authorizeUrl(), 303);
}
