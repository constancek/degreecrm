"use client";

import { useActionState, useState } from "react";
import { SOURCES, STAGES, TRADES } from "@/lib/stages";
import type { LeadSource, LeadStage, Trade } from "@/generated/prisma/enums";
import { assignAction, noteAction, stageFormAction, updateLeadAction } from "../../actions";

function ErrorText({ error }: { error?: string }) {
  return error ? <p role="alert" className="mt-2 text-sm text-red-700">{error}</p> : null;
}

export function StageForm({ leadId, stage }: { leadId: string; stage: LeadStage }) {
  const [state, action, pending] = useActionState(stageFormAction.bind(null, leadId), undefined);
  // The parent keys this form on `stage`, so the selection resets when the stage changes.
  const [selected, setSelected] = useState(stage);

  return (
    <form action={action} className="mt-3 space-y-2">
      <label className="sr-only" htmlFor="stage">
        Move to stage
      </label>
      <select
        id="stage"
        name="stage"
        className="input"
        value={selected}
        onChange={(e) => setSelected(e.target.value as LeadStage)}
      >
        {STAGES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      {selected === "lost" && stage !== "lost" && (
        <input name="lostReason" className="input" placeholder="Why was it lost?" aria-label="Lost reason" />
      )}
      <button className="btn-secondary w-full" disabled={pending || selected === stage}>
        {pending ? "Saving…" : "Update stage"}
      </button>
      <ErrorText error={state?.error} />
    </form>
  );
}

export function AssignForm({
  leadId,
  assignedToId,
  staff,
}: {
  leadId: string;
  assignedToId: string | null;
  staff: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(assignAction.bind(null, leadId), undefined);
  return (
    <form action={action} className="mt-2 flex gap-2">
      <select name="assignedToId" className="input" defaultValue={assignedToId ?? ""} aria-label="Assign to">
        <option value="">Unassigned</option>
        {staff.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <button className="btn-secondary" disabled={pending}>
        Save
      </button>
      <ErrorText error={state?.error} />
    </form>
  );
}

export function NoteForm({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState(noteAction.bind(null, leadId), undefined);
  return (
    <form action={action}>
      <label className="sr-only" htmlFor="note">
        Add a note
      </label>
      <textarea id="note" name="body" className="input min-h-20" placeholder="Add a note…" required />
      <div className="mt-2 flex items-center gap-3">
        <button className="btn-primary" disabled={pending}>
          {pending ? "Saving…" : "Add note"}
        </button>
        <ErrorText error={state?.error} />
      </div>
    </form>
  );
}

export function LeadDetailsForm(props: {
  leadId: string;
  title: string;
  trade: Trade;
  source: LeadSource;
  notes: string;
}) {
  const [state, action, pending] = useActionState(updateLeadAction.bind(null, props.leadId), undefined);
  return (
    <form action={action} className="card grid gap-3 p-4 sm:grid-cols-2">
      <h2 className="font-semibold sm:col-span-2">Details</h2>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="title">
          Job
        </label>
        <input id="title" name="title" className="input" defaultValue={props.title} required />
      </div>
      <div>
        <label className="label" htmlFor="trade">
          Trade
        </label>
        <select id="trade" name="trade" className="input" defaultValue={props.trade}>
          {TRADES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="source">
          Source
        </label>
        <select id="source" name="source" className="input" defaultValue={props.source}>
          {SOURCES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="notes">
          Notes
        </label>
        <textarea id="notes" name="notes" className="input min-h-24" defaultValue={props.notes} />
      </div>
      <div className="flex items-center gap-3 sm:col-span-2">
        <button className="btn-secondary" disabled={pending}>
          {pending ? "Saving…" : "Save details"}
        </button>
        <ErrorText error={state?.error} />
      </div>
    </form>
  );
}
