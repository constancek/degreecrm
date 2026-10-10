import type { FullVisit } from "@/lib/services/visits";
import { arrivalLabel, arrivalOf } from "@/lib/booking";
import type { VisitStepInput } from "@/lib/visit-steps";

const TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
});

/** The arrival window promised to the customer, else the calendar block. */
export function visitWhen(v: FullVisit) {
  return arrivalOf(v).end ? arrivalLabel(arrivalOf(v)) : `${TIME.format(v.start)}–${TIME.format(v.end)}`;
}

export function stepInput(v: FullVisit): VisitStepInput {
  return {
    kind: v.kind,
    status: v.status,
    outcome: v.outcome,
    hasTech: Boolean(v.techId),
    proposalStatus: v.lead.proposals[0]?.status ?? null,
  };
}
