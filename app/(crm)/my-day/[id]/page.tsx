import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { requireUser } from "@/lib/session";
import { getVisit } from "@/lib/services/visits";
import { visitBrief } from "@/lib/services/visit-brief";
import { NotFoundError, type Actor } from "@/lib/services/actor";
import { easternYmd } from "@/lib/services/dispatch";
import { getCompany } from "@/lib/services/company";
import { formatAddress } from "@/lib/notifications/discord-embeds";
import { tradeLabel } from "@/lib/stages";
import { clock } from "@/lib/booking";
import { formatCents } from "@/lib/money";
import { stepInput, visitWhen } from "@/lib/visit-view";
import type { PropertyFacts } from "@/lib/integrations/rentcast";
import { VisitActions } from "@/components/ops/visit-actions";
import { ContactButtons, PhaseChip, StepStrip } from "@/components/ops/visit-parts";
import { ChevronLeft } from "@/components/ui/icons";

export const metadata: Metadata = { title: "Appointment" };

const DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "short",
  day: "numeric",
});
const MONTH_YEAR = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export default async function AppointmentPage({ params }: PageProps<"/my-day/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  const [v, company] = await Promise.all([
    getVisit(user, id).catch((e) => {
      if (e instanceof NotFoundError) notFound();
      throw e;
    }),
    getCompany(),
  ]);
  const address = formatAddress(v.lead.property);
  const canText = Boolean(v.lead.customer.phone) && !v.lead.customer.smsOptOut;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pt-3 pb-16">
      <Link href={`/my-day?day=${easternYmd(v.start)}`} className="-ml-2 inline-flex min-h-11 items-center gap-1 px-2 text-sm font-medium text-brand">
        <ChevronLeft /> Today
      </Link>

      <header className="mt-1 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">{v.lead.customer.name}</h1>
          <p className="text-gray-700">{v.job?.title ?? v.lead.title}</p>
          <p className="mt-1 text-sm text-gray-600">
            <span className="font-semibold text-brand tabular-nums">
              {DAY.format(v.start)}, {visitWhen(v)}
            </span>{" "}
            · {v.kind === "estimate" ? "Service call" : "Job"} · {tradeLabel(v.lead.trade)}
          </p>
        </div>
        <PhaseChip visit={stepInput(v)} />
      </header>

      <section className="card mt-4 space-y-4 p-4 sm:p-5" data-visit={v.id} aria-label="What to do now">
        <StepStrip visit={stepInput(v)} />
        <VisitActions
          visitId={v.id}
          kind={v.kind}
          status={v.status}
          outcome={v.outcome}
          hasTech={Boolean(v.techId)}
          canText={canText}
          lateEta={v.lateEta ? clock(v.lateEta) : null}
          proposal={
            v.lead.proposals[0]
              ? {
                  id: v.lead.proposals[0].id,
                  status: v.lead.proposals[0].status,
                }
              : null
          }
          leadId={v.leadId}
          feeDollars={(company.serviceCallFeeCents / 100).toFixed(2)}
        />
      </section>

      <section className="mt-6 space-y-3" aria-labelledby="where">
        <h2 id="where" className="text-sm font-semibold text-gray-700">
          Where &amp; who
        </h2>
        {address && <p className="text-gray-900">{address}</p>}
        <ContactButtons address={address} phone={v.lead.customer.phone} canText={canText} />
        {v.lead.property?.notes && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-950">Access: {v.lead.property.notes}</p>}
        {(v.lead.notes || v.notes) && (
          <div className="space-y-1 text-sm text-gray-800">
            {v.lead.notes && (
              <p>
                <span className="font-medium">Why they called:</span> {v.lead.notes}
              </p>
            )}
            {v.notes && (
              <p>
                <span className="font-medium">Visit notes:</span> {v.notes}
              </p>
            )}
          </div>
        )}
      </section>

      <Suspense fallback={<BriefSkeleton />}>
        <Brief actor={user} visitId={v.id} />
      </Suspense>

      <Link href={`/leads/${v.leadId}`} className="mt-8 inline-flex min-h-11 items-center text-sm font-medium text-brand underline underline-offset-4">
        Full customer record
      </Link>
    </div>
  );
}

/** "Before you knock": talking points, the house, and our history with them. Streams in after the page. */
async function Brief({ actor, visitId }: { actor: Actor; visitId: string }) {
  const { facts, history, points } = await visitBrief(actor, visitId);
  const rows = factRows(facts);
  return (
    <section className="mt-8" aria-labelledby="brief">
      <h2 id="brief" className="text-lg font-semibold tracking-tight">
        Before you knock
      </h2>

      {points.length > 0 && (
        <ul className="mt-3 space-y-2">
          {points.map((p) => (
            <li key={p} className="flex gap-3 rounded-md bg-sky-50 px-3 py-2.5 text-sm leading-relaxed text-sky-950">
              <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-sky-700" />
              {p}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-700">The house</h3>
          {rows.length ? (
            <dl className="mt-2 divide-y text-sm">
              {rows.map(([k, val]) => (
                <div key={k} className="flex justify-between gap-4 py-2">
                  <dt className="text-gray-600">{k}</dt>
                  <dd className="text-right font-medium text-gray-900 tabular-nums">{val}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-2 text-sm text-gray-600">No public records found for this address.</p>
          )}
          {rows.length > 0 && <p className="mt-2 text-xs text-gray-600">Public records via RentCast. Estimates can be off; confirm on site.</p>}
        </div>
        <div>
          <h3 className="text-sm font-semibold text-gray-700">With us</h3>
          <dl className="mt-2 divide-y text-sm">
            <Row k="Customer since" v={MONTH_YEAR.format(history.customerSince)} />
            <Row k="Jobs done" v={String(history.jobsDone)} />
            <Row k="Paid to date" v={formatCents(history.paidCents)} />
            <Row k="Other requests" v={String(history.otherRequests)} />
            {history.lastVisit && <Row k="Last visit" v={`${MONTH_YEAR.format(history.lastVisit.when)} · ${history.lastVisit.title}`} />}
          </dl>
          {history.declined.length > 0 && (
            <div className="mt-3 text-sm">
              <p className="font-medium text-gray-700">Declined before</p>
              <ul className="mt-1 space-y-1 text-gray-800">
                {history.declined.map((d) => (
                  <li key={d.title + d.when.toISOString()}>
                    {d.title}
                    {d.reason && <span className="text-gray-600"> · {d.reason}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4 py-2">
      <dt className="text-gray-600">{k}</dt>
      <dd className="text-right font-medium text-gray-900 tabular-nums">{v}</dd>
    </div>
  );
}

const dollars = (n: number) => formatCents(Math.round(n) * 100);

function factRows(f: PropertyFacts | null): [string, string][] {
  if (!f) return [];
  const rows: [string, string | null][] = [
    ["Type", f.propertyType ?? null],
    ["Built", f.yearBuilt ? `${f.yearBuilt} (${new Date().getFullYear() - f.yearBuilt} yrs)` : null],
    ["Size", f.squareFootage ? `${f.squareFootage.toLocaleString()} sq ft` : null],
    ["Beds / baths", f.bedrooms != null || f.bathrooms != null ? `${f.bedrooms ?? "?"} / ${f.bathrooms ?? "?"}` : null],
    ["Floors", f.floorCount ? String(f.floorCount) : null],
    ["Heating", f.heatingType ?? null],
    ["Cooling", f.coolingType ?? null],
    ["Last sold", f.lastSaleDate ? `${MONTH_YEAR.format(new Date(f.lastSaleDate))}${f.lastSalePrice ? ` · ${dollars(f.lastSalePrice)}` : ""}` : null],
    ["Est. value", f.valueEstimate ? dollars(f.valueEstimate) : null],
    ["Owner on record", f.ownerNames?.length ? f.ownerNames.join(", ") : null],
    ["Owner lives here", f.ownerOccupied == null ? null : f.ownerOccupied ? "Yes" : "No"],
  ];
  return rows.filter((r): r is [string, string] => Boolean(r[1]));
}

function BriefSkeleton() {
  return (
    <section className="mt-8" aria-busy="true" aria-label="Loading property details">
      <div className="h-6 w-44 rounded bg-gray-200" />
      <div className="mt-3 space-y-2">
        <div className="h-10 rounded-md bg-gray-100" />
        <div className="h-10 rounded-md bg-gray-100" />
      </div>
      <p className="mt-3 text-sm text-gray-600">Looking up the property…</p>
    </section>
  );
}
