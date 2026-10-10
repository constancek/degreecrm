import { runTick } from "@/lib/jobs/tick";

export const maxDuration = 60;

// Vercel Cron calls this with "Authorization: Bearer $CRON_SECRET" (see vercel.json).
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return Response.json(await runTick());
}
