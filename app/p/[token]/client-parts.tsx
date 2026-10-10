"use client";

import { useActionState, useState, useTransition } from "react";
import { formatCents } from "@/lib/money";
import type { ProposalView } from "@/lib/proposal-view";
import {
  AssumptionsAndExclusions,
  CompanyHeader,
  KeyTerms,
  LineItemTable,
  OptionPrice,
  ProposalIntro,
  TierBadge,
} from "@/components/proposal/proposal-parts";
import { freshLinkAction, gateAction, selectOptionAction, startSigningAction, termsCheckedAction } from "./actions";

export function GateForm({ token, kind }: { token: string; kind: "phone" | "email" }) {
  const [state, action, pending] = useActionState(gateAction.bind(null, token), undefined);
  return (
    <form action={action} className="mt-4 space-y-3 text-left">
      <label className="label" htmlFor="answer">
        {kind === "phone"
          ? "To keep it private, enter the last 4 digits of your phone number"
          : "To keep it private, enter your email address"}
      </label>
      <input
        id="answer"
        name="answer"
        className="input text-center text-lg tracking-widest"
        inputMode={kind === "phone" ? "numeric" : "email"}
        autoComplete={kind === "phone" ? "off" : "email"}
        maxLength={kind === "phone" ? 4 : 200}
        required
        disabled={state?.locked}
        autoFocus
      />
      <button className="btn-primary w-full" disabled={pending || state?.locked}>
        {pending ? "Checking…" : "View proposal"}
      </button>
      {state?.error && <p className="text-sm text-red-700">{state.error}</p>}
    </form>
  );
}

export function FreshLinkButton({ token }: { token: string }) {
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();
  if (done) return <p className="font-medium text-green-700">Thanks! We&apos;ll send you an updated proposal shortly.</p>;
  return (
    <button
      className="btn-primary"
      disabled={pending}
      onClick={() => start(async () => setDone((await freshLinkAction(token)).done))}
    >
      Request an updated proposal
    </button>
  );
}

export function ProposalChooser({
  view,
  token,
  termsHref,
  signer,
  waitingForSignature,
}: {
  view: ProposalView;
  token: string;
  termsHref: string | null;
  signer: { name: string; email: string };
  waitingForSignature: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(view.selectedOptionId);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();
  const [name, setName] = useState(signer.name);
  const [email, setEmail] = useState(signer.email);
  const [signing, startSigning] = useTransition();

  function sign() {
    if (!chosen) return;
    setError(null);
    startSigning(async () => {
      const res = await startSigningAction(token, { optionId: chosen.id, name, email, termsAccepted: agreed });
      if (res.url) window.location.href = res.url;
      else setError(res.error ?? "Something went wrong.");
    });
  }
  const chosen = view.options.find((o) => o.id === selected) ?? null;

  function choose(optionId: string) {
    setSelected(optionId);
    setAgreed(false);
    setError(null);
    start(async () => {
      const res = await selectOptionAction(token, optionId);
      if (res.error) setError(res.error);
    });
    requestAnimationFrame(() => document.getElementById("approve")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  return (
    <div>
      <CompanyHeader view={view} />
      <ProposalIntro view={view} />

      <section className="mt-6 grid gap-4 md:grid-cols-3" aria-label="Options">
        {view.options.map((o) => {
          const isSelected = o.id === selected;
          const recommended = o.tier === view.recommendedTier;
          return (
            <article
              key={o.id}
              data-option={o.tier}
              className={`flex flex-col rounded-xl border-2 bg-white p-5 shadow-sm transition ${
                isSelected ? "border-brand ring-4 ring-brand/15" : recommended ? "border-accent/60" : "border-gray-200"
              }`}
            >
              <TierBadge tier={o.tier} recommended={recommended} />
              <h2 className="mt-2 text-lg font-semibold text-gray-900">{o.title}</h2>
              <div className="mt-2">
                <OptionPrice option={o} taxLabel={view.taxLabel} />
              </div>
              {o.summary && <p className="mt-3 text-sm text-gray-700">{o.summary}</p>}
              <ul className="mt-3 space-y-1.5 text-sm text-gray-800">
                {o.highlights.map((h, i) => (
                  <li key={i} className="flex gap-2">
                    <span aria-hidden className="text-green-600">✓</span>
                    {h}
                  </li>
                ))}
              </ul>
              {o.warrantyText && <p className="mt-3 text-xs text-gray-500">Warranty: {o.warrantyText}</p>}
              <button
                className="mt-3 self-start text-sm text-brand underline"
                aria-expanded={Boolean(expanded[o.id])}
                onClick={() => setExpanded((e) => ({ ...e, [o.id]: !e[o.id] }))}
              >
                {expanded[o.id] ? "Hide details" : "See what's included"}
              </button>
              {expanded[o.id] && (
                <div className="mt-2">
                  <LineItemTable option={o} />
                </div>
              )}
              <div className="mt-auto pt-4">
                <button
                  className={isSelected ? "btn-primary w-full" : "btn-secondary w-full"}
                  onClick={() => choose(o.id)}
                  aria-pressed={isSelected}
                >
                  {isSelected ? "Selected" : "Choose this option"}
                </button>
              </div>
            </article>
          );
        })}
      </section>

      {error && <p className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {chosen && (
        <section id="approve" className="mt-8 scroll-mt-4 rounded-xl border border-gray-200 bg-gray-50 p-5">
          <h2 className="text-lg font-semibold">You chose: {chosen.title}</h2>
          <p className="mt-1 text-sm text-gray-700">
            Total {formatCents(chosen.totalCents, { cents: true })} · Deposit due on approval{" "}
            <strong>{formatCents(chosen.depositCents, { cents: true })}</strong> ({chosen.depositPercent}%)
          </p>
          <h3 className="mt-4 text-sm font-semibold">Key terms</h3>
          <div className="mt-1">
            <KeyTerms lines={chosen.keyTerms} />
          </div>
          <label className="mt-4 flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-5 w-5"
              checked={agreed}
              onChange={(e) => {
                setAgreed(e.target.checked);
                if (e.target.checked) start(() => termsCheckedAction(token));
              }}
            />
            <span>
              I&apos;ve read and agree to the full{" "}
              {termsHref ? (
                <a href={termsHref} target="_blank" rel="noreferrer" className="text-brand underline">
                  Terms &amp; Conditions
                </a>
              ) : (
                "Terms & Conditions"
              )}
              .
            </span>
          </label>
          {agreed && (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="signer-name">
                  Your full name
                </label>
                <input id="signer-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
              </div>
              <div>
                <label className="label" htmlFor="signer-email">
                  Email for your signed copy
                </label>
                <input
                  id="signer-email"
                  className="input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                />
              </div>
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button className="btn-primary px-6 py-3 text-base" disabled={!agreed || signing} onClick={sign}>
              {signing ? "Preparing your document…" : "Approve & sign"}
            </button>
            <a href={`/p/${token}/pdf`} className="btn-secondary">
              Download PDF
            </a>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            {agreed ? "You'll sign securely with Documenso and come right back here for the deposit." : "Check the box above to continue."}
          </p>
        </section>
      )}
      {waitingForSignature && (
        <p className="mt-4 rounded-md bg-amber-50 p-3 text-sm text-amber-800">
          We&apos;re still waiting for the signature to finish. If you completed signing, refresh this page in a minute.
        </p>
      )}

      <AssumptionsAndExclusions view={view} />

      <footer className="mt-10 border-t border-gray-200 pt-4 text-center text-xs text-gray-500">
        Questions? Call {view.company.phone || view.company.name}
        {view.company.email ? ` or email ${view.company.email}` : ""}. Proposal v{view.version}.
      </footer>
    </div>
  );
}
