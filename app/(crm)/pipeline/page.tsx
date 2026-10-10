import type { Metadata } from "next";
import Link from "next/link";
import { requireOffice } from "@/lib/session";
import { listBoardLeads } from "@/lib/services/leads";
import { PipelineBoard, type BoardLead } from "./pipeline-board";
import { arrivalLabel, arrivalOf, clock, dateLabel, windowLabel } from "@/lib/booking";
import { boardVisitInfo } from "@/lib/services/visits";
import { formatCents } from "@/lib/money";

const ymdEt = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const FEE: Record<string, string> = { collected: "Fee collected", invoiced: "Fee invoiced", paid: "Fee paid" };

export const metadata: Metadata = { title: "Pipeline" };

function badges(i: Awaited<ReturnType<typeof boardVisitInfo>> extends Map<string, infer V> ? V | undefined : never) {
  const v = i?.visit;
  const a = v ? arrivalOf(v) : null;
  return {
    booked: v && a ? `${dateLabel(ymdEt(a.start))}, ${a.end ? arrivalLabel(a) : clock(a.start)}` : null,
    noTech: Boolean(v && !v.techId),
    late: v?.lateEta ? clock(v.lateEta) : null,
    fee: i?.fee?.feeStatus ? `${FEE[i.fee.feeStatus] ?? i.fee.feeStatus}${i.fee.feeCents ? ` ${formatCents(i.fee.feeCents)}` : ""}` : null,
  };
}

export default async function PipelinePage({ searchParams }: PageProps<"/pipeline">) {
  const user = await requireOffice();
  const { lost } = await searchParams;
  const includeLost = lost === "1";
  const leads = await listBoardLeads(user, { includeLost });
  const info = await boardVisitInfo(leads.map((l) => l.id));

  const board: BoardLead[] = leads.map((l) => ({
    id: l.id,
    title: l.title,
    trade: l.trade,
    stage: l.stage,
    customerName: l.customer.name,
    street: l.property?.street ?? null,
    assignee: l.assignedTo?.name ?? null,
    stageChangedAt: l.stageChangedAt.toISOString(),
    requested: l.bookings[0] ? `${dateLabel(l.bookings[0].date)}, ${windowLabel(l.bookings[0].window)}` : null,
    ...badges(info.get(l.id)),
  }));

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center gap-4 px-4 py-3">
        <h1 className="text-lg font-semibold">Pipeline</h1>
        <span className="text-sm text-gray-500">
          {leads.length} lead{leads.length === 1 ? "" : "s"}
          {user.role === "tech" ? " assigned to you" : ""}
        </span>
        <Link href={includeLost ? "/pipeline" : "/pipeline?lost=1"} className="text-sm text-brand underline">
          {includeLost ? "Hide lost" : "Show lost"}
        </Link>
        <Link href="/leads/new" className="btn-primary ml-auto">
          New lead
        </Link>
      </div>
      <PipelineBoard leads={board} showLost={includeLost} />
    </div>
  );
}
