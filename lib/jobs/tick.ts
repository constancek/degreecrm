import { db } from "@/lib/db";
import { PRE_SALE_STAGES } from "@/lib/stages";
import { SYSTEM } from "@/lib/services/actor";
import { changeStage } from "@/lib/services/leads";
import { processOutbox } from "@/lib/services/outbox";
import { ensureDefaultSequences, processDueEnrollments } from "@/lib/services/sequences";
import { pollCalendars, syncPendingVisits } from "@/lib/services/visits";
import { pollInvoices, requestReviews } from "@/lib/services/jobs";
import { refreshTokens } from "@/lib/services/quickbooks-auth";
import { pollDepositInvoices, pollServiceFeeInvoices } from "@/lib/services/payments";
import { retrySignedCopies } from "@/lib/services/signing";

const HOUR = 3_600_000;
const automation = SYSTEM("Automation");

/** Hours a new request can sit before it moves to "Needs scheduling" (and the booking texts start). */
export const NEEDS_SCHEDULING_AFTER_HOURS = 4;

/**
 * `new` → `follow_up` ("Needs scheduling") when nothing is booked within 4 hours. Requests where the customer
 * already picked arrival windows stay in New request until the owner confirms or declines them.
 */
async function autoFollowUp(now: Date) {
  const due = await db.lead.findMany({
    where: {
      stage: "new",
      stageChangedAt: { lte: new Date(now.getTime() - NEEDS_SCHEDULING_AFTER_HOURS * HOUR) },
      visits: { none: { kind: "estimate", status: { not: "cancelled" } } },
      bookings: { none: { status: "pending" } },
    },
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

/** Intuit refresh tokens expire after ~100 days unused; refresh once a day. */
async function keepQuickBooksAlive(now: Date) {
  if (now.getUTCHours() !== 9 || now.getUTCMinutes() !== 0) return false;
  await refreshTokens({ force: true });
  return true;
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | string> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[tick:${name}]`, err);
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** One scheduler pass. Safe to run concurrently and as often as every minute. Steps fail independently. */
export async function runTick(now = new Date()) {
  await step("sequences-init", ensureDefaultSequences);
  return {
    followUp: await step("followUp", () => autoFollowUp(now)),
    lost: await step("lost", () => autoLost(now)),
    texts: await step("texts", () => processDueEnrollments(now)),
    calendarPush: await step("calendarPush", () => syncPendingVisits()),
    calendarPoll: await step("calendarPoll", () => pollCalendars(now)),
    invoices: await step("invoices", () => (now.getUTCMinutes() % 10 === 0 ? pollInvoices() : Promise.resolve(0))),
    serviceFees: await step("serviceFees", () => (now.getUTCMinutes() % 10 === 5 ? pollServiceFeeInvoices() : Promise.resolve(0))),
    depositInvoices: await step("depositInvoices", () => (now.getUTCMinutes() % 10 === 2 ? pollDepositInvoices() : Promise.resolve(0))),
    reviews: await step("reviews", () => requestReviews(now)),
    signedCopies: await step("signedCopies", () => retrySignedCopies()),
    quickbooks: await step("quickbooks", () => keepQuickBooksAlive(now)),
    outbox: await step("outbox", () => processOutbox(50)),
  };
}
