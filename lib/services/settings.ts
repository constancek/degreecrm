import { db, type Tx } from "@/lib/db";
import { STAGES, STAGE_IDS } from "@/lib/stages";
import type { LeadStage } from "@/generated/prisma/enums";
import { ForbiddenError, isOwner, type Actor } from "./actor";

const DISCORD_STAGES = "discord.stages";
const DEFAULT_DISCORD_STAGES = STAGES.filter((s) => s.discord).map((s) => s.id);

/** Stages that post to #degree-service-call. Defaults to the ones marked `discord` in lib/stages.ts. */
export async function getDiscordStages(tx: Tx | typeof db = db): Promise<Set<LeadStage>> {
  const row = await tx.setting.findUnique({ where: { key: DISCORD_STAGES } });
  const value = Array.isArray(row?.value) ? (row.value as string[]) : DEFAULT_DISCORD_STAGES;
  return new Set(value.filter((v): v is LeadStage => (STAGE_IDS as string[]).includes(v)));
}

export async function setDiscordStages(actor: Actor, stages: string[]) {
  if (!isOwner(actor)) throw new ForbiddenError("Only the owner can change notification settings");
  const value = STAGE_IDS.filter((id) => stages.includes(id));
  await db.setting.upsert({
    where: { key: DISCORD_STAGES },
    create: { key: DISCORD_STAGES, value },
    update: { value },
  });
}
