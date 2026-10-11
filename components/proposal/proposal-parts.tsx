// Presentational pieces shared by the client page, owner preview and the PDF. No hooks: safe in
// server and client components.

import { formatCents } from "@/lib/money";
import { TIER_LABELS } from "@/lib/tiers";
import type { OptionView, ProposalView } from "@/lib/proposal-view";

export function CompanyHeader({ view }: { view: ProposalView }) {
  const c = view.company;
  return (
    <header className="flex items-center gap-4 border-b border-gray-200 pb-4">
      {c.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- streamed from private storage
        <img src={c.logoUrl} alt={c.name} className="h-12 w-auto max-w-[160px] object-contain" />
      ) : (
        <div className="text-xl font-bold text-brand">{c.name}</div>
      )}
      <div className="ml-auto text-right text-xs leading-5 text-gray-600">
        {c.logoUrl && <div className="font-semibold text-gray-900">{c.name}</div>}
        {c.phone && (c.phoneHref ? <a href={c.phoneHref} className="block text-brand">{c.phone}</a> : <div>{c.phone}</div>)}
        {c.email && <div>{c.email}</div>}
        {c.address && <div>{c.address}</div>}
        {c.licenseNumber && <div>License #{c.licenseNumber}</div>}
      </div>
    </header>
  );
}

export function ProposalIntro({ view }: { view: ProposalView }) {
  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-gray-600">Estimate for</p>
          <h1 className="text-2xl font-semibold text-gray-900">{view.customerName}</h1>
          {view.address && <p className="text-sm text-gray-600">{view.address}</p>}
          <p className="mt-1 text-sm text-gray-600">{view.jobTitle}</p>
        </div>
        <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 text-sm">
          <dt className="text-gray-600">Estimate</dt>
          <dd className="text-right font-semibold text-gray-900 tabular-nums">{view.number}</dd>
          <dt className="text-gray-600">Date</dt>
          <dd className="text-right text-gray-900">{view.issuedOn}</dd>
          {view.expires && (
            <>
              <dt className="text-gray-600">Valid until</dt>
              <dd className="text-right text-gray-900">{view.expires}</dd>
            </>
          )}
        </dl>
      </div>
      {view.summary && <p className="mt-4 leading-relaxed text-gray-800">{view.summary}</p>}
    </section>
  );
}

export function OptionPrice({ option, taxLabel }: { option: OptionView; taxLabel: string }) {
  return (
    <div>
      <div className="text-3xl font-bold text-gray-900">{formatCents(option.totalCents)}</div>
      <div className="text-xs text-gray-500">
        {option.taxCents > 0
          ? `includes ${formatCents(option.taxCents, { cents: true })} sales tax${taxLabel ? ` (${taxLabel})` : ""}`
          : "no sales tax applied"}
      </div>
    </div>
  );
}

/** What's included (scope only, no per-line prices), the package price, then optional add-ons with their prices. */
export function LineItemTable({ option }: { option: OptionView }) {
  const included = option.items.filter((i) => !i.isOptional);
  const optional = option.items.filter((i) => i.isOptional);
  return (
    <div className="text-sm">
      <ul className="list-disc space-y-1 pl-5 text-gray-800">
        {included.map((i) => (
          <li key={i.id}>
            {i.description}
            {i.qty !== 1 ? <span className="text-gray-600"> ({i.qty} {i.unit})</span> : null}
          </li>
        ))}
      </ul>
      <table className="mt-3 w-full">
        <tbody>
          <tr className="border-t border-gray-200">
            <td className="pt-2 text-gray-600">Package price</td>
            <td className="pt-2 text-right tabular-nums">{formatCents(option.subtotalCents, { cents: true })}</td>
          </tr>
          <tr>
            <td className="text-gray-600">Sales tax</td>
            <td className="text-right tabular-nums">{formatCents(option.taxCents, { cents: true })}</td>
          </tr>
          <tr className="font-semibold">
            <td>Total</td>
            <td className="text-right tabular-nums">{formatCents(option.totalCents, { cents: true })}</td>
          </tr>
        </tbody>
      </table>
      {optional.length > 0 && (
        <>
          <p className="mt-3 text-xs font-semibold text-gray-600">Optional add-ons (not included in the total)</p>
          <table className="mt-1 w-full">
            <tbody>
              {optional.map((i) => (
                <tr key={i.id} className="border-t border-gray-100 align-top">
                  <td className="py-1.5 pr-2">
                    {i.description}
                    {i.qty !== 1 ? <span className="text-gray-600"> ({i.qty} {i.unit})</span> : null}
                  </td>
                  <td className="py-1.5 text-right whitespace-nowrap tabular-nums">{formatCents(i.totalCents, { cents: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

/** Deposit + milestones with amounts for this package. Renders nothing without a schedule. */
export function PaymentSchedule({ option }: { option: OptionView }) {
  if (!option.schedule.length) return null;
  return (
    <table className="w-full text-sm">
      <tbody>
        {option.schedule.map((m, i) => (
          <tr key={i} className="border-t border-gray-100">
            <td className="py-1.5 pr-2">{m.label}</td>
            <td className="py-1.5 pr-2 text-right text-gray-600 tabular-nums">{m.percent}%</td>
            <td className="py-1.5 text-right tabular-nums">{formatCents(m.amountCents, { cents: true })}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TierBadge({ tier, recommended }: { tier: OptionView["tier"]; recommended: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-semibold tracking-wide text-gray-500 uppercase">{TIER_LABELS[tier]}</span>
      {recommended && <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-white">Recommended</span>}
    </div>
  );
}

export function KeyTerms({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
      {lines.map((l, i) => (
        <li key={i}>{l}</li>
      ))}
    </ul>
  );
}

export function AssumptionsAndExclusions({ view }: { view: ProposalView }) {
  if (!view.assumptions.length && !view.exclusions.length) return null;
  return (
    <section className="mt-6 grid gap-4 text-sm sm:grid-cols-2">
      {view.assumptions.length > 0 && (
        <div>
          <h3 className="font-semibold text-gray-900">Assumptions</h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-gray-700">
            {view.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}
      {view.exclusions.length > 0 && (
        <div>
          <h3 className="font-semibold text-gray-900">Not included</h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-gray-700">
            {view.exclusions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
