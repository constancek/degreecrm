import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { listVisits, type FullVisit } from "@/lib/services/visits";
import { addDaysYmd, easternMidnight, easternYmd } from "@/lib/services/dispatch";
import { formatAddress } from "@/lib/notifications/discord-embeds";
import { tradeLabel } from "@/lib/stages";
import { VisitActions } from "@/components/ops/visit-actions";
import { ContactButtons, PhaseChip, StepStrip } from "@/components/ops/visit-parts";
import { ChevronLeft, ChevronRight } from "@/components/ui/icons";
import { clock } from "@/lib/booking";
import { stepInput, visitWhen } from "@/lib/visit-view";
import { getCompany } from "@/lib/services/company";

export const metadata: Metadata = { title: "Today" };

const DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "long",
  month: "long",
  day: "numeric",
});

const OPEN = ["scheduled", "en_route", "in_progress"];

export default async function TodayPage({ searchParams }: PageProps<"/my-day">) {
  const user = await requireUser();
  const { day } = await searchParams;
  const today = easternYmd(new Date());
  const ymd = typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : today;
  const from = easternMidnight(ymd);
  const [visits, company] = await Promise.all([
    listVisits(user, {
      from,
      to: easternMidnight(addDaysYmd(ymd, 1)),
      techId: user.id,
    }),
    getCompany(),
  ]);

  // Open stops in time order, then finished ones; the first open stop is "next".
  const open = visits.filter((v) => OPEN.includes(v.status));
  const closed = visits.filter((v) => !OPEN.includes(v.status));
  const [next, ...later] = open;
  const dateLabel = DAY.format(new Date(from.getTime() + 12 * 3_600_000));

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pt-4 pb-16">
      <header className="flex items-center gap-2">
        <Link href={`/my-day?day=${addDaysYmd(ymd, -1)}`} className="icon-btn text-brand" aria-label="Previous day">
          <ChevronLeft className="size-5" />
        </Link>
        <div className="min-w-0 flex-1 text-center">
          <h1 className="text-xl font-semibold tracking-tight">{ymd === today ? "Today" : dateLabel}</h1>
          <p className="text-sm text-gray-600">
            {ymd === today && <>{dateLabel} · </>}
            {visits.length === 0 ? "No stops" : `${visits.length} stop${visits.length === 1 ? "" : "s"}${closed.length ? ` · ${closed.length} done` : ""}`}
          </p>
        </div>
        <Link href={`/my-day?day=${addDaysYmd(ymd, 1)}`} className="icon-btn text-brand" aria-label="Next day">
          <ChevronRight className="size-5" />
        </Link>
      </header>

      {visits.length === 0 && (
        <div className="mt-8 text-center text-sm text-gray-600">
          <p>Nothing booked for you{ymd === today ? " today" : " this day"}.</p>
          {ymd === today && (
            <Link href={`/my-day?day=${addDaysYmd(ymd, 1)}`} className="mt-2 inline-block font-medium text-brand underline underline-offset-4">
              See tomorrow
            </Link>
          )}
        </div>
      )}

      {next && (
        <section aria-labelledby="next-stop" className="mt-5">
          <h2 id="next-stop" className="sr-only">
            Next stop
          </h2>
          <article className="card overflow-hidden ring-2 ring-brand/15" data-visit={next.id}>
            <div className="space-y-4 p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-2xl font-semibold tracking-tight text-brand tabular-nums">{visitWhen(next)}</p>
                  <Link href={`/my-day/${next.id}`} className="mt-1 block text-xl font-semibold text-gray-900 underline-offset-4 hover:underline">
                    {next.lead.customer.name}
                  </Link>
                  <p className="text-gray-700">{next.job?.title ?? next.lead.title}</p>
                </div>
                <div className="flex flex-col items-end gap-1.5 text-right">
                  <PhaseChip visit={stepInput(next)} />
                  <span className="text-xs text-gray-600">
                    {next.kind === "estimate" ? "Service call" : "Job"} · {tradeLabel(next.lead.trade)}
                  </span>
                </div>
              </div>
              {formatAddress(next.lead.property) && <p className="text-sm text-gray-800">{formatAddress(next.lead.property)}</p>}
              <ContactButtons address={formatAddress(next.lead.property)} phone={next.lead.customer.phone} canText={!next.lead.customer.smsOptOut} />
              {next.lead.property?.notes && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-950">Access: {next.lead.property.notes}</p>}
              <StepStrip visit={stepInput(next)} />
              <VisitActions
                visitId={next.id}
                kind={next.kind}
                status={next.status}
                outcome={next.outcome}
                hasTech={Boolean(next.techId)}
                canText={Boolean(next.lead.customer.phone) && !next.lead.customer.smsOptOut}
                lateEta={next.lateEta ? clock(next.lateEta) : null}
                proposal={
                  next.lead.proposals[0]
                    ? {
                        id: next.lead.proposals[0].id,
                        status: next.lead.proposals[0].status,
                      }
                    : null
                }
                leadId={next.leadId}
                feeDollars={(company.serviceCallFeeCents / 100).toFixed(2)}
              />
            </div>
            <Link
              href={`/my-day/${next.id}`}
              className="flex min-h-12 items-center justify-between border-t bg-gray-50 px-4 text-sm font-medium text-brand hover:bg-gray-100 sm:px-5"
            >
              Customer, property &amp; history
              <ChevronRight />
            </Link>
          </article>
        </section>
      )}

      {later.length > 0 && <VisitList title="Later" visits={later} />}
      {closed.length > 0 && <VisitList title="Done" visits={closed} muted />}
    </div>
  );
}

function VisitList({ title, visits, muted }: { title: string; visits: FullVisit[]; muted?: boolean }) {
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-sm font-semibold text-gray-700">{title}</h2>
      <ol className="card divide-y overflow-hidden">
        {visits.map((v) => (
          <li key={v.id} data-visit={v.id}>
            <Link href={`/my-day/${v.id}`} className={`flex min-h-16 items-center gap-3 px-4 py-3 hover:bg-gray-50 ${muted ? "text-gray-600" : ""}`}>
              <span className={`w-24 shrink-0 text-sm font-semibold tabular-nums ${muted ? "" : "text-brand"}`}>{visitWhen(v)}</span>
              <span className="min-w-0 flex-1">
                <span className={`block truncate font-medium ${muted ? "" : "text-gray-900"}`}>{v.lead.customer.name}</span>
                <span className="block truncate text-sm">{formatAddress(v.lead.property) ?? v.lead.title}</span>
              </span>
              <PhaseChip visit={stepInput(v)} />
              <ChevronRight className="size-4 shrink-0 text-gray-500" />
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
