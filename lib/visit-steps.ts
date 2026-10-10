// Where a visit is in the tech's day, from its status + the latest estimate. Pure (client-safe): the step
// strip and the action buttons both read from this, so a button only exists when its step is current.

export type VisitStepInput = {
  kind: "estimate" | "job";
  status: string;
  outcome: string | null;
  hasTech: boolean;
  /** Latest live estimate on the lead (draft | sent | viewed | signed), if any. */
  proposalStatus: string | null;
};

export type VisitPhase =
  "cancelled" | "no_tech" | "scheduled" | "en_route" | "on_site_no_estimate" | "on_site_estimate" | "on_site_signed" | "working" | "done";

export function visitPhase(v: VisitStepInput): VisitPhase {
  if (v.status === "cancelled" || v.status === "rescheduled") return "cancelled";
  if (v.status === "done") return "done";
  if (!v.hasTech) return "no_tech";
  if (v.status === "scheduled") return "scheduled";
  if (v.status === "en_route") return "en_route";
  if (v.kind === "job") return "working";
  if (v.proposalStatus === "signed") return "on_site_signed";
  return v.proposalStatus ? "on_site_estimate" : "on_site_no_estimate";
}

export type Step = { label: string; state: "done" | "current" | "todo" };

const ESTIMATE_STEPS = ["On the way", "On site", "Estimate", "Signed", "Wrapped up"] as const;
const JOB_STEPS = ["On the way", "Working", "Complete"] as const;

/** Index of the current step in the strip (length = all done). */
function currentIndex(v: VisitStepInput, phase: VisitPhase): number {
  if (v.kind === "job") return { scheduled: 0, en_route: 1, working: 2, done: 3 }[phase as "done"] ?? 0;
  switch (phase) {
    case "scheduled":
      return 0;
    case "en_route":
      return 1;
    case "on_site_no_estimate":
    case "on_site_estimate":
      return 2;
    case "on_site_signed":
      return 4;
    case "done":
      return 5;
    default:
      return 0;
  }
}

export function visitSteps(v: VisitStepInput): Step[] {
  const phase = visitPhase(v);
  const labels = v.kind === "job" ? JOB_STEPS : ESTIMATE_STEPS;
  const at = currentIndex(v, phase);
  // An estimate visit that ended without a signature skips "Signed".
  const unsigned = v.kind === "estimate" && phase === "done" && !["work_now", "return_visit"].includes(v.outcome ?? "");
  return labels.map((label, i) => ({
    label,
    state: unsigned && label === "Signed" ? "todo" : i < at ? "done" : i === at ? "current" : "todo",
  }));
}

export const OUTCOME_LABEL: Record<string, string> = {
  work_now: "Work done the same visit",
  return_visit: "Signed · return visit to schedule",
  declined: "Estimate declined",
  estimate_later: "Estimate to follow",
  no_show: "Customer not home",
};

/** One-word status for list rows. */
export function phaseLabel(phase: VisitPhase, outcome: string | null): string {
  return {
    cancelled: "Cancelled",
    no_tech: "No tech yet",
    scheduled: "Scheduled",
    en_route: "On the way",
    on_site_no_estimate: "On site",
    on_site_estimate: "Estimate ready",
    on_site_signed: "Signed",
    working: "Working",
    done: outcome ? (OUTCOME_LABEL[outcome] ?? "Done") : "Done",
  }[phase];
}
