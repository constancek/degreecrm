"use client";

import { useState, useTransition } from "react";
import { reviseAction, sendProposalAction } from "../actions";

export function SendPanel(props: {
  proposalId: string;
  problems: string[];
  customerName: string;
  phone: string | null;
  optedOut: boolean;
}) {
  const canText = Boolean(props.phone) && !props.optedOut;
  const [textCustomer, setTextCustomer] = useState(canText);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ error?: string; link?: string; texted?: boolean; textError?: string | null } | null>(null);

  // After a successful send the page re-renders in its "sent" layout (link + text status); nothing to show here.
  return (
    <section className="card space-y-3 p-4 text-sm">
      <h2 className="font-semibold">Send to customer</h2>
      {props.problems.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5 text-amber-800">
          {props.problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      ) : (
        <p className="text-gray-600">Ready to send. The link works for 30 days.</p>
      )}
      <label className={`flex items-start gap-2 ${canText ? "" : "text-gray-400"}`}>
        <input type="checkbox" checked={textCustomer} disabled={!canText} onChange={(e) => setTextCustomer(e.target.checked)} />
        <span>
          {canText
            ? `Text the link to ${props.customerName} at ${props.phone}`
            : props.optedOut
              ? "Customer opted out of texts"
              : "No phone number on file"}
        </span>
      </label>
      <button
        className="btn-primary w-full"
        disabled={pending || props.problems.length > 0}
        onClick={() => start(async () => setResult(await sendProposalAction(props.proposalId, textCustomer)))}
      >
        {pending ? "Sending…" : "Send proposal"}
      </button>
      <p className="text-xs text-gray-500">Save your edits first; sending uses the saved version.</p>
      {result?.error && <p className="text-red-700">{result.error}</p>}
    </section>
  );
}

export function ReviseButton({ proposalId }: { proposalId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="card space-y-2 p-4 text-sm">
      <p className="text-gray-600">Sent proposals can&apos;t change. A revision copies this one into a new draft; sending it replaces this link.</p>
      <button
        className="btn-secondary w-full"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await reviseAction(proposalId);
            if (res?.error) setError(res.error);
          })
        }
      >
        {pending ? "Creating…" : "Create revision"}
      </button>
      {error && <p className="text-red-700">{error}</p>}
    </section>
  );
}

export function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <input readOnly value={link} className="input text-xs" onFocus={(e) => e.target.select()} aria-label="Proposal link" />
      <button
        className="btn-secondary px-3"
        onClick={async () => {
          await navigator.clipboard.writeText(link);
          setCopied(true);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
