import { getCurrentUser } from "@/lib/session";
import { calendarStateUser, completeCalendarConnect } from "@/lib/services/visits";
import { appUrl } from "@/lib/env";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (q: string) => Response.redirect(`${appUrl()}/settings?calendar=${q}#calendar`, 303);
  const user = await getCurrentUser();
  const stateUser = calendarStateUser(url.searchParams.get("state"));
  if (!user || !stateUser || stateUser !== user.id) return back("invalid");
  if (url.searchParams.get("error")) return back("cancelled");
  const code = url.searchParams.get("code");
  if (!code) return back("invalid");
  try {
    await completeCalendarConnect(user.id, code);
    return back("connected");
  } catch (err) {
    console.error("[gcal connect]", err);
    return back("failed");
  }
}
