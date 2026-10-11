import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { NotFoundError } from "@/lib/services/actor";
import { getProposal, proposalLink, proposalTextStatus, sendProblems } from "@/lib/services/proposals";
import { listPriceBook } from "@/lib/services/pricebook";
import { getCompany } from "@/lib/services/company";
import { formatDateTime } from "@/lib/format";
import { formatRate } from "@/lib/money";
import { formatPhone } from "@/lib/phone";
import { ProposalEditor } from "./proposal-editor";
import { CopyLink, ReviseButton, SendPanel } from "./send-panel";
import { db } from "@/lib/db";
import { depositPercentFor } from "@/lib/services/company";
import { formatCents } from "@/lib/money";
import { RecordDepositForm } from "@/components/ops/ops-forms";
import { estimateNumber } from "@/lib/estimate";
import { TIER_LABELS } from "@/lib/tiers";

export const metadata: Metadata = { title: "Proposal" };

const STATUS: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Viewed",
  signed: "Signed",
  declined: "Declined by the customer",
  superseded: "Replaced by a newer version",
};

export default async function ProposalPage({ params }: PageProps<"/proposals/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  const p = await getProposal(user, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const [book, company, textStatus, changeRequests] = await Promise.all([
    listPriceBook({ trade: p.lead.trade }),
    getCompany(),
    p.token ? proposalTextStatus(p.id) : null,
    db.activity.findMany({ where: { type: "change_requested", data: { path: ["proposalId"], equals: p.id } }, orderBy: { createdAt: "desc" }, take: 10 }),
  ]);
  const editable = p.status === "draft";
  const [signature, job] = p.status === "signed"
    ? await Promise.all([db.signature.findUnique({ where: { proposalId: p.id } }), db.job.findUnique({ where: { proposalId: p.id } })])
    : [null, null];
  const signedOption = p.options.find((o) => o.id === (p.signedOptionId ?? p.selectedOptionId));
  const depositCents = signedOption ? Math.round((signedOption.totalCents * depositPercentFor(signedOption.totalCents, company, p.depositPercent)) / 100) : 0;
  const customer = p.lead.customer;

  return (
    <div className="mx-auto grid w-full max-w-7xl gap-4 p-4 lg:grid-cols-[1fr_300px]">
      <div className="min-w-0">
        <Link href={`/leads/${p.leadId}`} className="text-sm text-brand hover:underline">
          ← {customer.name}
        </Link>
        <h1 className="mt-1 text-xl font-semibold">
          Estimate {estimateNumber(p)}: {p.lead.title}
        </h1>
        <p className="text-sm text-gray-500">
          {STATUS[p.status]}
          {p.aiModel ? ` · drafted by Claude (${p.aiModel})` : ""} · Sales tax{" "}
          {p.taxLabel || (p.taxRateBps ? formatRate(p.taxRateBps) : "not found for this address")}
        </p>
        <ProposalEditor
          proposalId={p.id}
          editable={editable}
          isOwner={user.role === "owner"}
          trade={p.lead.trade}
          taxRateBps={p.taxRateBps}
          deposit={{
            override: p.depositPercent,
            thresholdCents: company.depositThresholdCents,
            below: company.depositBelowPercent,
            above: company.depositAbovePercent,
          }}
          priceBook={book.map((i) => ({ id: i.id, name: i.name, unit: i.unit, priceCents: i.priceCents, costCents: i.costCents, category: i.category }))}
          initial={{
            summary: p.summary,
            recommendedTier: p.recommendedTier,
            assumptions: p.assumptions,
            exclusions: p.exclusions,
            milestones: p.milestones.map((m) => ({ key: m.id, label: m.label, percent: m.percent })),
            options: p.options.map((o) => ({
              tier: o.tier,
              title: o.title,
              summary: o.summary,
              highlights: o.highlights,
              warrantyText: o.warrantyText,
              priceCents: o.priceCents,
              lineItems: o.lineItems.map((l) => ({
                key: l.id,
                description: l.description,
                qty: l.qty,
                unit: l.unit,
                unitCents: l.unitCents,
                isOptional: l.isOptional,
                priceBookItemId: l.priceBookItemId,
              })),
            })),
          }}
        />
        {p.inputNotes && (
          <details className="card mt-4 p-4 text-sm">
            <summary className="cursor-pointer font-medium">Notes Claude drafted from</summary>
            <p className="mt-2 whitespace-pre-wrap text-gray-700">{p.inputNotes}</p>
          </details>
        )}
      </div>

      <aside className="space-y-4">
        {(p.status === "declined" || changeRequests.length > 0) && (
          <section className="card space-y-2 p-4 text-sm">
            <h2 className="font-semibold">Customer response</h2>
            {p.status === "declined" && (
              <p className="text-red-800">
                Declined {p.declinedAt ? formatDateTime(p.declinedAt) : ""}: {p.declineReason}
              </p>
            )}
            {changeRequests.map((a) => (
              <div key={a.id}>
                <p className="text-xs text-gray-600">Change request · {formatDateTime(a.createdAt)}</p>
                <p className="whitespace-pre-line text-gray-900">{(a.body ?? "").replace(/^Change request on estimate [^:]+: /, "")}</p>
              </div>
            ))}
            {changeRequests.length > 0 && p.status !== "draft" && <p className="text-xs text-gray-600">Make a revision to send an updated estimate.</p>}
          </section>
        )}
        {p.status === "signed" && signedOption && (
          <section className="card space-y-1 border-green-600 p-4 text-sm">
            <h2 className="font-semibold text-green-700">Signed ✓</h2>
            <p>
              <strong>{signedOption.title}</strong> · {formatCents(signedOption.totalCents, { cents: true })}
            </p>
            {signature && (
              <p className="text-gray-600">
                {signature.signerName} ({signature.signerEmail}) · {formatDateTime(signature.signedAt)} · T&amp;C v{signature.termsVersion}
                {signature.ip ? ` · IP ${signature.ip}` : ""}
              </p>
            )}
            <p className="pt-1">
              Deposit {formatCents(depositCents, { cents: true })}:{" "}
              {p.depositPaidAt ? <span className="font-medium text-green-700">received {formatDateTime(p.depositPaidAt)}</span> : <span className="text-amber-800">not paid yet</span>}
            </p>
            {!p.depositPaidAt && p.depositChoice && (
              <p className="text-gray-700">
                Customer chose: {{ card: "card", ach: "bank transfer (QuickBooks invoice)", check: "check / in person", financing: "Acorn financing" }[p.depositChoice] ?? p.depositChoice}
                {p.depositInvoiceLink && (
                  <>
                    {" "}
                    ·{" "}
                    <a href={p.depositInvoiceLink} target="_blank" rel="noreferrer" className="text-brand underline">
                      invoice
                    </a>
                  </>
                )}
              </p>
            )}
            {job && (
              <Link href={`/jobs/${job.id}`} className="font-medium text-brand underline">
                Open the job →
              </Link>
            )}
            {!p.depositPaidAt && user.role === "owner" && (
              <div className="border-t pt-3">
                <RecordDepositForm proposalId={p.id} defaultDollars={(depositCents / 100).toFixed(2)} />
              </div>
            )}
          </section>
        )}
        <section className="card p-4 text-sm">
          <h2 className="font-semibold">Preview</h2>
          <p className="mt-1 text-gray-600">See it the way the customer will, or download a PDF of one option.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Link href={`/proposals/${p.id}/preview`} className="btn-secondary" target="_blank">
              Customer view
            </Link>
            {p.options.map((o) => (
              <a key={o.id} href={`/proposals/${p.id}/pdf?option=${o.id}`} className="btn-secondary">
                PDF: {TIER_LABELS[o.tier]}
              </a>
            ))}
          </div>
        </section>

        {editable && user.role === "owner" && (
          <SendPanel
            proposalId={p.id}
            problems={sendProblems(p)}
            customerName={customer.name}
            phone={customer.phone ? formatPhone(customer.phone) : null}
            optedOut={customer.smsOptOut}
          />
        )}
        {editable && user.role !== "owner" && (
          <section className="card space-y-2 p-4 text-sm">
            <h2 className="font-semibold">Go over it with the customer</h2>
            {sendProblems(p).length > 0 ? (
              <p className="text-amber-800">Before presenting: {sendProblems(p).join(" ")}</p>
            ) : (
              <a href={`/proposals/${p.id}/present`} target="_blank" rel="noreferrer" className="btn-primary w-full">
                Present to customer
              </a>
            )}
            <p className="text-xs text-gray-500">
              Presenting locks this version so the customer can sign on this device. To text the link instead, ask the owner.
            </p>
          </section>
        )}

        {p.token && (
          <section className="card space-y-2 p-4 text-sm">
            <h2 className="font-semibold">Customer link</h2>
            {p.status !== "superseded" && (
              <a href={`/proposals/${p.id}/present`} target="_blank" rel="noreferrer" className="btn-primary w-full">
                Present to customer
              </a>
            )}
            <p className="text-xs text-gray-500">Opens it on this device without the phone check, for going over it in person.</p>
            <CopyLink link={proposalLink(p.token)} />
            <p className={textStatus && !textStatus.texted ? "text-amber-800" : "text-gray-600"}>
              {textStatus?.texted
                ? `Texted to the customer${textStatus.to ? ` at ${formatPhone(textStatus.to)}` : ""}.`
                : textStatus
                  ? `Not texted: ${textStatus.reason}`
                  : "Not texted. Copy the link and send it yourself."}
            </p>
            <p className="text-gray-600">
              Sent {p.sentAt ? formatDateTime(p.sentAt) : "—"} · expires {p.expiresAt ? formatDateTime(p.expiresAt) : "—"}
            </p>
            <p className="text-gray-600">
              {p.viewCount
                ? `Viewed ${p.viewCount}× · last ${formatDateTime(p.lastViewedAt!)}`
                : "Not opened yet"}
              {p.lockedAt ? " · LOCKED after wrong answers" : ""}
            </p>
            {p.selectedOptionId && (
              <p className="text-gray-600">
                Customer is looking at: <strong>{p.options.find((o) => o.id === p.selectedOptionId)?.title}</strong>
              </p>
            )}
          </section>
        )}
        {!editable && p.status !== "signed" && <ReviseButton proposalId={p.id} />}
      </aside>
    </div>
  );
}
