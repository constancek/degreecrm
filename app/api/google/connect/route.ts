import { getCurrentUser } from "@/lib/session";
import { calendarConnectUrl } from "@/lib/services/visits";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.redirect(new URL("/login", req.url), 303);
  return Response.redirect(calendarConnectUrl(user), 303);
}
