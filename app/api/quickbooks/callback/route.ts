import { getCurrentUser } from "@/lib/session";
import { completeConnection, stateValid } from "@/lib/services/quickbooks-auth";
import { appUrl } from "@/lib/env";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (q: string) => Response.redirect(`${appUrl()}/settings?quickbooks=${q}#integrations`, 303);
  const user = await getCurrentUser();
  if (!user || user.role !== "owner") return back("forbidden");
  if (url.searchParams.get("error")) return back("cancelled");
  const code = url.searchParams.get("code");
  const realmId = url.searchParams.get("realmId");
  if (!code || !realmId || !stateValid(url.searchParams.get("state"))) return back("invalid");
  try {
    await completeConnection(code, realmId);
    return back("connected");
  } catch (err) {
    console.error("[qbo connect]", err);
    return back("failed");
  }
}
