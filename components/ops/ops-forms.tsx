"use client";

import { useActionState, useState, useTransition } from "react";
import { ArrivalFields, ReasonSelect, TechField } from "./visit-fields";
import {
  cancelVisitAction,
  needsRescheduleAction,
  rescheduleVisitAction,
  recordDepositAction,
  recordFinalPaymentAction,
  scheduleVisitAction,
  sendTextAction,
  stopEnrollmentAction,
  type Result,
} from "@/app/(crm)/ops-actions";

function Status({ state }: { state: Result | undefined }) {
  if (state?.error) return <p className="text-sm text-red-700">{state.error}</p>;
  if (state?.ok) return <p className="text-sm text-green-700">{state.ok}</p>;
  return null;
}

function todayEastern() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

export function ScheduleVisitForm(props: {
  leadId: string;
  jobId?: string;
  kind: "estimate" | "job";
  techs: { id: string; name: string }[];
  defaultTechId?: string | null;
  defaultHours: number;
}) {
  const [state, action, pending] = useActionState(scheduleVisitAction, undefined);
  const [tech, setTech] = useState(props.defaultTechId ?? props.techs[0]?.id ?? "");
  return (
    <form action={action} className="grid gap-2 text-sm sm:grid-cols-2">
      <input type="hidden" name="leadId" value={props.leadId} />
      <input type="hidden" name="kind" value={props.kind} />
      {props.jobId && <input type="hidden" name="jobId" value={props.jobId} />}
      <ArrivalFields idPrefix={`sched-${props.kind}`} defaultDate={todayEastern()} defaultHours={props.defaultHours} />
      <TechField id={`tech-${props.kind}`} techs={props.techs} defaultTechId={props.defaultTechId} allowNone onChange={setTech} />
      <div className="sm:col-span-2">
        <label className="label" htmlFor={`notes-${props.kind}`}>
          Notes for the tech
        </label>
        <input id={`notes-${props.kind}`} name="notes" className="input" />
      </div>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <button className="btn-primary" disabled={pending}>
          {pending ? "Booking…" : !tech ? "Book without a tech" : props.kind === "estimate" ? "Book service call & text customer" : "Schedule job visit & text customer"}
        </button>
        <Status state={state} />
      </div>
    </form>
  );
}

export type VisitRow = {
  id: string;
  kind: string;
  when: string;
  techName: string;
  techId: string | null;
  status: string;
  syncState: string;
  syncError: string | null;
  arrival: string | null;
  lateEta: string | null;
  outcome: string | null;
  fee: string | null;
  date: string;
  hours: number;
};

/** Visits on the lead / job page; the owner can assign, reschedule, flag for reschedule or cancel upcoming ones. */
export function VisitList({ visits, canEdit, techs = [], canText = false }: { visits: VisitRow[]; canEdit: boolean; techs?: { id: string; name: string }[]; canText?: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ id: string; what: "reschedule" | "flag" } | null>(null);
  if (!visits.length) return <p className="text-sm text-gray-500">No visits yet.</p>;
  return (
    <ul className="divide-y text-sm" aria-label="Visits">
      {visits.map((v) => {
        const upcoming = ["scheduled", "en_route"].includes(v.status);
        return (
          <li key={v.id} className="py-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium">{v.arrival ?? v.when}</span>
              <span className="text-gray-600">{v.kind === "estimate" ? "Service call" : "Job"}</span>
              <span className={v.techId ? "" : "font-medium text-red-700"}>{v.techName}</span>
              <span className="rounded bg-gray-100 px-1.5 text-xs capitalize">{v.status.replace("_", " ")}</span>
              {v.lateEta && upcoming && <span className="rounded bg-amber-100 px-1.5 text-xs text-amber-800">Late · ~{v.lateEta}</span>}
              {v.outcome && <span className="rounded bg-gray-100 px-1.5 text-xs">{v.outcome}</span>}
              {v.fee && <span className="rounded bg-gray-100 px-1.5 text-xs">{v.fee}</span>}
              {v.techId && (
                <span className={`text-xs ${v.syncState === "error" ? "text-red-700" : "text-gray-400"}`} title={v.syncError ?? ""}>
                  {v.syncState === "synced" ? "In Google Calendar" : v.syncState === "skipped" ? "Calendar not connected" : v.syncState === "error" ? "Calendar sync failed" : "Syncing…"}
                </span>
              )}
              {canEdit && upcoming && (
                <span className="ml-auto flex flex-wrap gap-3">
                  <button className="text-brand underline" onClick={() => setOpen(open?.id === v.id && open.what === "reschedule" ? null : { id: v.id, what: "reschedule" })}>
                    {v.techId ? "Reschedule" : "Assign tech"}
                  </button>
                  <button className="text-amber-800 underline" onClick={() => setOpen(open?.id === v.id && open.what === "flag" ? null : { id: v.id, what: "flag" })}>
                    Needs reschedule
                  </button>
                  <button
                    className="text-red-700 underline"
                    disabled={pending}
                    onClick={() => {
                      const reason = window.prompt("Cancel this visit for good? Optional reason:");
                      if (reason === null) return;
                      start(async () => {
                        const r = await cancelVisitAction(v.id, reason || undefined);
                        if (r.error) setError(r.error);
                      });
                    }}
                  >
                    Cancel
                  </button>
                </span>
              )}
            </div>
            {open?.id === v.id && open.what === "reschedule" && <RescheduleForm visit={v} techs={techs} canText={canText} onDone={() => setOpen(null)} />}
            {open?.id === v.id && open.what === "flag" && <FlagRescheduleForm visitId={v.id} canText={canText} onDone={() => setOpen(null)} />}
          </li>
        );
      })}
      {error && <li className="py-2 text-red-700">{error}</li>}
    </ul>
  );
}

function RescheduleForm({ visit, techs, canText, onDone }: { visit: VisitRow; techs: { id: string; name: string }[]; canText: boolean; onDone: () => void }) {
  const [state, action, pending] = useActionState(rescheduleVisitAction.bind(null, visit.id), undefined);
  return (
    <form action={action} className="mt-2 grid gap-2 rounded-md border bg-gray-50 p-3 sm:grid-cols-2">
      <ArrivalFields idPrefix={`re-${visit.id}`} defaultDate={visit.date} defaultHours={visit.hours} />
      <TechField id={`re-tech-${visit.id}`} techs={techs} defaultTechId={visit.techId} />
      {canText && (
        <label className="flex items-center gap-2 sm:col-span-2">
          <input type="checkbox" name="notify" defaultChecked /> {visit.techId ? "Text the customer the change" : "Text the customer their confirmation"}
        </label>
      )}
      <div className="flex items-center gap-3 sm:col-span-2">
        <button className="btn-primary" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn-secondary" onClick={onDone}>
          Close
        </button>
        <Status state={state} />
      </div>
    </form>
  );
}

function FlagRescheduleForm({ visitId, canText, onDone }: { visitId: string; canText: boolean; onDone: () => void }) {
  const [reason, setReason] = useState("customer_request");
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(false);
  const [pending, start] = useTransition();
  const [state, setState] = useState<Result | undefined>();
  return (
    <div className="mt-2 space-y-2 rounded-md border bg-amber-50 p-3">
      <ReasonSelect
        value={reason}
        onChange={(r) => {
          setReason(r);
          setNotify(canText && r !== "customer_request");
        }}
      />
      <input className="input" aria-label="Note" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      {canText && (
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Text the customer we need to reschedule
        </label>
      )}
      <div className="flex items-center gap-3">
        <button
          className="btn-primary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await needsRescheduleAction(visitId, { reason, note, notifyCustomer: notify });
              setState(r);
              if (!r.error) onDone();
            })
          }
        >
          Cancel visit · needs reschedule
        </button>
        <Status state={state} />
      </div>
    </div>
  );
}

const METHODS = [
  ["check", "Check"],
  ["cash", "Cash"],
  ["financing", "Financing (Acorn)"],
  ["card", "Card (taken another way)"],
  ["other", "Other"],
] as const;

export function RecordDepositForm({ proposalId, defaultDollars }: { proposalId: string; defaultDollars: string }) {
  const [state, action, pending] = useActionState(recordDepositAction.bind(null, proposalId), undefined);
  return (
    <form action={action} className="space-y-2 text-sm">
      <div className="flex gap-2">
        <select name="method" className="input" aria-label="Payment method" defaultValue="check">
          {METHODS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <input name="amount" className="input w-28" defaultValue={defaultDollars} inputMode="decimal" aria-label="Amount" />
      </div>
      <input name="note" className="input" placeholder="Note (check #, Acorn app id…)" aria-label="Note" />
      <button className="btn-secondary w-full" disabled={pending}>
        {pending ? "Saving…" : "Record deposit received"}
      </button>
      <Status state={state} />
    </form>
  );
}

export function RecordFinalPaymentForm({ jobId, defaultDollars }: { jobId: string; defaultDollars: string }) {
  const [state, action, pending] = useActionState(recordFinalPaymentAction.bind(null, jobId), undefined);
  return (
    <form action={action} className="space-y-2 text-sm">
      <div className="flex gap-2">
        <select name="method" className="input" aria-label="Payment method" defaultValue="check">
          {METHODS.filter(([v]) => v !== "financing").map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <input name="amount" className="input w-28" defaultValue={defaultDollars} inputMode="decimal" aria-label="Amount" />
      </div>
      <input name="note" className="input" placeholder="Note" aria-label="Note" />
      <button className="btn-secondary w-full" disabled={pending}>
        {pending ? "Saving…" : "Record payment received"}
      </button>
      <Status state={state} />
    </form>
  );
}

export type MessageRow = { id: string; direction: string; body: string; when: string; status: string; by: string | null };

export function TextThread({ leadId, messages, canText, reason }: { leadId: string; messages: MessageRow[]; canText: boolean; reason?: string }) {
  const [state, action, pending] = useActionState(sendTextAction.bind(null, leadId), undefined);
  return (
    <div>
      <ol className="max-h-96 space-y-2 overflow-y-auto" aria-label="Text messages">
        {messages.length === 0 && <li className="text-sm text-gray-500">No texts yet.</li>}
        {messages.map((m) => (
          <li key={m.id} className={`flex ${m.direction === "out" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${m.direction === "out" ? "bg-brand text-white" : "bg-gray-100 text-gray-900"}`}>
              <p className="whitespace-pre-wrap">{m.body}</p>
              <p className={`mt-0.5 text-[10px] ${m.direction === "out" ? "text-white/70" : "text-gray-500"}`}>
                {m.when}
                {m.by ? ` · ${m.by}` : ""}
                {m.direction === "out" && m.status !== "sent" ? ` · ${m.status}` : ""}
              </p>
            </div>
          </li>
        ))}
      </ol>
      {canText ? (
        <form action={action} className="mt-3 flex gap-2">
          <input name="body" className="input" placeholder="Text the customer…" aria-label="Text message" maxLength={1600} required />
          <button className="btn-primary" disabled={pending}>
            Send
          </button>
        </form>
      ) : (
        <p className="mt-3 text-sm text-gray-500">Can&apos;t text: {reason}</p>
      )}
      <Status state={state} />
    </div>
  );
}

export function EnrollmentList({ leadId, rows }: { leadId: string; rows: { id: string; name: string; status: string; detail: string }[] }) {
  const [pending, start] = useTransition();
  if (!rows.length) return <p className="text-sm text-gray-500">No automatic texts for this lead.</p>;
  return (
    <ul className="divide-y text-sm" aria-label="Automatic texts">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center gap-3 py-1.5">
          <span className="font-medium">{r.name}</span>
          <span className="text-gray-500">{r.detail}</span>
          {r.status === "active" && (
            <button className="ml-auto text-red-700 underline" disabled={pending} onClick={() => start(() => stopEnrollmentAction(r.id, leadId))}>
              Stop
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
