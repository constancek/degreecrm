import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { verifyPrintSignature } from "@/lib/pdf";
import { buildProposalView, TIER_LABELS } from "@/lib/proposal-view";
import { formatCents } from "@/lib/money";
import { getCompany } from "@/lib/services/company";
import { currentTerms } from "@/lib/services/terms";
import { Markdown } from "@/components/markdown/markdown";
import {
  AssumptionsAndExclusions,
  CompanyHeader,
  KeyTerms,
  LineItemTable,
  OptionPrice,
  ProposalIntro,
} from "@/components/proposal/proposal-parts";

export const metadata: Metadata = { title: { absolute: "Proposal" }, robots: { index: false } };

// Rendered only for the PDF renderer, via a short-lived signed link (lib/pdf.ts).
export default async function PrintProposal({ params, searchParams }: PageProps<"/print/proposal/[id]">) {
  const { id } = await params;
  const q = await searchParams;
  const optionId = String(q.option ?? "");
  if (!verifyPrintSignature(id, optionId, String(q.exp ?? ""), String(q.sig ?? ""))) notFound();

  const p = await db.proposal.findUnique({
    where: { id },
    include: {
      options: { orderBy: { sortOrder: "asc" }, include: { lineItems: { orderBy: { sortOrder: "asc" } } } },
      lead: { include: { customer: true, property: true } },
      terms: true,
    },
  });
  if (!p) notFound();
  const company = await getCompany();
  // Drafts (owner preview) show the current T&C; sent proposals show the version they were sent with.
  const terms = p.terms ?? (await currentTerms());
  const view = buildProposalView({ ...p, terms: terms ?? null }, company);
  const option = view.options.find((o) => o.id === optionId);
  if (!option) notFound();
  const others = view.options.filter((o) => o.id !== optionId);

  return (
    <main className="bg-white px-2 text-gray-900 [print-color-adjust:exact]">
      <CompanyHeader view={view} />
      <ProposalIntro view={view} />

      <section className="mt-6 rounded-lg border-2 border-brand p-5 break-inside-avoid">
        <p className="text-xs font-semibold tracking-wide text-gray-500 uppercase">Selected option · {TIER_LABELS[option.tier]}</p>
        <div className="mt-1 flex items-start justify-between gap-6">
          <h2 className="text-xl font-semibold">{option.title}</h2>
          <OptionPrice option={option} taxLabel={view.taxLabel} />
        </div>
        {option.summary && <p className="mt-2 text-sm">{option.summary}</p>}
        <ul className="mt-2 list-disc pl-5 text-sm">
          {option.highlights.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
        {option.warrantyText && <p className="mt-2 text-sm">Warranty: {option.warrantyText}</p>}
        <div className="mt-4">
          <LineItemTable option={option} />
        </div>
      </section>

      {others.length > 0 && (
        <p className="mt-3 text-xs text-gray-500">
          Other options offered: {others.map((o) => `${o.title} (${formatCents(o.totalCents)})`).join(", ")}.
        </p>
      )}

      <section className="mt-6 break-inside-avoid">
        <h3 className="font-semibold">Key terms</h3>
        <p className="mt-1 text-sm">
          Deposit due on approval: {formatCents(option.depositCents, { cents: true })} ({option.depositPercent}%).
        </p>
        <div className="mt-2">
          <KeyTerms lines={option.keyTerms} />
        </div>
      </section>

      <AssumptionsAndExclusions view={view} />

      <section className="mt-10 break-inside-avoid">
        <h3 className="font-semibold">Acceptance</h3>
        <p className="mt-1 text-sm">
          By signing, the customer accepts the selected option and the Terms &amp; Conditions
          {view.termsVersion ? ` (version ${view.termsVersion})` : ""} attached below.
        </p>
        <div className="mt-10 grid grid-cols-2 gap-10 text-sm">
          <div className="border-t border-gray-900 pt-1">Customer signature</div>
          <div className="border-t border-gray-900 pt-1">Date</div>
          <div className="border-t border-gray-900 pt-1">Printed name</div>
          <div className="border-t border-gray-900 pt-1">For {view.company.name}</div>
        </div>
      </section>

      {terms && (
        <section className="mt-10 break-before-page">
          <Markdown>{terms.body}</Markdown>
        </section>
      )}
    </main>
  );
}
