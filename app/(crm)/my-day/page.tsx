import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { listVisits } from "@/lib/services/visits";
import { addDaysYmd, easternMidnight, easternYmd } from "@/lib/services/dispatch";
import { formatPhone } from "@/lib/phone";
import { formatAddress } from "@/lib/notifications/discord-embeds";
import { tradeLabel } from "@/lib/stages";
import { VisitActions } from "@/components/ops/visit-actions";
import { arrivalLabel, arrivalOf, clock } from "@/lib/booking";
import { getCompany } from "@/lib/services/company";

export const metadata: Metadata = { title: "My day" };

const TIME = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric" });

export default async function MyDayPage({ searchParams }: PageProps<"/my-day">) {
  const user = await requireUser();
  const { day } = await searchParams;
  const ymd = typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : easternYmd(new Date());
  const from = easternMidnight(ymd);
  const [visits, company] = await Promise.all([listVisits(user, { from, to: easternMidnight(addDaysYmd(ymd, 1)), techId: user.id }), getCompany()]);

  return (
    <div className="mx-auto w-full max-w-xl p-4 lg:max-w-5xl">
      <div className="flex items-center justify-between">
        <Link href={`/my-day?day=${addDaysYmd(ymd, -1)}`} className="px-2 text-brand" aria-label="Previous day">
          ←
        </Link>
        <h1 className="text-lg font-semibold">{DAY.format(new Date(from.getTime() + 12 * 3_600_000))}</h1>
        <Link href={`/my-day?day=${addDaysYmd(ymd, 1)}`} className="px-2 text-brand" aria-label="Next day">
          →
        </Link>
      </div>
      {visits.length === 0 && <p className="card mt-4 p-6 text-center text-sm text-gray-500">No visits scheduled.</p>}
      <ol className="mt-4 grid gap-3 lg:grid-cols-2">
        {visits.map((v) => {
          const address = formatAddress(v.lead.property);
          return (
            <li key={v.id} className="card p-4" data-visit={v.id}>
              <div className="flex items-baseline justify-between">
                <p className="text-sm font-semibold text-brand">
                  {arrivalOf(v).end ? `Arrive ${arrivalLabel(arrivalOf(v))}` : `${TIME.format(v.start)}–${TIME.format(v.end)}`}
                </p>
                <span className="text-xs text-gray-500">
                  {v.kind === "estimate" ? "Service call" : "Job"} · {tradeLabel(v.lead.trade)}
                </span>
              </div>
              <Link href={`/leads/${v.leadId}`} className="mt-1 block text-lg font-semibold hover:underline">
                {v.lead.customer.name}
              </Link>
              <p className="text-sm text-gray-700">{v.job?.title ?? v.lead.title}</p>
              {address && (
                <a
                  className="mt-1 block text-sm text-brand underline"
                  href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {address}
                </a>
              )}
              {v.lead.customer.phone && (
                <a className="block text-sm text-brand" href={`tel:${v.lead.customer.phone}`}>
                  {formatPhone(v.lead.customer.phone)}
                </a>
              )}
              {v.lead.property?.notes && <p className="mt-1 text-sm text-gray-600">Access: {v.lead.property.notes}</p>}
              {v.notes && <p className="mt-1 text-sm text-gray-600">Notes: {v.notes}</p>}
              {v.lead.proposals[0] && (
                <a href={`/proposals/${v.lead.proposals[0].id}/present`} target="_blank" rel="noreferrer" className="btn-secondary mt-3 w-full py-3">
                  {v.lead.proposals[0].status === "signed" ? "Show signed estimate" : "Present estimate to customer"}
                </a>
              )}
              <div className="mt-3">
                <VisitActions
                  visitId={v.id}
                  kind={v.kind}
                  status={v.status}
                  outcome={v.outcome}
                  hasTech={Boolean(v.techId)}
                  canText={Boolean(v.lead.customer.phone) && !v.lead.customer.smsOptOut}
                  lateEta={v.lateEta ? clock(v.lateEta) : null}
                  proposal={v.lead.proposals[0] ? { id: v.lead.proposals[0].id, status: v.lead.proposals[0].status } : null}
                  leadId={v.leadId}
                  feeDollars={(company.serviceCallFeeCents / 100).toFixed(2)}
                />
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
