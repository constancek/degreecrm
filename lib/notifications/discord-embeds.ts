import type { DiscordMessage } from "@/lib/integrations/discord";
import { stageInfo, tradeLabel } from "@/lib/stages";
import { formatPhone } from "@/lib/phone";
import { appUrl } from "@/lib/env";
import type { LeadStage, Trade } from "@/generated/prisma/enums";

export type LeadForEmbed = {
  id: string;
  title: string;
  trade: Trade;
  stage: LeadStage;
  customer: { name: string; phone: string | null };
  property: { street: string; unit: string | null; city: string; zip: string | null } | null;
  assignedTo: { name: string } | null;
};

const STAGE_COLORS: Partial<Record<LeadStage, number>> = {
  new: 0x3b82f6,
  estimate_scheduled: 0xf59e0b,
  job_scheduled: 0x8b5cf6,
  job_completed: 0x10b981,
  payment_complete: 0x059669,
};

export function formatAddress(p: LeadForEmbed["property"]): string {
  if (!p) return "";
  return [p.street + (p.unit ? ` ${p.unit}` : ""), p.city, p.zip].filter(Boolean).join(", ");
}

export function leadStageEmbed(lead: LeadForEmbed, opts: { by?: string } = {}): DiscordMessage {
  const stage = stageInfo(lead.stage);
  const address = formatAddress(lead.property);
  const fields = [
    { name: "Customer", value: lead.customer.name, inline: true },
    { name: "Trade", value: tradeLabel(lead.trade), inline: true },
    { name: "Tech", value: lead.assignedTo?.name ?? "Unassigned", inline: true },
  ];
  if (lead.customer.phone) fields.push({ name: "Phone", value: formatPhone(lead.customer.phone), inline: true });
  if (address) {
    fields.push({
      name: "Address",
      value: `[${address}](https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)})`,
      inline: false,
    });
  }
  return {
    embeds: [
      {
        title: `${stage.label}: ${lead.title}`,
        url: `${appUrl()}/leads/${lead.id}`,
        description: opts.by ? `by ${opts.by}` : undefined,
        color: STAGE_COLORS[lead.stage] ?? 0x6b7280,
        fields,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}
