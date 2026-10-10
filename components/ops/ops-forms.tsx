"use client";

import { useActionState, useState, useTransition } from "react";
import {
  cancelVisitAction,
  recordDepositAction,
  recordFinalPaymentAction,
  scheduleVisitAction,
  sendTextAction,
  stopEnrollmentAction,
  visitStatusAction,
  type Result,
} from "@/app/(crm)/ops-actions";
import type { VisitStatus } from "@/generated/prisma/enums";

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
  return (
    <form action={action} className="grid gap-2 text-sm sm:grid-cols-6">
      <input type="hidden" name="leadId" value={props.leadId} />
      <input type="hidden" name="kind" value={props.kind} />
      {props.jobId && <input type="hidden" name="jobId" value={props.jobId} />}
      <div className="sm:col-span-2">
        <label className="label" htmlFor={`date-${props.kind}`}>
          Date
        </label>
        <input id={`date-${props.kind}`} name="date" type="date" className="input" defaultValue={todayEastern()} required />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor={`time-${props.kind}`}>
          Start
        </label>
        <input id={`time-${props.kind}`} name="time" type="time" className="input" defaultValue="09:00" step={900} required />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor={`hours-${props.kind}`}>
          Hours
        </label>
        <input id={`hours-${props.kind}`} name="hours" type="number" min={0.5} max={12} step={0.5} className="input" defaultValue={props.defaultHours} />
      </div>
      <div className="sm:col-span-3">
        <label className="label" htmlFor={`tech-${props.kind}`}>
          Tech
        </label>
        <select id={`tech-${props.kind}`} name="techId" className="input" defaultValue={props.defaultTechId ?? props.techs[0]?.id} required>
          {props.techs.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <div className="sm:col-span-3">
        <label className="label" htmlFor={`notes-${props.kind}`}>
          Notes for the tech
        </label>
        <input id={`notes-${props.kind}`} name="notes" className="input" />
      </div>
      <div className="flex items-center gap-3 sm:col-span-6">
        <button className="btn-primary" disabled={pending}>
          {pending ? "Scheduling…" : props.kind === "estimate" ? "Book estimate visit" : "Schedule job visit"}
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
  status: string;
  syncState: string;
  syncError: string | null;
};

export function VisitList({ visits, canEdit }: { visits: VisitRow[]; canEdit: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!visits.length) return <p className="text-sm text-gray-500">No visits yet.</p>;
  return (
    <ul className="divide-y text-sm" aria-label="Visits">
      {visits.map((v) => (
        <li key={v.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
          <span className="font-medium">{v.when}</span>
          <span className="capitalize text-gray-600">{v.kind}</span>
          <span>{v.techName}</span>
          <span className="rounded bg-gray-100 px-1.5 text-xs capitalize">{v.status.replace("_", " ")}</span>
          <span className={`text-xs ${v.syncState === "error" ? "text-red-700" : "text-gray-400"}`} title={v.syncError ?? ""}>
            {v.syncState === "synced" ? "In Google Calendar" : v.syncState === "skipped" ? "Calendar not connected" : v.syncState === "error" ? "Calendar sync failed" : "Syncing…"}
          </span>
          {canEdit && !["done", "cancelled"].includes(v.status) && (
            <button
              className="ml-auto text-red-700 underline"
              disabled={pending}
              onClick={() => {
                const reason = window.prompt("Cancel this visit? Optional reason:");
                if (reason === null) return;
                start(async () => {
                  const r = await cancelVisitAction(v.id, reason || undefined);
                  if (r.error) setError(r.error);
                });
              }}
            >
              Cancel
            </button>
          )}
        </li>
      ))}
      {error && <li className="py-2 text-red-700">{error}</li>}
    </ul>
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

export function VisitStatusButtons({ visitId, status, canText }: { visitId: string; status: string; canText: boolean }) {
  const [pending, start] = useTransition();
  const [notify, setNotify] = useState(canText);
  const [error, setError] = useState<string | null>(null);
  const go = (s: VisitStatus) =>
    start(async () => {
      const r = await visitStatusAction(visitId, s, notify);
      if (r.error) setError(r.error);
    });
  if (status === "done") return <p className="text-sm font-medium text-green-700">Done ✓</p>;
  if (status === "cancelled") return <p className="text-sm text-gray-500">Cancelled</p>;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        <button className="btn-secondary py-3" disabled={pending || status !== "scheduled"} onClick={() => go("en_route")}>
          On my way
        </button>
        <button className="btn-secondary py-3" disabled={pending || status === "in_progress"} onClick={() => go("in_progress")}>
          Start
        </button>
        <button className="btn-primary py-3" disabled={pending} onClick={() => go("done")}>
          Complete
        </button>
      </div>
      {canText && status === "scheduled" && (
        <label className="flex items-center gap-2 text-xs text-gray-600">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Text the customer when I tap &ldquo;On my way&rdquo;
        </label>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
