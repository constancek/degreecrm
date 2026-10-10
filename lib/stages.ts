import type { LeadStage, Trade, LeadSource } from "@/generated/prisma/enums";

export type StageInfo = {
  id: LeadStage;
  label: string;
  /** When a lead enters this stage (SPEC.md "Job pipeline"). */
  enters: string;
  /** Post to #degree-service-call when a lead enters this stage. */
  discord: boolean;
};

export const STAGES: StageInfo[] = [
  { id: "new", label: "New", enters: "Lead created", discord: true },
  { id: "follow_up", label: "Follow up", enters: "No estimate booked within 24 h", discord: false },
  { id: "estimate_scheduled", label: "Estimate scheduled", enters: "Estimate visit booked", discord: true },
  { id: "estimate_sent", label: "Estimate sent", enters: "Proposal link sent", discord: false },
  { id: "estimate_approved", label: "Estimate approved", enters: "Client signs", discord: false },
  { id: "job_scheduled", label: "Job scheduled", enters: "Deposit paid and visit(s) booked", discord: true },
  { id: "job_in_progress", label: "In progress", enters: "Tech taps Start", discord: false },
  { id: "job_completed", label: "Job completed", enters: "Tech completes last visit", discord: true },
  { id: "invoiced", label: "Invoiced", enters: "Invoice sent", discord: false },
  { id: "payment_complete", label: "Paid", enters: "Final payment recorded", discord: true },
  { id: "review_requested", label: "Review requested", enters: "Morning after payment", discord: false },
  { id: "lost", label: "Lost", enters: "Marked lost or 60 days idle", discord: false },
];

export const STAGE_IDS = STAGES.map((s) => s.id) as [LeadStage, ...LeadStage[]];

const byId = new Map(STAGES.map((s) => [s.id, s]));
export function stageInfo(stage: LeadStage): StageInfo {
  return byId.get(stage)!;
}

/** Stages a lead can sit in before an estimate is signed; idle leads here go to `lost` after 60 days. */
export const PRE_SALE_STAGES: LeadStage[] = ["new", "follow_up", "estimate_scheduled", "estimate_sent"];

export const TRADES: { id: Trade; label: string }[] = [
  { id: "hvac", label: "HVAC" },
  { id: "plumbing", label: "Plumbing" },
  { id: "electrical", label: "Electrical" },
];
export const TRADE_IDS = TRADES.map((t) => t.id) as [Trade, ...Trade[]];
export function tradeLabel(trade: Trade) {
  return TRADES.find((t) => t.id === trade)?.label ?? trade;
}

export const SOURCES: { id: LeadSource; label: string }[] = [
  { id: "phone", label: "Phone call" },
  { id: "web_form", label: "Website form" },
  { id: "referral", label: "Referral" },
  { id: "repeat_customer", label: "Repeat customer" },
  { id: "mcp", label: "Claude (MCP)" },
  { id: "other", label: "Other" },
];
export const SOURCE_IDS = SOURCES.map((s) => s.id) as [LeadSource, ...LeadSource[]];
