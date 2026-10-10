import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { NotFoundError } from "@/lib/services/actor";
import { balanceCents, getJob } from "@/lib/services/jobs";
import { listActiveStaff } from "@/lib/services/users";
import { formatCents } from "@/lib/money";
import { formatDateTime } from "@/lib/format";
import { formatPhone } from "@/lib/phone";
import { formatAddress } from "@/lib/notifications/discord-embeds";
import { RecordFinalPaymentForm, ScheduleVisitForm, VisitList } from "@/components/ops/ops-forms";
import { InvoiceButton, JobDurationForm } from "./job-parts";

export const metadata: Metadata = { title: "Job" };

export default async function JobPage({ params }: PageProps<"/jobs/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  const job = await getJob(user, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const staff = user.role === "owner" ? await listActiveStaff() : [];
  const balance = balanceCents(job);
  const option = job.proposal.options.find((o) => o.id === (job.proposal.signedOptionId ?? job.proposal.selectedOptionId));
  const address = formatAddress(job.lead.property);
  const isOwner = user.role === "owner";

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4 p-4 lg:grid-cols-[1fr_340px]">
      <div className="space-y-4">
        <div>
          <Link href={`/leads/${job.leadId}`} className="text-sm text-brand hover:underline">
            ← {job.lead.customer.name}
          </Link>
          <h1 className="mt-1 text-xl font-semibold">{job.title}</h1>
          <p className="text-sm text-gray-500 capitalize">
            {job.status.replace("_", " ")} · {address}
            {job.lead.customer.phone ? ` · ${formatPhone(job.lead.customer.phone)}` : ""}
          </p>
        </div>

        <section className="card p-4">
          <h2 className="font-semibold">Visits</h2>
          <div className="mt-2">
            <VisitList
              canEdit={isOwner}
              visits={job.visits.map((v) => ({
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
          {isOwner && ["unscheduled", "scheduled", "in_progress"].includes(job.status) && (
            <div className="mt-4 border-t pt-4">
              <h3 className="mb-2 text-sm font-semibold">Schedule a job visit</h3>
              <ScheduleVisitForm
                leadId={job.leadId}
                jobId={job.id}
                kind="job"
                techs={staff.map((s) => ({ id: s.id, name: s.name }))}
                defaultTechId={job.assignedToId}
                defaultHours={Math.min(job.durationHours, 10)}
              />
              <p className="mt-2 text-xs text-gray-500">
                Multi-day jobs get one visit per day. Or drag it onto the <Link href="/dispatch" className="underline">dispatch board</Link>.
              </p>
            </div>
          )}
        </section>

        {option && (
          <section className="card p-4">
            <h2 className="font-semibold">Scope: {option.title}</h2>
            <ul className="mt-2 list-disc pl-5 text-sm text-gray-700">
              {option.lineItems.filter((l) => !l.isOptional).map((l) => (
                <li key={l.id}>
                  {l.description}
                  {l.qty !== 1 ? ` × ${l.qty} ${l.unit}` : ""}
                </li>
              ))}
            </ul>
            <Link href={`/proposals/${job.proposalId}`} className="mt-2 inline-block text-sm text-brand underline">
              Signed proposal
            </Link>
          </section>
        )}
      </div>

      <aside className="space-y-4">
        <section className="card space-y-1 p-4 text-sm">
          <h2 className="font-semibold">Money</h2>
          <p>Total {formatCents(job.totalCents, { cents: true })}</p>
          {job.payments.map((p) => (
            <p key={p.id} className={p.status === "succeeded" ? "text-gray-700" : "text-red-700"}>
              {p.kind} · {p.method.replace("_", " ")}
              {p.cardLast4 ? ` •••• ${p.cardLast4}` : ""} · {formatCents(p.amountCents, { cents: true })} {p.status !== "succeeded" ? `(${p.status})` : ""}
            </p>
          ))}
          <p className="pt-1 font-semibold">Balance {formatCents(Math.max(0, balance), { cents: true })}</p>
          {job.invoiceLink && (
            <a href={job.invoiceLink} target="_blank" rel="noreferrer" className="text-brand underline">
              QuickBooks invoice
            </a>
          )}
        </section>
        {isOwner && balance > 0 && !job.quickbooksInvoiceId && ["completed", "in_progress", "scheduled"].includes(job.status) && (
          <section className="card p-4 text-sm">
            <h2 className="font-semibold">Final invoice</h2>
            <p className="mt-1 text-gray-600">Created automatically when the last visit is completed. You can also send it now.</p>
            <div className="mt-2">
              <InvoiceButton jobId={job.id} />
            </div>
          </section>
        )}
        {isOwner && balance > 0 && (
          <section className="card p-4">
            <h2 className="mb-2 text-sm font-semibold">Record a payment</h2>
            <RecordFinalPaymentForm jobId={job.id} defaultDollars={(balance / 100).toFixed(2)} />
          </section>
        )}
        {isOwner && (
          <section className="card p-4">
            <JobDurationForm jobId={job.id} hours={job.durationHours} />
          </section>
        )}
      </aside>
    </div>
  );
}
