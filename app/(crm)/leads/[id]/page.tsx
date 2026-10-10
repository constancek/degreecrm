import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getLead } from "@/lib/services/leads";
import { NotFoundError } from "@/lib/services/actor";
import { listActiveStaff } from "@/lib/services/users";
import { SOURCES, stageInfo, tradeLabel } from "@/lib/stages";
import { formatPhone } from "@/lib/phone";
import { formatDateTime, timeAgo } from "@/lib/format";
import { formatAddress } from "@/lib/notifications/discord-embeds";
import { AssignForm, LeadDetailsForm, NoteForm, StageForm } from "./lead-forms";
import { listLeadProposals } from "@/lib/services/proposals";
import { db } from "@/lib/db";
import { leadEnrollments } from "@/lib/services/sequences";
import { EnrollmentList, ScheduleVisitForm, TextThread, VisitList } from "@/components/ops/ops-forms";
import { formatCents } from "@/lib/money";

export const metadata: Metadata = { title: "Lead" };

export default async function LeadPage({ params }: PageProps<"/leads/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  const lead = await getLead(user, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const [staff, proposals, visits, jobs, messages, enrollments] = await Promise.all([
    user.role === "owner" ? listActiveStaff() : Promise.resolve([]),
    listLeadProposals(user, lead.id),
    db.visit.findMany({ where: { leadId: lead.id }, orderBy: { start: "desc" }, include: { tech: { select: { name: true } } } }),
    db.job.findMany({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" } }),
    db.message.findMany({ where: { customerId: lead.customerId }, orderBy: { createdAt: "asc" }, take: 200, include: { sentBy: { select: { name: true } } } }),
    leadEnrollments(lead.id),
  ]);
  const canText = Boolean(lead.customer.phone) && !lead.customer.smsOptOut;
  const address = formatAddress(lead.property);

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4 p-4 lg:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        <div>
          <Link href="/pipeline" className="text-sm text-brand hover:underline">
            ← Pipeline
          </Link>
          <h1 className="mt-1 text-xl font-semibold">{lead.title}</h1>
          <p className="text-sm text-gray-500">
            {tradeLabel(lead.trade)} · {SOURCES.find((s) => s.id === lead.source)?.label} · created{" "}
            {formatDateTime(lead.createdAt)}
          </p>
        </div>

        <section className="card grid gap-4 p-4 sm:grid-cols-2">
          <div>
            <h2 className="text-xs font-semibold tracking-wide text-gray-500 uppercase">Customer</h2>
            <p className="mt-1 font-medium">{lead.customer.name}</p>
            <p className="text-sm text-gray-600 capitalize">{lead.customer.type}</p>
            {lead.customer.phone && (
              <a href={`tel:${lead.customer.phone}`} className="block text-sm text-brand hover:underline">
                {formatPhone(lead.customer.phone)}
              </a>
            )}
            {lead.customer.email && (
              <a href={`mailto:${lead.customer.email}`} className="block text-sm text-brand hover:underline">
                {lead.customer.email}
              </a>
            )}
          </div>
          <div>
            <h2 className="text-xs font-semibold tracking-wide text-gray-500 uppercase">Property</h2>
            {lead.property ? (
              <>
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 block text-sm text-brand hover:underline"
                >
                  {address}
                </a>
                {lead.property.notes && <p className="mt-1 text-sm text-gray-600">{lead.property.notes}</p>}
              </>
            ) : (
              <p className="mt-1 text-sm text-gray-500">No address yet</p>
            )}
          </div>
        </section>

        <section className="card p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Proposals</h2>
            <Link href={`/leads/${lead.id}/proposal/new`} className="btn-primary">
              New proposal
            </Link>
          </div>
          {proposals.length === 0 ? (
            <p className="mt-2 text-sm text-gray-500">No proposals yet.</p>
          ) : (
            <ul className="mt-3 divide-y text-sm">
              {proposals.map((p) => {
                const totals = p.options.map((o) => o.totalCents).filter((t) => t > 0);
                return (
                  <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <Link href={`/proposals/${p.id}`} className="font-medium text-brand hover:underline">
                      v{p.version}
                    </Link>
                    <span className="capitalize">{p.status}</span>
                    {totals.length > 0 && (
                      <span className="text-gray-600">
                        {formatCents(Math.min(...totals))}–{formatCents(Math.max(...totals))}
                      </span>
                    )}
                    <span className="text-gray-500">
                      {p.viewCount ? `Viewed ${p.viewCount}× · last ${formatDateTime(p.lastViewedAt!)}` : p.sentAt ? "Not opened yet" : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {jobs.length > 0 && (
          <section className="card p-4">
            <h2 className="font-semibold">Job</h2>
            <ul className="mt-2 text-sm">
              {jobs.map((j) => (
                <li key={j.id}>
                  <Link href={`/jobs/${j.id}`} className="font-medium text-brand hover:underline">
                    {j.title}
                  </Link>{" "}
                  <span className="capitalize text-gray-600">· {j.status.replace("_", " ")}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="card p-4">
          <h2 className="font-semibold">Visits</h2>
          <div className="mt-2">
            <VisitList
              canEdit={user.role === "owner"}
              visits={visits.map((v) => ({
                id: v.id,
                kind: v.kind,
                when: formatDateTime(v.start),
                techName: v.tech.name,
                status: v.status,
                syncState: v.syncState,
                syncError: v.syncError,
              }))}
            />
          </div>
          {user.role === "owner" && (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-medium text-brand">Book an estimate visit</summary>
              <div className="mt-3">
                <ScheduleVisitForm
                  leadId={lead.id}
                  kind="estimate"
                  techs={staff.map((s) => ({ id: s.id, name: s.name }))}
                  defaultTechId={lead.assignedToId}
                  defaultHours={1}
                />
              </div>
            </details>
          )}
        </section>

        <section className="card p-4">
          <h2 className="mb-3 font-semibold">Texts</h2>
          <TextThread
            leadId={lead.id}
            canText={canText}
            reason={!lead.customer.phone ? "no phone number" : "customer opted out (replied STOP)"}
            messages={messages.map((m) => ({
              id: m.id,
              direction: m.direction,
              body: m.body,
              when: formatDateTime(m.createdAt),
              status: m.status,
              by: m.sentBy?.name ?? (m.enrollmentId ? "automatic" : null),
            }))}
          />
          <h3 className="mt-4 mb-1 text-sm font-semibold">Automatic texts</h3>
          <EnrollmentList
            leadId={lead.id}
            rows={enrollments.map((e) => ({
              id: e.id,
              name: e.sequence.name,
              status: e.status,
              detail:
                e.status === "active"
                  ? `step ${e.stepIndex + 1} of ${e.sequence.steps.length}${e.nextSendAt ? `, next ${formatDateTime(e.nextSendAt)}` : ""}`
                  : `${e.status}${e.stoppedReason ? `: ${e.stoppedReason}` : ""}`,
            }))}
          />
        </section>

        <LeadDetailsForm
          leadId={lead.id}
          title={lead.title}
          trade={lead.trade}
          source={lead.source}
          notes={lead.notes ?? ""}
        />

        <section className="card p-4">
          <h2 className="mb-3 font-semibold">Activity</h2>
          <NoteForm leadId={lead.id} />
          <ol className="mt-4 space-y-3" aria-label="Activity timeline">
            {lead.activities.map((a) => (
              <li key={a.id} className="border-l-2 border-gray-200 pl-3 text-sm">
                <p className="text-gray-800">
                  <span className="font-medium">{a.user?.name ?? systemLabel(a.data)}</span>{" "}
                  {describeActivity(a.type, a.data)}
                  {(a.data as { via?: string } | null)?.via === "mcp" && (
                    <span className="ml-1 rounded bg-violet-100 px-1 text-xs text-violet-800">via Claude</span>
                  )}
                </p>
                {a.body && <p className="mt-0.5 whitespace-pre-wrap text-gray-600">{a.body}</p>}
                <p className="text-xs text-gray-400" title={formatDateTime(a.createdAt)}>
                  {timeAgo(a.createdAt)}
                </p>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <aside className="space-y-4">
        <section className="card p-4">
          <h2 className="text-xs font-semibold tracking-wide text-gray-500 uppercase">Stage</h2>
          <p className="mt-1 text-lg font-semibold">{stageInfo(lead.stage).label}</p>
          {lead.lostReason && <p className="text-sm text-gray-600">Reason: {lead.lostReason}</p>}
          <p className="text-xs text-gray-500">since {formatDateTime(lead.stageChangedAt)}</p>
          <StageForm key={lead.stage} leadId={lead.id} stage={lead.stage} />
        </section>
        <section className="card p-4">
          <h2 className="text-xs font-semibold tracking-wide text-gray-500 uppercase">Assigned to</h2>
          {user.role === "owner" ? (
            <AssignForm
              leadId={lead.id}
              assignedToId={lead.assignedToId}
              staff={staff.map((s) => ({ id: s.id, name: s.name }))}
            />
          ) : (
            <p className="mt-1">{lead.assignedTo?.name ?? "Unassigned"}</p>
          )}
        </section>
      </aside>
    </div>
  );
}

function systemLabel(data: unknown): string {
  const label = (data as { system?: string } | null)?.system;
  return label ? label : "System";
}

function describeActivity(type: string, data: unknown): string {
  const d = (data ?? {}) as Record<string, string>;
  switch (type) {
    case "lead_created":
      return "created the lead";
    case "customer_created":
      return "created the customer";
    case "stage_changed":
      return `moved it from ${stageInfo(d.from as never)?.label ?? d.from} to ${stageInfo(d.to as never)?.label ?? d.to}`;
    case "assigned":
      return "changed the assignment";
    case "note":
      return "added a note";
    case "lead_updated":
      return `updated ${(d.fields as unknown as string[] | undefined)?.join(", ") ?? "details"}`;
    case "web_form":
      return "submitted the website form";
    case "proposal_drafted":
      return "drafted a proposal";
    case "proposal_sent":
      return "sent the proposal";
    case "proposal_viewed":
      return "opened the proposal";
    case "option_selected":
      return "picked an option";
    case "terms_checked":
      return "agreed to the Terms & Conditions";
    case "proposal_locked":
      return "locked the proposal link";
    case "fresh_link_requested":
      return "asked for an updated proposal";
    case "sms_sent":
      return "sent a text";
    case "sms_failed":
      return "tried to send a text";
    case "sms_received":
      return "texted us";
    case "sms_opt_out":
      return "opted out of texts";
    case "sign_started":
      return "started signing";
    case "proposal_signed":
      return "signed the proposal";
    case "deposit_paid":
      return "paid the deposit";
    case "payment_failed":
      return "had a payment declined";
    case "financing_clicked":
      return "looked at financing";
    case "financing":
      return "financing update";
    case "visit_scheduled":
      return "scheduled a visit";
    case "visit_rescheduled":
      return "rescheduled a visit";
    case "visit_cancelled":
      return "cancelled a visit";
    case "visit_status":
      return "updated a visit";
    case "job_completed":
      return "completed the job";
    case "invoice_sent":
      return "sent the final invoice";
    case "job_paid":
      return "recorded full payment";
    case "quickbooks_estimate":
      return "synced to QuickBooks";
    case "quickbooks_error":
      return "QuickBooks problem";
    default:
      return type.replace(/_/g, " ");
  }
}
