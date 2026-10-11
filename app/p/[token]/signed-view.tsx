"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { formatCents } from "@/lib/money";
import type { ProposalView } from "@/lib/proposal-view";
import { CompanyHeader, LineItemTable, PaymentSchedule, TierBadge } from "@/components/proposal/proposal-parts";
import { chooseDepositAction, payDepositAction } from "./actions";
import type { DepositChoice } from "@/lib/estimate";

export function SignedView(props: {
  view: ProposalView;
  token: string;
  optionId: string;
  deposit: { percent: number; amountCents: number; paid: boolean };
  canPayByCard: boolean;
  tokenizeUrl: string;
  acornLink: string | null;
  signedCopy: boolean;
  customerName: string;
  /** What the customer picked before (card | ach | check | financing) and the bank-transfer pay link, if any. */
  depositChoice: string | null;
  achLink: string | null;
}) {
  const option = props.view.options.find((o) => o.id === props.optionId)!;
  const phone = props.view.company.phone;
  return (
    <div>
      <CompanyHeader view={props.view} />
      <section className="mt-6 rounded-xl border-2 border-green-600 bg-green-50 p-5">
        <p className="text-sm font-semibold text-green-800">✓ Approved and signed</p>
        <TierBadge tier={option.tier} recommended={false} />
        <h1 className="mt-1 text-xl font-semibold">{option.title}</h1>
        <p className="text-sm text-gray-700">
          Total {formatCents(option.totalCents, { cents: true })} · {props.view.address}
        </p>
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-brand">What&apos;s included</summary>
          <div className="mt-2">
            <LineItemTable option={option} />
          </div>
        </details>
        <div className="mt-3 flex flex-wrap gap-3 text-sm">
          {props.signedCopy ? (
            <a href={`/p/${props.token}/signed-pdf`} className="btn-secondary">
              Download signed copy
            </a>
          ) : (
            <PreparingCopy />
          )}
        </div>
      </section>

      {props.deposit.paid ? (
        <section className="mt-6 rounded-xl border border-gray-200 p-5">
          <h2 className="text-lg font-semibold">Deposit received. Thank you!</h2>
          <p className="mt-1 text-sm text-gray-700">We&apos;ll text you shortly to schedule your job{phone ? `. Questions? Call ${phone}` : ""}.</p>
        </section>
      ) : (
        <section className="mt-6 rounded-xl border border-gray-200 p-5" id="deposit">
          <h2 className="text-lg font-semibold">Pay your deposit</h2>
          <p className="mt-1 text-sm text-gray-700">
            {formatCents(props.deposit.amountCents, { cents: true })} ({props.deposit.percent}%) reserves your spot on the schedule.
            {option.schedule.length ? " The rest follows the payment schedule below." : " The balance is due when the work is complete."}
          </p>
          {option.schedule.length > 0 && (
            <div className="mt-3 max-w-md">
              <PaymentSchedule option={option} />
            </div>
          )}
          <DepositChooser {...props} />
        </section>
      )}
    </div>
  );
}

function CardForm({ token, amountCents, tokenizeUrl, name }: { token: string; amountCents: number; tokenizeUrl: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    const [mm, yy] = String(fd.get("exp") ?? "").split("/").map((s) => s.trim());
    const number = String(fd.get("number") ?? "").replace(/\D/g, "");
    if (number.length < 13 || !mm || !yy) {
      setError("Check the card number and expiration date.");
      return;
    }
    setBusy(true);
    try {
      // Card details go straight from this browser to Intuit; we only receive a one-time token.
      const res = await fetch(tokenizeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          card: {
            number,
            expMonth: mm.padStart(2, "0"),
            expYear: yy.length === 2 ? `20${yy}` : yy,
            cvc: String(fd.get("cvc") ?? ""),
            name: String(fd.get("name") ?? ""),
            address: { postalCode: String(fd.get("zip") ?? "") },
          },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { value?: string; errors?: { message?: string; detail?: string }[] };
      if (!res.ok || !data.value) {
        setError(data.errors?.[0]?.detail || data.errors?.[0]?.message || "Please check your card details.");
        return;
      }
      const charged = await payDepositAction(token, data.value);
      if (charged.error) setError(charged.error);
      else router.refresh();
    } catch {
      setError("We couldn't reach the payment processor. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-6" autoComplete="on">
      <div className="sm:col-span-6">
        <label className="label" htmlFor="cc-name">
          Name on card
        </label>
        <input id="cc-name" name="name" className="input" defaultValue={name} autoComplete="cc-name" required />
      </div>
      <div className="sm:col-span-6">
        <label className="label" htmlFor="cc-number">
          Card number
        </label>
        <input id="cc-number" name="number" className="input" inputMode="numeric" autoComplete="cc-number" placeholder="1234 5678 9012 3456" required />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="cc-exp">
          Expires (MM/YY)
        </label>
        <input id="cc-exp" name="exp" className="input" inputMode="numeric" autoComplete="cc-exp" placeholder="08/29" required />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="cc-cvc">
          CVC
        </label>
        <input id="cc-cvc" name="cvc" className="input" inputMode="numeric" autoComplete="cc-csc" maxLength={4} required />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="cc-zip">
          Billing ZIP
        </label>
        <input id="cc-zip" name="zip" className="input" inputMode="numeric" autoComplete="postal-code" required />
      </div>
      <div className="sm:col-span-6">
        <button className="btn-primary w-full py-3 text-base" disabled={busy}>
          {busy ? "Processing…" : `Pay ${formatCents(amountCents, { cents: true })} deposit`}
        </button>
        {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
        <p className="mt-2 text-xs text-gray-500">Payments are processed securely by QuickBooks / Intuit.</p>
      </div>
    </form>
  );
}

/** The signed PDF is rendered right after signing; refresh until it's ready (about 10 seconds). */
function PreparingCopy() {
  const router = useRouter();
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (tries > 12) return;
    const t = setTimeout(() => {
      router.refresh();
      setTries((n) => n + 1);
    }, 5000);
    return () => clearTimeout(t);
  }, [tries, router]);
  return <span className="text-gray-600">Preparing your signed copy… We&apos;ll also email it to you.</span>;
}

const CHOICE_LABEL: Record<DepositChoice, { title: string; note: string }> = {
  card: { title: "Credit or debit card", note: "Pay now, online" },
  ach: { title: "Bank transfer (ACH)", note: "Pay from your bank account online" },
  check: { title: "Check or in person", note: "Pay your technician or mail a check" },
  financing: { title: "Monthly payments", note: "Apply with Acorn Finance" },
};

/** The customer picks how to pay; each choice shows only its own next step. */
function DepositChooser(props: Parameters<typeof SignedView>[0]) {
  const router = useRouter();
  const choices: DepositChoice[] = [
    ...(props.canPayByCard ? (["card", "ach"] as const) : []),
    "check",
    ...(props.acornLink ? (["financing"] as const) : []),
  ];
  const initial = (choices as string[]).includes(props.depositChoice ?? "") ? (props.depositChoice as DepositChoice) : null;
  const [choice, setChoice] = useState<DepositChoice | null>(initial);
  const [achLink, setAchLink] = useState(props.achLink);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const phone = props.view.company.phone;

  const pick = (c: DepositChoice) => {
    setChoice(c);
    setError(null);
    // Check and bank transfer are recorded when confirmed; card and financing right away.
    if (c === "card" || c === "financing") start(async () => void (await chooseDepositAction(props.token, c)));
  };
  const confirm = (c: "ach" | "check") =>
    start(async () => {
      const res = await chooseDepositAction(props.token, c);
      if (res.error) return setError(res.error);
      if (c === "ach") setAchLink(res.payLink ?? null);
      router.refresh();
    });

  return (
    <div className="mt-4">
      <fieldset>
        <legend className="text-sm font-semibold">How would you like to pay?</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {choices.map((c) => (
            <label
              key={c}
              className={`flex min-h-14 cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${choice === c ? "border-brand bg-brand/5 ring-2 ring-brand/15" : "border-gray-200"}`}
            >
              <input type="radio" name="deposit-choice" className="mt-1" checked={choice === c} onChange={() => pick(c)} />
              <span>
                <span className="block font-medium text-gray-900">{CHOICE_LABEL[c].title}</span>
                <span className="block text-gray-600">{CHOICE_LABEL[c].note}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-4">
        {choice === "card" && <CardForm token={props.token} amountCents={props.deposit.amountCents} tokenizeUrl={props.tokenizeUrl} name={props.customerName} />}
        {choice === "ach" &&
          (achLink || props.depositChoice === "ach" ? (
            <div className="space-y-2 text-sm">
              {achLink ? (
                <a href={achLink} target="_blank" rel="noreferrer" className="btn-primary">
                  Pay {formatCents(props.deposit.amountCents, { cents: true })} by bank transfer
                </a>
              ) : (
                <p>We emailed you an invoice with a bank-transfer payment link.</p>
              )}
              <p className="text-gray-600">Bank transfers take a few business days to clear. We&apos;ll text you when your deposit arrives.</p>
            </div>
          ) : (
            <button className="btn-primary" disabled={pending} onClick={() => confirm("ach")}>
              {pending ? "Setting it up…" : "Continue to bank transfer"}
            </button>
          ))}
        {choice === "check" &&
          (props.depositChoice === "check" ? (
            <p role="status" className="text-sm text-gray-800">
              Got it. Make your check payable to {props.view.company.name} and hand it to your technician
              {props.view.company.address ? `, or mail it to ${props.view.company.address}` : ""}. We&apos;ll confirm when it arrives
              {phone ? `. Questions? Call ${phone}` : ""}.
            </p>
          ) : (
            <button className="btn-primary" disabled={pending} onClick={() => confirm("check")}>
              {pending ? "Saving…" : "I'll pay by check or in person"}
            </button>
          ))}
        {choice === "financing" && props.acornLink && (
          <div className="space-y-1">
            <a href={props.acornLink} target="_blank" rel="noreferrer" className="btn-primary">
              Apply with Acorn Finance
            </a>
            <p className="text-xs text-gray-600">Checking your options won&apos;t affect your credit score.</p>
          </div>
        )}
      </div>
      {!props.canPayByCard && (
        <p className="mt-3 text-sm text-gray-600">Online card and bank payments are coming soon. Call {phone || "us"} if you need another way to pay.</p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
