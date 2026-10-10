"use client";

import { useActionState, useState, useTransition } from "react";
import { finalInvoiceAction, updateJobAction } from "../../ops-actions";

export function InvoiceButton({ jobId }: { jobId: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <>
      <button
        className="btn-secondary w-full"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await finalInvoiceAction(jobId);
            setMsg(r.error ?? r.ok ?? null);
          })
        }
      >
        {pending ? "Creating…" : "Create & send final invoice"}
      </button>
      {msg && <p className="mt-1 text-sm">{msg}</p>}
    </>
  );
}

export function JobDurationForm({ jobId, hours }: { jobId: string; hours: number }) {
  const [state, action, pending] = useActionState(updateJobAction.bind(null, jobId), undefined);
  return (
    <form action={action} className="flex items-end gap-2 text-sm">
      <div>
        <label className="label" htmlFor="durationHours">
          Estimated hours on site
        </label>
        <input id="durationHours" name="durationHours" type="number" step={0.5} min={0.5} className="input w-24" defaultValue={hours} />
      </div>
      <button className="btn-secondary" disabled={pending}>
        Save
      </button>
      {state?.error && <p className="text-red-700">{state.error}</p>}
    </form>
  );
}
