"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { needsRescheduleAction, runningLateAction, visitStatusAction, wrapUpVisitAction, type Result } from "@/app/(crm)/ops-actions";
import type { StageMovePayload } from "@/lib/services/stage-moves";
import type { VisitStatus } from "@/generated/prisma/enums";
import { DeclineFields, ReasonSelect } from "./visit-fields";

const OUTCOME_LABEL: Record<string, string> = {
  work_now: "Work done the same visit",
  return_visit: "Signed · return visit to schedule",
  declined: "Estimate declined",
  estimate_later: "Estimate to follow",
};

/**
 * The tech's buttons for one visit (My day): On my way → Arrived/Start → wrap up, plus Running late and
 * Can't make it while it's upcoming. The first visit ends with an outcome; job visits with Complete.
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
  const [panel, setPanel] = useState<null | "late" | "reschedule" | "declined">(null);
  const [form, setForm] = useState<StageMovePayload>({ reason: "tech_delayed", textCustomer: true, fee: "none", feeDollars: props.feeDollars, feeMethod: "card" });
  const [msg, setMsg] = useState<Result | null>(null);
  const set = (patch: StageMovePayload) => setForm((f) => ({ ...f, ...patch }));

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

  if (props.status === "cancelled") return <p className="text-sm text-gray-500">Cancelled</p>;
  if (props.status === "done") {
    return <p className="text-sm font-medium text-green-700">Done ✓{props.outcome ? ` · ${OUTCOME_LABEL[props.outcome] ?? props.outcome}` : ""}</p>;
  }
  if (!props.hasTech) return <p className="text-sm text-amber-700">No tech assigned yet.</p>;

  const upcoming = props.status === "scheduled" || props.status === "en_route";
  const signed = props.proposal?.status === "signed";

  return (
    <div className="space-y-2">
      {props.lateEta && upcoming && <p className="text-sm font-medium text-amber-700">Running late · customer told about {props.lateEta}</p>}

      {upcoming && (
        <div className="grid grid-cols-2 gap-2">
          {props.status === "scheduled" ? (
            <button className="btn-primary py-3" disabled={pending} onClick={() => go("en_route")}>
              On my way
            </button>
          ) : (
            <button className="btn-primary py-3" disabled={pending} onClick={() => go("in_progress")}>
              {props.kind === "estimate" ? "Arrived" : "Start work"}
            </button>
          )}
          <button className="btn-secondary py-3" disabled={pending} onClick={() => setPanel(panel === "late" ? null : "late")}>
            Running late
          </button>
          <button
            className="btn-secondary col-span-2 py-2 text-red-700"
            disabled={pending}
            onClick={() => {
              set({ reason: "tech_delayed", textCustomer: true });
              setPanel(panel === "reschedule" ? null : "reschedule");
            }}
          >
            Can&apos;t make it / reschedule
          </button>
        </div>
      )}
      {props.status === "scheduled" && props.canText && (
        <label className="flex items-center gap-2 text-xs text-gray-600">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Text the customer when I tap &ldquo;On my way&rdquo;
        </label>
      )}

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
          <p className="mt-2 text-xs text-gray-600">Texts the customer the new approximate arrival time and moves your calendar.</p>
        </div>
      )}

      {panel === "reschedule" && (
        <div className="space-y-2 rounded-md border bg-red-50 p-3 text-sm">
          <ReasonSelect value={form.reason} onChange={(reason) => set({ reason, textCustomer: reason !== "customer_request" })} />
          <input className="input" aria-label="Note" placeholder="Note for the office (optional)" value={form.note ?? ""} onChange={(e) => set({ note: e.target.value })} />
          {props.canText && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={Boolean(form.textCustomer)} onChange={(e) => set({ textCustomer: e.target.checked })} /> Text the customer we need to reschedule
            </label>
          )}
          <button
            className="btn-primary w-full"
            disabled={pending}
            onClick={() => run(() => needsRescheduleAction(props.visitId, { reason: form.reason ?? "other", note: form.note, notifyCustomer: Boolean(form.textCustomer) && props.canText }))}
          >
            Cancel visit · needs reschedule
          </button>
          <p className="text-xs text-gray-600">The office gets an alert to rebook it.</p>
        </div>
      )}

      {props.status === "in_progress" && props.kind === "job" && (
        <button className="btn-primary w-full py-3" disabled={pending} onClick={() => go("done")}>
          Complete
        </button>
      )}

      {props.status === "in_progress" && props.kind === "estimate" && (
        <div className="space-y-2">
          {signed ? (
            <>
              <p className="text-sm font-medium text-green-700">Estimate signed ✓</p>
              <div className="grid grid-cols-2 gap-2">
                <button className="btn-primary py-3" disabled={pending} onClick={() => run(() => wrapUpVisitAction(props.visitId, { outcome: "work_now" }))}>
                  Start work now
                </button>
                <button className="btn-secondary py-3" disabled={pending} onClick={() => run(() => wrapUpVisitAction(props.visitId, { outcome: "return_visit" }))}>
                  Schedule return visit
                </button>
              </div>
            </>
          ) : (
            <>
              {!props.proposal && (
                <Link href={`/leads/${props.leadId}`} className="btn-secondary w-full py-3">
                  Write the estimate
                </Link>
              )}
              <div className="grid grid-cols-2 gap-2">
                <button
                  className="btn-secondary py-3 text-red-700"
                  disabled={pending}
                  onClick={() => {
                    set({ reason: "" });
                    setPanel(panel === "declined" ? null : "declined");
                  }}
                >
                  Declined – done
                </button>
                <button className="btn-secondary py-3" disabled={pending} onClick={() => run(() => wrapUpVisitAction(props.visitId, { outcome: "estimate_later" }))}>
                  Done – estimate later
                </button>
              </div>
            </>
          )}
          {panel === "declined" && (
            <div className="space-y-2 rounded-md border p-3 text-sm">
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
      )}

      {msg?.error && <p role="alert" className="text-sm text-red-700">{msg.error}</p>}
      {msg?.ok && !msg.error && <p role="status" className="text-sm text-green-700">{msg.ok}</p>}
    </div>
  );
}
