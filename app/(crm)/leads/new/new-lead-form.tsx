"use client";

import { useActionState } from "react";
import { SOURCES, TRADES } from "@/lib/stages";
import { createLeadAction } from "../../actions";
import { AddressFields } from "./address-fields";

export function NewLeadForm({
  staff,
  canAssign,
  mapsKey,
}: {
  staff: { id: string; name: string }[];
  canAssign: boolean;
  mapsKey?: string;
}) {
  const [state, action, pending] = useActionState(createLeadAction, undefined);

  return (
    <form action={action} className="space-y-6">
      {state?.error && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">{state.error}</p>}

      <fieldset className="card grid gap-4 p-4 sm:grid-cols-2">
        <legend className="px-1 text-sm font-semibold">Customer</legend>
        <p className="text-xs text-gray-500 sm:col-span-2">
          Matched to an existing customer by phone, then email. Otherwise a new customer is created.
        </p>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="customerName">
            Name
          </label>
          <input id="customerName" name="customerName" className="input" required />
        </div>
        <div>
          <label className="label" htmlFor="phone">
            Phone
          </label>
          <input id="phone" name="phone" type="tel" className="input" placeholder="(513) 555-0123" />
        </div>
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input id="email" name="email" type="email" className="input" />
        </div>
        <div>
          <label className="label" htmlFor="customerType">
            Type
          </label>
          <select id="customerType" name="customerType" className="input" defaultValue="residential">
            <option value="residential">Residential</option>
            <option value="commercial">Commercial</option>
          </select>
        </div>
      </fieldset>

      <fieldset className="card grid gap-4 p-4 sm:grid-cols-6">
        <legend className="px-1 text-sm font-semibold">Property</legend>
        <AddressFields apiKey={mapsKey} />
        <div className="sm:col-span-6">
          <label className="label" htmlFor="propertyNotes">
            Access / equipment notes
          </label>
          <input id="propertyNotes" name="propertyNotes" className="input" placeholder="Gate code, dog, unit in attic…" />
        </div>
      </fieldset>

      <fieldset className="card grid gap-4 p-4 sm:grid-cols-2">
        <legend className="px-1 text-sm font-semibold">Job</legend>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="title">
            What&apos;s the job?
          </label>
          <input id="title" name="title" className="input" placeholder="AC not cooling upstairs" required />
        </div>
        <div>
          <label className="label" htmlFor="trade">
            Trade
          </label>
          <select id="trade" name="trade" className="input" required defaultValue="hvac">
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
          <select id="source" name="source" className="input" defaultValue="phone">
            {SOURCES.filter((s) => s.id !== "mcp").map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        {canAssign && (
          <div>
            <label className="label" htmlFor="assignedToId">
              Assign to
            </label>
            <select id="assignedToId" name="assignedToId" className="input" defaultValue="">
              <option value="">Unassigned</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="sm:col-span-2">
          <label className="label" htmlFor="notes">
            Notes
          </label>
          <textarea id="notes" name="notes" className="input min-h-28" />
        </div>
      </fieldset>

      <button className="btn-primary" type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create lead"}
      </button>
    </form>
  );
}
