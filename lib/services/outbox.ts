import { db, type Tx } from "@/lib/db";
import { DiscordError, getDiscordClient, type DiscordMessage } from "@/lib/integrations/discord";
import type { Prisma } from "@/generated/prisma/client";

const MAX_ATTEMPTS = 8;

export async function enqueueDiscord(tx: Tx, message: DiscordMessage) {
  await tx.outboxEvent.create({
    data: { channel: "discord", payload: message as Prisma.InputJsonValue },
  });
}

/**
 * Sends due outbox events. Called right after a request (via `after()`) and every minute by the
 * cron/worker, so a Discord outage only delays posts. Rows are claimed with SKIP LOCKED so
 * concurrent runs never double-send.
 */
export async function processOutbox(limit = 20): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  // Prisma stores DateTime as UTC `timestamp` without zone, so compare against UTC explicitly.
  const claimed = await db.$queryRaw<{ id: string; createdAt: Date }[]>`
    UPDATE "OutboxEvent"
    SET "nextAttemptAt" = (now() AT TIME ZONE 'UTC') + interval '2 minutes', "updatedAt" = (now() AT TIME ZONE 'UTC')
    WHERE id IN (
      SELECT id FROM "OutboxEvent"
      WHERE status = 'pending' AND "nextAttemptAt" <= (now() AT TIME ZONE 'UTC')
      ORDER BY "createdAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, "createdAt"`;
  // RETURNING has no order; post in the order events happened.
  claimed.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  for (const { id } of claimed) {
    const event = await db.outboxEvent.findUnique({ where: { id } });
    if (!event) continue;
    try {
      if (event.channel === "discord") {
        await getDiscordClient().send(event.payload as DiscordMessage);
      }
      await db.outboxEvent.update({
        where: { id },
        data: { status: "sent", sentAt: new Date(), attempts: { increment: 1 }, lastError: null },
      });
      sent++;
    } catch (err) {
      const attempts = event.attempts + 1;
      const retryMs =
        err instanceof DiscordError && err.retryAfterMs ? err.retryAfterMs : Math.min(2 ** attempts * 30_000, 3_600_000);
      await db.outboxEvent.update({
        where: { id },
        data: {
          attempts,
          lastError: String(err instanceof Error ? err.message : err).slice(0, 1000),
          status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          nextAttemptAt: new Date(Date.now() + retryMs),
        },
      });
      failed++;
    }
  }
  return { sent, failed };
}

/** Flush the outbox after the response is sent, when running inside a Next.js request. */
export async function flushOutboxSoon() {
  try {
    const { after } = await import("next/server");
    after(() => processOutbox().catch((e) => console.error("[outbox]", e)));
  } catch {
    // Outside a request (seed, worker): the cron tick will pick it up.
  }
}
