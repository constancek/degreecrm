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

export const metadata: Metadata = { title: "Proposal" };

const STATUS: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Viewed",
  signed: "Signed",
  superseded: "Replaced by a newer version",
};

export default async function ProposalPage({ params }: PageProps<"/proposals/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  const p = await getProposal(user, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const [book, company, textStatus] = await Promise.all([
    listPriceBook({ trade: p.lead.trade }),
    getCompany(),
    p.token ? proposalTextStatus(p.id) : null,
  ]);
  const editable = p.status === "draft";
  const customer = p.lead.customer;

  return (
    <div className="mx-auto grid w-full max-w-7xl gap-4 p-4 xl:grid-cols-[1fr_320px]">
      <div className="min-w-0">
        <Link href={`/leads/${p.leadId}`} className="text-sm text-brand hover:underline">
          ← {customer.name}
        </Link>
        <h1 className="mt-1 text-xl font-semibold">
          Proposal v{p.version}: {p.lead.title}
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
            options: p.options.map((o) => ({
              tier: o.tier,
              title: o.title,
              summary: o.summary,
              highlights: o.highlights,
              warrantyText: o.warrantyText,
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
        <section className="card p-4 text-sm">
          <h2 className="font-semibold">Preview</h2>
          <p className="mt-1 text-gray-600">See it the way the customer will, or download a PDF of one option.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Link href={`/proposals/${p.id}/preview`} className="btn-secondary" target="_blank">
              Customer view
            </Link>
            {p.options.map((o) => (
              <a key={o.id} href={`/proposals/${p.id}/pdf?option=${o.id}`} className="btn-secondary">
                PDF: {o.tier}
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
          <p className="card p-4 text-sm text-gray-600">The owner reviews and sends proposals. Your draft is saved on the lead.</p>
        )}

        {p.token && (
          <section className="card space-y-2 p-4 text-sm">
            <h2 className="font-semibold">Customer link</h2>
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
