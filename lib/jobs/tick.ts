import { db } from "@/lib/db";
import { PRE_SALE_STAGES } from "@/lib/stages";
import { SYSTEM } from "@/lib/services/actor";
import { changeStage } from "@/lib/services/leads";
import { processOutbox } from "@/lib/services/outbox";

const HOUR = 3_600_000;
const automation = SYSTEM("Automation");

/** `new` → `follow_up` when no estimate is booked within 24 h. */
async function autoFollowUp(now: Date) {
  const due = await db.lead.findMany({
    where: { stage: "new", stageChangedAt: { lte: new Date(now.getTime() - 24 * HOUR) } },
    select: { id: true },
    take: 100,
  });
  for (const { id } of due) await changeStage(automation, id, "follow_up");
  return due.length;
}

/** Pre-sale leads with no activity for 60 days → `lost`. */
async function autoLost(now: Date) {
  const due = await db.lead.findMany({
    where: { stage: { in: PRE_SALE_STAGES }, lastActivityAt: { lte: new Date(now.getTime() - 60 * 24 * HOUR) } },
    select: { id: true },
    take: 100,
  });
  for (const { id } of due) await changeStage(automation, id, "lost", { lostReason: "No activity for 60 days" });
  return due.length;
}

/** One scheduler pass. Safe to run concurrently and as often as every minute. */
export async function runTick(now = new Date()) {
  const followUp = await autoFollowUp(now);
  const lost = await autoLost(now);
  const outbox = await processOutbox(50);
  return { followUp, lost, outbox };
}
