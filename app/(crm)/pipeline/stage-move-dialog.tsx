"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { WINDOWS } from "@/lib/booking";
import { stageInfo } from "@/lib/stages";
import type { LeadStage } from "@/generated/prisma/enums";
import type { StagePlan, StageMovePayload } from "@/lib/services/stage-moves";
import { performStageMoveAction } from "../actions";
import { DeclineFields, ReasonSelect } from "@/components/ops/visit-fields";

const METHODS = [
  ["check", "Check"],
  ["cash", "Cash"],
  ["financing", "Financing (Acorn)"],
  ["card", "Card (taken another way)"],
  ["other", "Other"],
] as const;

function todayEastern() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

/** Shown after a card is dropped on a stage that needs real work. */
export function StageMoveDialog(props: {
  leadId: string;
  customer: string;
  stage: LeadStage;
  plan: StagePlan;
  onClose: () => void;
  onDone: () => void;
}) {
  const { plan } = props;
  const [p, setP] = useState<StageMovePayload>(() => {
    if (plan.kind === "scheduleEstimate")
      return { techId: plan.noTech ? "" : (plan.defaultTechId ?? plan.techs[0]?.id), date: plan.booking?.date ?? plan.dates[0]?.ymd, window: plan.booking?.window ?? "09-12", hours: 1 };
    if (plan.kind === "assignTech") return { techId: plan.defaultTechId ?? plan.techs[0]?.id };
    if (plan.kind === "visitStatus") return { textCustomer: plan.canText };
    if (plan.kind === "reschedule") return { reason: "tech_delayed", textCustomer: true };
    if (plan.kind === "decline") return { fee: "none", feeDollars: plan.feeDollars, feeMethod: "card" };
    if (plan.kind === "scheduleJob") return { techId: plan.defaultTechId ?? plan.techs[0]?.id, date: todayEastern(), time: "09:00", hours: plan.defaultHours };
    if (plan.kind === "sendProposal") return { textCustomer: plan.canText };
    if (plan.kind === "recordApproval") return { optionId: plan.options[1]?.id ?? plan.options[0]?.id, signerName: plan.customerName };
    if (plan.kind === "recordDeposit" || plan.kind === "recordPayment") return { method: "check", amountDollars: plan.defaultDollars };
    return {};
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (patch: StageMovePayload) => setP((x) => ({ ...x, ...patch }));
  const label = stageInfo(props.stage).label;

  function submit() {
    setError(null);
    start(async () => {
      const r = await performStageMoveAction(props.leadId, props.stage, p);
      if (r.error) setError(r.error);
      else props.onDone();
    });
  }

  const actionLabel: Record<string, string> = {
    lost: "Mark lost",
    scheduleEstimate: p.techId ? "Book & text customer" : "Book without a tech",
    assignTech: "Assign & text customer",
    visitStatus: plan.kind === "visitStatus" && plan.status === "en_route" ? "On my way" : "Arrived",
    reschedule: "Cancel visit · needs reschedule",
    decline: "Mark declined",
    sendProposal: "Send proposal",
    recordApproval: "Record approval",
    recordDeposit: "Record deposit",
    scheduleJob: "Schedule job visit",
    startVisit: "Start the visit",
    completeJob: "Complete job & send invoice",
    sendInvoice: "Create & send invoice",
    recordPayment: "Record payment",
    requestReview: "Send review request",
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" role="dialog" aria-modal="true" aria-label={`Move to ${label}`}>
      <div className="card w-full max-w-md space-y-3 p-5 text-sm">
        <h2 className="text-base font-semibold">
          {props.customer} → {label}
        </h2>

        {plan.kind === "blocked" && (
          <>
            <p className="text-gray-700">{plan.message}</p>
            {plan.href && (
              <Link href={plan.href} className="btn-primary">
                {plan.linkLabel ?? "Open"}
              </Link>
            )}
          </>
        )}

        {plan.kind === "lost" && (
          <input className="input" placeholder="Why was it lost?" aria-label="Lost reason" value={p.lostReason ?? ""} onChange={(e) => set({ lostReason: e.target.value })} />
        )}

        {plan.kind === "scheduleEstimate" && (
          <>
            {plan.booking && <p className="rounded bg-amber-50 p-2 text-amber-800">The customer asked for this window; change it if needed.</p>}
            <select className="input" aria-label="Day" value={p.date} onChange={(e) => set({ date: e.target.value })}>
              {(plan.booking && !plan.dates.some((d) => d.ymd === plan.booking!.date) ? [{ ymd: plan.booking.date, label: plan.booking.date }, ...plan.dates] : plan.dates).map((d) => (
                <option key={d.ymd} value={d.ymd}>
                  {d.label}
                </option>
              ))}
            </select>
            <select className="input" aria-label="Arrival window" value={p.window} onChange={(e) => set({ window: e.target.value })}>
              {WINDOWS.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
            </select>
            <TechSelect techs={plan.techs} value={p.techId} onChange={(techId) => set({ techId })} allowNone />
            <select className="input" aria-label="Time on site" value={String(p.hours ?? 1)} onChange={(e) => set({ hours: Number(e.target.value) })}>
              {[0.5, 1, 1.5, 2, 3].map((h) => (
                <option key={h} value={h}>
                  {h} {h === 1 ? "hour" : "hours"} on site
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500">{p.techId ? "The customer gets the confirmation with the arrival window and technician." : "No text yet. The card waits in Needs tech until you assign someone."}</p>
          </>
        )}

        {plan.kind === "assignTech" && (
          <>
            <p className="text-gray-600">Visit on {plan.label}. Assigning a tech texts the customer their arrival window and technician.</p>
            <TechSelect techs={plan.techs} value={p.techId} onChange={(techId) => set({ techId })} />
          </>
        )}

        {plan.kind === "visitStatus" && (
          <>
            <p className="text-gray-600">Visit on {plan.label}.</p>
            {plan.status === "en_route" && plan.canText && (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={Boolean(p.textCustomer)} onChange={(e) => set({ textCustomer: e.target.checked })} /> Text the customer that the tech is on the way
              </label>
            )}
          </>
        )}

        {plan.kind === "reschedule" && (
          <>
            <p className="text-gray-600">Cancels the visit on {plan.label} and moves the card to Needs reschedule. You&apos;ll get an alert to rebook it.</p>
            <ReasonSelect value={p.reason} onChange={(reason) => set({ reason, textCustomer: reason !== "customer_request" })} />
            <input className="input" aria-label="Note" placeholder="Note (optional)" value={p.note ?? ""} onChange={(e) => set({ note: e.target.value })} />
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={Boolean(p.textCustomer)} onChange={(e) => set({ textCustomer: e.target.checked })} /> Text the customer we need to reschedule
            </label>
          </>
        )}

        {plan.kind === "decline" && (
          <DeclineFields p={p} set={set} />
        )}

        {plan.kind === "sendProposal" &&
          (plan.problems.length ? (
            <>
              <ul className="list-disc space-y-1 pl-5 text-amber-800">
                {plan.problems.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
              <Link href={`/proposals/${plan.proposalId}`} className="btn-secondary">
                Open the draft
              </Link>
            </>
          ) : (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={Boolean(p.textCustomer)} disabled={!plan.canText} onChange={(e) => set({ textCustomer: e.target.checked })} />
              {plan.canText ? `Text the link to ${plan.phone}` : "No phone to text"}
            </label>
          ))}

        {plan.kind === "recordApproval" && (
          <>
            <p className="text-gray-600">For a proposal the customer approved on paper or in person. (Online signatures move the card here automatically.)</p>
            <select className="input" aria-label="Option approved" value={p.optionId} onChange={(e) => set({ optionId: e.target.value })}>
              {plan.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.title} · {o.total}
                </option>
              ))}
            </select>
            <input className="input" aria-label="Signed by" value={p.signerName ?? ""} onChange={(e) => set({ signerName: e.target.value })} />
            <input className="input" aria-label="Note" placeholder="Note (e.g. signed paper copy on site)" value={p.note ?? ""} onChange={(e) => set({ note: e.target.value })} />
          </>
        )}

        {(plan.kind === "recordDeposit" || plan.kind === "recordPayment") && (
          <>
            {plan.kind === "recordDeposit" && <p className="text-gray-600">Recording the deposit creates the job. Then drag it here again to schedule the visit.</p>}
            <div className="flex gap-2">
              <select className="input" aria-label="Payment method" value={p.method} onChange={(e) => set({ method: e.target.value })}>
                {METHODS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              <input className="input w-32" aria-label="Amount" inputMode="decimal" value={p.amountDollars ?? ""} onChange={(e) => set({ amountDollars: e.target.value })} />
            </div>
            <input className="input" aria-label="Note" placeholder="Note (check #…)" value={p.note ?? ""} onChange={(e) => set({ note: e.target.value })} />
          </>
        )}

        {plan.kind === "scheduleJob" && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <input className="input col-span-3" type="date" aria-label="Date" value={p.date} onChange={(e) => set({ date: e.target.value })} />
              <input className="input col-span-2" type="time" step={900} aria-label="Start" value={p.time} onChange={(e) => set({ time: e.target.value })} />
              <input className="input" type="number" min={0.5} step={0.5} aria-label="Hours" value={p.hours} onChange={(e) => set({ hours: Number(e.target.value) })} />
            </div>
            <TechSelect techs={plan.techs} value={p.techId} onChange={(techId) => set({ techId })} />
          </>
        )}

        {plan.kind === "startVisit" && <p>Marks the visit on {plan.label} as started.</p>}
        {plan.kind === "completeJob" && (
          <p>
            Closes {plan.openVisits ? `${plan.openVisits} open visit${plan.openVisits === 1 ? "" : "s"}` : "the job"}, completes it and sends the final invoice for {plan.balance}.
          </p>
        )}
        {plan.kind === "sendInvoice" && <p>Creates the QuickBooks invoice for {plan.balance}, emails it and texts the payment link.</p>}
        {plan.kind === "requestReview" && (
          <p>{plan.hasReviewLink ? "Texts the customer your Google review link." : "No review link is set in Settings, so this only moves the card."}</p>
        )}

        {error && <p className="rounded bg-red-50 p-2 text-red-700">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-secondary" onClick={props.onClose} disabled={pending}>
            Cancel
          </button>
          {plan.kind !== "blocked" && !(plan.kind === "sendProposal" && plan.problems.length) && (
            <button className="btn-primary" onClick={submit} disabled={pending}>
              {pending ? "Working…" : (actionLabel[plan.kind] ?? "Move")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function TechSelect({ techs, value, onChange, allowNone }: { techs: { id: string; name: string }[]; value?: string; onChange: (v: string) => void; allowNone?: boolean }) {
  return (
    <select className="input" aria-label="Tech" value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
      {techs.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
      {allowNone && <option value="">Assign a tech later</option>}
    </select>
  );
}
