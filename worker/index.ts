// `npm run worker`: runs the scheduler every minute. Use this locally or on a host without
// Vercel Cron (e.g. a Railway worker service). On Vercel, /api/cron/tick does the same job.
import "dotenv/config";
import { runTick } from "@/lib/jobs/tick";

const INTERVAL_MS = 60_000;
let stopping = false;

async function loop() {
  while (!stopping) {
    const started = Date.now();
    try {
      const result = await runTick();
      if (result.followUp || result.lost || result.outbox.sent || result.outbox.failed) {
        console.log(new Date().toISOString(), JSON.stringify(result));
      }
    } catch (err) {
      console.error("[worker] tick failed", err);
    }
    await new Promise((r) => setTimeout(r, Math.max(0, INTERVAL_MS - (Date.now() - started))));
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopping = true;
    process.exit(0);
  });
}

console.log("[worker] started");
void loop();
