import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { verifyPrintSignature } from "@/lib/pdf";
import { buildProposalView, TIER_LABELS } from "@/lib/proposal-view";
import { formatCents } from "@/lib/money";
import { getCompany } from "@/lib/services/company";
import { currentTerms } from "@/lib/services/terms";
import { Markdown } from "@/components/markdown/markdown";
import { signatureFont } from "@/components/proposal/signature-font";
import { getBlobStore } from "@/lib/integrations/blob";
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
      signature: true,
    },
  });
  if (!p) notFound();
  // The signed copy shows the signature (only for the option that was signed).
  const sig = p.signature?.optionId === optionId ? p.signature : null;
  const sigImage = sig?.signatureImagePath ? await getBlobStore().get(sig.signatureImagePath) : null;
  const audit = sig
    ? await db.activity.findMany({
        where: { leadId: p.leadId, type: { in: ["proposal_sent", "proposal_viewed", "option_selected", "terms_checked", "proposal_signed"] }, createdAt: { gte: p.sentAt ?? p.createdAt } },
        orderBy: { createdAt: "asc" },
        take: 40,
      })
    : [];
  const company = await getCompany();
  // Drafts (owner preview) show the current T&C; sent proposals show the version they were sent with.
  const terms = p.terms ?? (await currentTerms());
  const view = buildProposalView({ ...p, terms: terms ?? null }, company);
  const option = view.options.find((o) => o.id === optionId);
  if (!option) notFound();
  const others = view.options.filter((o) => o.id !== optionId);

  return (
    <main className="bg-white text-gray-900 [print-color-adjust:exact]">
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

      {terms && (
        <section className="mt-10 break-before-page">
          <Markdown>{terms.body}</Markdown>
        </section>
      )}

      {/* Acceptance page: blank lines on an unsigned copy; the customer's signature on the signed copy. */}
      <section className="break-before-page" style={{ height: "9in" }}>
        <div style={{ height: "1.5in", overflow: "hidden" }}>
          <h3 className="text-lg font-semibold">Acceptance</h3>
          <p className="mt-1 text-sm">
            I accept <strong>{option.title}</strong> for {formatCents(option.totalCents, { cents: true })} (deposit{" "}
            {formatCents(option.depositCents, { cents: true })}) and the Terms &amp; Conditions
            {view.termsVersion ? ` (version ${view.termsVersion})` : ""} in this document.
          </p>
          <p className="mt-1 text-xs text-gray-500">
            {view.customerName} · {view.address} · Proposal v{view.version}
          </p>
        </div>
        <div className="flex" style={{ gap: "0.5in" }}>
          <div style={{ width: "4.25in", height: "0.8in" }} className="relative flex flex-col justify-end border-b border-gray-900">
            {sig?.method === "typed" && (
              <span className={`${signatureFont.className} absolute bottom-1 left-2 text-4xl leading-none`}>{sig.typedSignature}</span>
            )}
            {sigImage && (
              // eslint-disable-next-line @next/next/no-img-element -- inlined from private storage
              <img src={`data:image/png;base64,${sigImage.body.toString("base64")}`} alt="Signature" className="absolute bottom-0 left-0 h-full w-auto object-contain" />
            )}
            {sig?.method === "paper" && <span className="absolute bottom-1 left-2 text-sm">Signed on paper (recorded by {view.company.name})</span>}
            <span className="-mb-5 text-xs text-gray-500">Customer signature</span>
          </div>
          <div style={{ width: "2.5in", height: "0.5in" }} className="relative flex flex-col justify-end border-b border-gray-900">
            {sig && <span className="absolute bottom-1 left-2 text-sm">{AUDIT_TIME.format(sig.signedAt)}</span>}
            <span className="-mb-5 text-xs text-gray-500">Date</span>
          </div>
        </div>
        <div style={{ marginTop: "0.4in", width: "4.25in", height: "0.4in" }} className="relative flex flex-col justify-end border-b border-gray-900">
          {sig && <span className="absolute bottom-1 left-2 text-sm">{sig.signerName}</span>}
          <span className="-mb-5 text-xs text-gray-500">Printed name</span>
        </div>
      </section>

      {sig && (
        <section className="break-before-page text-sm">
          <h3 className="text-lg font-semibold">Signature certificate</h3>
          <p className="mt-1 text-xs text-gray-500">
            Electronic signature under the U.S. ESIGN Act and the Ohio Uniform Electronic Transactions Act (R.C. Chapter 1306).
          </p>
          <dl className="mt-4 grid grid-cols-[2.2in_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-gray-500">Document</dt>
            <dd>
              Proposal v{p.version} for {view.customerName} · {option.title} · {formatCents(option.totalCents, { cents: true })}
            </dd>
            <dt className="text-gray-500">Signed by</dt>
            <dd>
              {sig.signerName}
              {sig.signerEmail ? ` <${sig.signerEmail}>` : ""}
            </dd>
            <dt className="text-gray-500">Signature</dt>
            <dd>{sig.method === "drawn" ? "Drawn on screen" : sig.method === "typed" ? "Typed name, adopted as signature" : "Signed on paper, recorded by the company"}</dd>
            <dt className="text-gray-500">Signed at</dt>
            <dd>{AUDIT_TIME.format(sig.signedAt)} (Eastern)</dd>
            {sig.consentAt && (
              <>
                <dt className="text-gray-500">Consent to sign electronically</dt>
                <dd>{AUDIT_TIME.format(sig.consentAt)}</dd>
              </>
            )}
            <dt className="text-gray-500">Terms &amp; Conditions</dt>
            <dd>
              Version {sig.termsVersion}, accepted {AUDIT_TIME.format(sig.termsAcceptedAt)}
            </dd>
            <dt className="text-gray-500">Identity check</dt>
            <dd>{sig.phoneVerified ? "Opened the private link texted to the customer and confirmed the last 4 digits of their phone" : "None (recorded by the company)"}</dd>
            <dt className="text-gray-500">IP address</dt>
            <dd>{sig.ip ?? "—"}</dd>
            <dt className="text-gray-500">Device</dt>
            <dd className="break-all">{sig.userAgent ?? "—"}</dd>
            <dt className="text-gray-500">Agreement fingerprint</dt>
            <dd className="font-mono text-xs break-all">SHA-256 {sig.contentHash}</dd>
          </dl>
          <h4 className="mt-6 font-semibold">History</h4>
          <ol className="mt-2 space-y-1 text-xs">
            {audit.map((a) => {
              const d = (a.data ?? {}) as { ip?: string };
              return (
                <li key={a.id}>
                  {AUDIT_TIME.format(a.createdAt)} · {AUDIT_LABEL[a.type] ?? a.type}
                  {a.body ? ` · ${a.body}` : ""}
                  {d.ip ? ` · IP ${d.ip}` : ""}
                </li>
              );
            })}
          </ol>
          <p className="mt-6 text-xs text-gray-500">
            The fingerprint is calculated from the selected option, its line items and totals, and the full Terms &amp; Conditions text. Any change to those
            would produce a different fingerprint. The company keeps this record and a SHA-256 hash of this PDF.
          </p>
        </section>
      )}
    </main>
  );
}

const AUDIT_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

const AUDIT_LABEL: Record<string, string> = {
  proposal_sent: "Proposal sent",
  proposal_viewed: "Customer opened the proposal",
  option_selected: "Customer chose an option",
  terms_checked: "Customer agreed to the Terms & Conditions",
  proposal_signed: "Signed",
};
