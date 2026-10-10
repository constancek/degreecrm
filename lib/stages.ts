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
  { id: "new", label: "New request", enters: "Lead created (website request, phone, Claude)", discord: true },
  { id: "follow_up", label: "Needs scheduling", enters: "Not booked within 4 hours (or dragged here)", discord: false },
  { id: "needs_tech", label: "Needs tech", enters: "Time agreed, no technician yet", discord: false },
  { id: "estimate_scheduled", label: "Scheduled", enters: "Booked with a technician (customer gets the confirmation)", discord: true },
  { id: "needs_reschedule", label: "Needs reschedule", enters: "Tech can't make it, or the customer asked to move it", discord: true },
  { id: "on_the_way", label: "On the way", enters: "Tech taps On my way", discord: false },
  { id: "on_site", label: "On site", enters: "Tech taps Arrived", discord: false },
  { id: "estimate_sent", label: "Estimate sent", enters: "Estimate sent or presented, not signed yet", discord: false },
  { id: "estimate_approved", label: "Approved", enters: "Customer signs", discord: false },
  { id: "estimate_declined", label: "Declined", enters: "Tech taps Declined – done", discord: true },
  { id: "job_scheduled", label: "Job scheduled", enters: "Return visit booked", discord: true },
  { id: "job_in_progress", label: "In progress", enters: "Start work now, or Start on the job day", discord: false },
  { id: "job_completed", label: "Job completed", enters: "Tech completes the work", discord: true },
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
export const PRE_SALE_STAGES: LeadStage[] = ["new", "follow_up", "needs_tech", "estimate_scheduled", "needs_reschedule", "estimate_sent", "estimate_declined"];

/** Board position of a stage (for "only move forward" rules). */
export function stageIndex(stage: LeadStage): number {
  return STAGES.findIndex((s) => s.id === stage);
}

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
