import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { NotFoundError } from "@/lib/services/actor";
import { getProposal } from "@/lib/services/proposals";
import { getCompany } from "@/lib/services/company";
import { currentTerms } from "@/lib/services/terms";
import { buildProposalView } from "@/lib/proposal-view";
import {
  AssumptionsAndExclusions,
  CompanyHeader,
  KeyTerms,
  LineItemTable,
  OptionPrice,
  ProposalIntro,
  TierBadge,
} from "@/components/proposal/proposal-parts";

export const metadata: Metadata = { title: "Customer view" };

// What the customer will see (all details expanded). Doesn't count as a view.
export default async function PreviewPage({ params }: PageProps<"/proposals/[id]/preview">) {
  const user = await requireUser();
  const { id } = await params;
  const p = await getProposal(user, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const [company, terms] = await Promise.all([getCompany(), p.terms ? null : currentTerms()]);
  const view = buildProposalView({ ...p, terms: p.terms ?? terms }, company);
  return (
    <div className="mx-auto w-full max-w-5xl bg-white p-6">
      <p className="mb-4 rounded-md bg-amber-50 p-2 text-center text-xs text-amber-800">Preview: this is what the customer sees after the phone check.</p>
      <CompanyHeader view={view} />
      <ProposalIntro view={view} />
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {view.options.map((o) => (
          <article key={o.id} className={`rounded-xl border-2 p-5 ${o.tier === view.recommendedTier ? "border-accent/60" : "border-gray-200"}`}>
            <TierBadge tier={o.tier} recommended={o.tier === view.recommendedTier} />
            <h2 className="mt-2 text-lg font-semibold">{o.title}</h2>
            <div className="mt-2">
              <OptionPrice option={o} taxLabel={view.taxLabel} />
            </div>
            {o.summary && <p className="mt-3 text-sm text-gray-700">{o.summary}</p>}
            <ul className="mt-3 space-y-1 text-sm">
              {o.highlights.map((h, i) => (
                <li key={i}>✓ {h}</li>
              ))}
            </ul>
            <div className="mt-4">
              <LineItemTable option={o} />
            </div>
            <h3 className="mt-4 text-sm font-semibold">Key terms if chosen</h3>
            <KeyTerms lines={o.keyTerms} />
          </article>
        ))}
      </div>
      <AssumptionsAndExclusions view={view} />
    </div>
  );
}
