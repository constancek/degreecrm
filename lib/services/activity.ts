import type { Tx } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { actorUserId, type Actor } from "./actor";

export type ActivityInput = {
  type: string;
  body?: string | null;
  data?: Record<string, unknown>;
  leadId?: string | null;
  customerId?: string | null;
};

/** Writes a timeline/audit row and bumps the lead's lastActivityAt. */
export async function recordActivity(tx: Tx, actor: Actor, input: ActivityInput) {
  const data: Record<string, unknown> = { ...input.data };
  if (actor.kind === "system") data.system = actor.label;
  if (actor.kind === "user" && actor.via === "mcp") data.via = "mcp";

  const row = await tx.activity.create({
    data: {
      type: input.type,
      body: input.body ?? null,
      data: Object.keys(data).length ? (data as Prisma.InputJsonValue) : undefined,
      leadId: input.leadId ?? null,
      customerId: input.customerId ?? null,
      userId: actorUserId(actor),
    },
  });
  if (input.leadId) {
    await tx.lead.update({ where: { id: input.leadId }, data: { lastActivityAt: row.createdAt } });
  }
  return row;
}
