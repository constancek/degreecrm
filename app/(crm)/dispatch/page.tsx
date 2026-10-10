import type { Metadata } from "next";
import { requireOwner } from "@/lib/session";
import { addDaysYmd, boardData, easternMidnight, easternYmd } from "@/lib/services/dispatch";
import { formatAddress } from "@/lib/notifications/discord-embeds";
import { DispatchBoard } from "./dispatch-board";

export const metadata: Metadata = { title: "Dispatch" };

const COLORS = ["#2563eb", "#ea580c", "#16a34a", "#9333ea", "#db2777", "#0891b2", "#ca8a04"];

export default async function DispatchPage({ searchParams }: PageProps<"/dispatch">) {
  const user = await requireOwner();
  const sp = await searchParams;
  const view = sp.view === "week" ? "week" : "day";
  const date = typeof sp.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : easternYmd(new Date());
  const days = view === "week" ? 7 : 1;
  const from = easternMidnight(date);
  const to = easternMidnight(addDaysYmd(date, days));
  const data = await boardData(user, { from, to });

  return (
    <DispatchBoard
      view={view}
      date={date}
      dayStarts={Array.from({ length: days }, (_, i) => {
        const ymd = addDaysYmd(date, i);
        return { ymd, ms: easternMidnight(ymd).getTime() };
      })}
      mapsKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || null}
      techs={data.techs.map((t, i) => ({ id: t.id, name: t.name, color: COLORS[i % COLORS.length]!, calendar: Boolean(t.googleRefreshToken) }))}
      visits={data.visits.map((v) => ({
        id: v.id,
        techId: v.techId,
        leadId: v.leadId,
        jobId: v.jobId,
        kind: v.kind,
        status: v.status,
        start: v.start.getTime(),
        end: v.end.getTime(),
        customer: v.lead.customer.name,
        title: v.job?.title ?? v.lead.title,
        address: formatAddress(v.lead.property),
        lat: v.lead.property?.lat ?? null,
        lng: v.lead.property?.lng ?? null,
      }))}
      busy={data.busy.map((b) => ({ techId: b.techId, start: b.start.getTime(), end: b.end.getTime() }))}
      unscheduled={[
        ...data.unscheduledJobs.map((j) => ({
          key: `job:${j.id}`,
          leadId: j.leadId,
          jobId: j.id,
          kind: "job" as const,
          customer: j.lead.customer.name,
          title: j.title,
          address: formatAddress(j.lead.property),
          minutes: Math.round(j.durationHours * 60),
        })),
        ...data.leadsNeedingEstimate.map((l) => ({
          key: `lead:${l.id}`,
          leadId: l.id,
          jobId: null,
          kind: "estimate" as const,
          customer: l.customer.name,
          title: l.title,
          address: formatAddress(l.property),
          minutes: 60,
        })),
      ]}
    />
  );
}
