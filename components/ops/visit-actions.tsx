"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { customerNotHomeAction, needsRescheduleAction, runningLateAction, visitStatusAction, wrapUpVisitAction, type Result } from "@/app/(crm)/ops-actions";
import type { StageMovePayload } from "@/lib/services/stage-moves";
import type { VisitStatus } from "@/generated/prisma/enums";
import { OUTCOME_LABEL, visitPhase } from "@/lib/visit-steps";
import { DeclineFields, FeeFields, ReasonSelect } from "./visit-fields";

type Panel = null | "late" | "reschedule" | "declined" | "tripFee" | "notHome";

/**
 * The tech's buttons for one visit. Only the current step's buttons exist (lib/visit-steps.ts):
 * On my way → Arrived → Build estimate → Present → signed: Start work now / Schedule return.
 * Off-path exits sit under the main button and only where they make sense (Running late before arriving,
 * Customer not home once on the way, Declined once there's an estimate, Trip fee only before one).
 */
export function VisitActions(props: {
  visitId: string;
  kind: "estimate" | "job";
  status: string;
  outcome: string | null;
  hasTech: boolean;
  canText: boolean;
  lateEta: string | null;
  proposal: { id: string; status: string } | null;
  leadId: string;
  feeDollars: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notify, setNotify] = useState(props.canText);
  const [panel, setPanel] = useState<Panel>(null);
  const [form, setForm] = useState<StageMovePayload>({
    reason: "tech_delayed",
    textCustomer: true,
    fee: "none",
    feeDollars: props.feeDollars,
    feeMethod: "card",
  });
  const [msg, setMsg] = useState<Result | null>(null);
  const set = (patch: StageMovePayload) => setForm((f) => ({ ...f, ...patch }));
  const phase = visitPhase({
    kind: props.kind,
    status: props.status,
    outcome: props.outcome,
    hasTech: props.hasTech,
    proposalStatus: props.proposal?.status ?? null,
  });

  // The estimate is presented in another tab; when the tech comes back, show where the customer got to.
  useEffect(() => {
    if (phase !== "on_site_estimate") return;
    const onVisible = () => document.visibilityState === "visible" && router.refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [phase, router]);

  const run = (fn: () => Promise<Result & { jobId?: string }>) =>
    start(async () => {
      setMsg(null);
      const r = await fn();
      setMsg(r);
      if (!r.error) {
        setPanel(null);
        router.refresh();
      }
    });
  const go = (s: VisitStatus) => run(() => visitStatusAction(props.visitId, s, notify));
  const open = (p: Exclude<Panel, null>, patch: StageMovePayload = {}) => {
    if (panel === p) return setPanel(null);
    set(patch);
    setPanel(p);
  };
  const toggle = (p: Exclude<Panel, null>) => ({
    "aria-expanded": panel === p,
    "aria-controls": `${props.visitId}-panel`,
  });

  if (phase === "cancelled") return <p className="text-sm text-gray-600">Cancelled. The office will rebook it.</p>;
  if (phase === "done") {
    return (
      <p className="text-sm font-medium text-green-800">
        Done
        {props.outcome ? ` · ${OUTCOME_LABEL[props.outcome] ?? props.outcome}` : ""}
      </p>
    );
  }
  if (phase === "no_tech") return <p className="text-sm text-amber-800">No tech assigned yet.</p>;

  const primary = "btn-primary w-full py-3.5 text-base";
  const secondary = "btn-secondary flex-1 basis-36 py-2.5";
  const proposalId = props.proposal?.id;

  return (
    <div className="space-y-3">
      {props.lateEta && (phase === "scheduled" || phase === "en_route") && (
        <p className="text-sm font-medium text-amber-800">Running late · customer told about {props.lateEta}</p>
      )}

      {/* The one thing to do next. */}
      {phase === "scheduled" && (
        <button className={primary} disabled={pending} onClick={() => go("en_route")}>
          On my way
        </button>
      )}
      {phase === "en_route" && (
        <button className={primary} disabled={pending} onClick={() => go("in_progress")}>
          {props.kind === "estimate" ? "Arrived" : "Start work"}
        </button>
      )}
      {phase === "on_site_no_estimate" && (
        <Link href={`/leads/${props.leadId}/proposal/new`} className={primary}>
          Build estimate
        </Link>
      )}
      {phase === "on_site_estimate" && proposalId && (
        <a href={`/proposals/${proposalId}/present`} target="_blank" rel="noreferrer" className={primary}>
          Present to customer
        </a>
      )}
      {phase === "on_site_signed" && (
        <>
          <p className="text-sm font-medium text-green-800">Estimate signed</p>
          <button className={primary} disabled={pending} onClick={() => run(() => wrapUpVisitAction(props.visitId, { outcome: "work_now" }))}>
            Start work now
          </button>
        </>
      )}
      {phase === "working" && (
        <button className={primary} disabled={pending} onClick={() => go("done")}>
          Complete
        </button>
      )}

      {phase === "scheduled" && props.canText && (
        <label className="flex min-h-9 items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Text the customer when I tap &ldquo;On my way&rdquo;
        </label>
      )}

      {/* Exits that fit this step only. */}
      <div className="flex flex-wrap gap-2">
        {(phase === "scheduled" || phase === "en_route") && (
          <button className={secondary} disabled={pending} onClick={() => open("late")} {...toggle("late")}>
            Running late
          </button>
        )}
        {(phase === "en_route" || phase === "on_site_no_estimate") && (
          <button
            className={secondary}
            disabled={pending}
            onClick={() => open("notHome", { fee: undefined, textCustomer: props.canText })}
            {...toggle("notHome")}
          >
            Customer not home
          </button>
        )}
        {phase === "on_site_no_estimate" && (
          <button className={secondary} disabled={pending} onClick={() => open("tripFee", { fee: "collect" })} {...toggle("tripFee")}>
            Trip fee only – done
          </button>
        )}
        {phase === "on_site_estimate" && proposalId && (
          <Link href={`/proposals/${proposalId}`} className={secondary}>
            Edit estimate
          </Link>
        )}
        {phase === "on_site_estimate" && (
          <button
            className={`${secondary} text-red-700`}
            disabled={pending}
            onClick={() => open("declined", { reason: "", fee: "none" })}
            {...toggle("declined")}
          >
            Declined – done
          </button>
        )}
        {(phase === "on_site_no_estimate" || phase === "on_site_estimate") && (
          <button className={secondary} disabled={pending} onClick={() => run(() => wrapUpVisitAction(props.visitId, { outcome: "estimate_later" }))}>
            Done – estimate later
          </button>
        )}
        {phase === "on_site_signed" && (
          <>
            <button className={secondary} disabled={pending} onClick={() => run(() => wrapUpVisitAction(props.visitId, { outcome: "return_visit" }))}>
              Schedule return visit
            </button>
            {proposalId && (
              <a href={`/proposals/${proposalId}/present`} target="_blank" rel="noreferrer" className={secondary}>
                Show signed estimate
              </a>
            )}
          </>
        )}
        {(phase === "scheduled" || phase === "en_route") && (
          <button
            className={`${secondary} text-red-700`}
            disabled={pending}
            onClick={() => open("reschedule", { reason: "tech_delayed", textCustomer: true })}
            {...toggle("reschedule")}
          >
            Can&apos;t make it
          </button>
        )}
      </div>

      <div id={`${props.visitId}-panel`}>
        {panel === "late" && (
          <div className="rounded-md border bg-amber-50 p-3 text-sm">
            <p className="mb-2 font-medium">I&apos;ll get there in about…</p>
            <div className="grid grid-cols-3 gap-2">
              {[
                [30, "30 min"],
                [60, "1 hour"],
                [120, "2 hours"],
              ].map(([m, l]) => (
                <button key={m} className="btn-secondary py-3" disabled={pending} onClick={() => run(() => runningLateAction(props.visitId, Number(m)))}>
                  {l}
                </button>
              ))}
            </div>
            <p className="mt-2 text-gray-700">Texts the customer the new approximate arrival time and moves your calendar.</p>
          </div>
        )}

        {panel === "reschedule" && (
          <div className="space-y-2 rounded-md border bg-red-50 p-3 text-sm">
            <ReasonSelect value={form.reason} onChange={(reason) => set({ reason, textCustomer: reason !== "customer_request" })} />
            <input
              className="input"
              aria-label="Note"
              placeholder="Note for the office (optional)"
              value={form.note ?? ""}
              onChange={(e) => set({ note: e.target.value })}
            />
            {props.canText && (
              <label className="flex min-h-9 items-center gap-2">
                <input type="checkbox" checked={Boolean(form.textCustomer)} onChange={(e) => set({ textCustomer: e.target.checked })} /> Text the customer we
                need to reschedule
              </label>
            )}
            <button
              className="btn-primary w-full"
              disabled={pending}
              onClick={() =>
                run(() =>
                  needsRescheduleAction(props.visitId, {
                    reason: form.reason ?? "other",
                    note: form.note,
                    notifyCustomer: Boolean(form.textCustomer) && props.canText,
                  }),
                )
              }
            >
              Cancel visit · needs reschedule
            </button>
            <p className="text-gray-700">The office gets an alert to rebook it.</p>
          </div>
        )}

        {panel === "notHome" && (
          <div className="space-y-3 rounded-md border p-3 text-sm">
            <FeeFields p={form} set={set} legend="Trip fee" />
            {props.canText && (
              <label className="flex min-h-9 items-center gap-2">
                <input type="checkbox" checked={Boolean(form.textCustomer)} onChange={(e) => set({ textCustomer: e.target.checked })} /> Text the customer we
                stopped by
              </label>
            )}
            <button
              className="btn-primary w-full"
              disabled={pending || !form.fee}
              onClick={() =>
                run(() =>
                  customerNotHomeAction(props.visitId, {
                    fee: form.fee ?? "none",
                    feeDollars: form.feeDollars,
                    method: form.feeMethod,
                    notifyCustomer: Boolean(form.textCustomer) && props.canText,
                  }),
                )
              }
            >
              Save & leave
            </button>
            <p className="text-gray-700">Pick a trip fee option first. The office gets an alert to rebook.</p>
          </div>
        )}

        {panel === "tripFee" && (
          <div className="space-y-3 rounded-md border p-3 text-sm">
            <FeeFields p={form} set={set} legend="Trip fee" />
            <button
              className="btn-primary w-full"
              disabled={pending}
              onClick={() =>
                run(() =>
                  wrapUpVisitAction(props.visitId, {
                    outcome: "declined",
                    reason: "Service call only, no estimate",
                    fee: form.fee ?? "none",
                    feeDollars: form.feeDollars,
                    method: form.feeMethod,
                  }),
                )
              }
            >
              Save & leave
            </button>
          </div>
        )}

        {panel === "declined" && (
          <div className="space-y-3 rounded-md border p-3 text-sm">
            <DeclineFields p={form} set={set} />
            <button
              className="btn-primary w-full"
              disabled={pending || !form.reason}
              onClick={() =>
                run(() =>
                  wrapUpVisitAction(props.visitId, {
                    outcome: "declined",
                    reason: form.reason ?? "",
                    fee: form.fee ?? "none",
                    feeDollars: form.feeDollars,
                    method: form.feeMethod,
                  }),
                )
              }
            >
              Save & leave
            </button>
          </div>
        )}
      </div>

      {msg?.error && (
        <p role="alert" className="text-sm text-red-700">
          {msg.error}
        </p>
      )}
      {msg?.ok && !msg.error && (
        <p role="status" className="text-sm text-green-800">
          {msg.ok}
        </p>
      )}
    </div>
  );
}
