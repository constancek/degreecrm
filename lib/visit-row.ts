// Server-side mapping of a visit to the row shown in <VisitList> (lead and job pages).

import type { VisitRow } from "@/components/ops/ops-forms";
import { arrivalLabel, arrivalOf, clock, dateLabel } from "@/lib/booking";
import { formatCents } from "@/lib/money";
import { formatDateTime } from "@/lib/format";

const OUTCOMES: Record<string, string> = {
  work_now: "Worked same visit",
  return_visit: "Return visit needed",
  declined: "Declined",
  estimate_later: "Estimate to follow",
};
const FEES: Record<string, string> = { collected: "Fee collected", invoiced: "Fee invoiced", paid: "Fee paid", waived: "No fee" };

const ymdEt = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);

export function visitRow(v: {
  id: string;
  kind: string;
  start: Date;
  end: Date;
  arrivalStart: Date | null;
  arrivalEnd: Date | null;
  lateEta: Date | null;
  status: string;
  outcome: string | null;
  feeStatus: string | null;
  feeCents: number | null;
  syncState: string;
  syncError: string | null;
  techId: string | null;
  tech: { name: string } | null;
}): VisitRow {
  const a = arrivalOf(v);
  return {
    id: v.id,
    kind: v.kind,
    when: formatDateTime(v.start),
    arrival: `${dateLabel(ymdEt(a.start))}, ${a.end ? `arrive ${arrivalLabel(a)}` : clock(a.start)}`,
    techName: v.tech?.name ?? "No tech yet",
    techId: v.techId,
    status: v.status,
    syncState: v.syncState,
    syncError: v.syncError,
    lateEta: v.lateEta ? clock(v.lateEta) : null,
    outcome: v.outcome ? (OUTCOMES[v.outcome] ?? v.outcome) : null,
    fee: v.feeStatus ? `${FEES[v.feeStatus] ?? v.feeStatus}${v.feeCents && v.feeStatus !== "waived" ? ` ${formatCents(v.feeCents, { cents: true })}` : ""}` : null,
    date: ymdEt(v.start),
    hours: Math.max(0.5, Math.round(((v.end.getTime() - v.start.getTime()) / 3_600_000) * 2) / 2),
  };
}
