"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { SOURCES, TRADES } from "@/lib/stages";
import { AddressFields } from "../leads/new/address-fields";
import { ArrivalFields, TechField } from "@/components/ops/visit-fields";
import { createAppointmentAction, lookupLeadsAction, type LeadOption } from "./actions";
import { useDialog } from "@/lib/client/use-dialog";
import { Close } from "@/components/ui/icons";

export type AppointmentDefaults = { date: string; time: string; techId: string };

/** A clicked slot at a window's start pre-selects that window; any other time books an exact arrival time. */
const WINDOW_STARTS: Record<string, string> = { "09:00": "09-12", "12:00": "12-15", "15:00": "15-18" };

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="flex overflow-hidden rounded-md border text-sm" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={`flex-1 px-3 py-2 ${value === v ? "bg-brand text-white" : "bg-white text-gray-700 hover:bg-gray-50"}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export function NewAppointmentDialog({
  defaults,
  staff,
  mapsKey,
  onClose,
  onBooked,
}: {
  defaults: AppointmentDefaults;
  staff: { id: string; name: string }[];
  mapsKey?: string;
  onClose: () => void;
  onBooked: () => void;
}) {
  const [state, action, pending] = useActionState(createAppointmentAction, undefined);
  const [kind, setKind] = useState<"estimate" | "job">("estimate");
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LeadOption[]>([]);
  const [lead, setLead] = useState<LeadOption | null>(null);
  const [tech, setTech] = useState(defaults.techId);
  const search = useRef(0);

  useEffect(() => {
    if (state?.ok) onBooked();
  }, [state, onBooked]);

  const panel = useDialog<HTMLDivElement>(onClose);

  // Live lead search (debounced; stale answers are dropped).
  useEffect(() => {
    if (mode !== "existing" || lead) return;
    const n = ++search.current;
    const t = setTimeout(async () => {
      const found = await lookupLeadsAction(query);
      if (n === search.current) setResults(found);
    }, 250);
    return () => clearTimeout(t);
  }, [query, mode, lead]);

  const pickKind = (k: "estimate" | "job") => {
    setKind(k);
    if (k === "job") setMode("existing");
    if (k === "job" && lead && !lead.hasJob) setLead(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-appt-title"
        className="max-h-[95dvh] w-full max-w-2xl overflow-y-auto rounded-t-xl bg-white p-4 shadow-xl sm:rounded-xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 id="new-appt-title" className="text-lg font-semibold">
            New appointment
          </h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Close className="size-5" />
          </button>
        </div>

        <form action={action} className="mt-4 space-y-5">
          {state?.error && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">{state.error}</p>}
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="customerMode" value={mode} />
          <input type="hidden" name="leadId" value={mode === "existing" ? (lead?.id ?? "") : ""} />

          <Segmented
            label="Appointment type"
            value={kind}
            onChange={pickKind}
            options={[
              ["estimate", "Estimate"],
              ["job", "Job visit"],
            ]}
          />

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">Customer</h3>
              {kind === "estimate" && (
                <div className="w-64">
                  <Segmented
                    label="Customer"
                    value={mode}
                    onChange={setMode}
                    options={[
                      ["existing", "Existing"],
                      ["new", "New customer"],
                    ]}
                  />
                </div>
              )}
            </div>

            {mode === "existing" ? (
              lead ? (
                <div className="flex items-start justify-between gap-3 rounded-md border bg-gray-50 p-3 text-sm">
                  <div>
                    <p className="font-semibold">{lead.customer}</p>
                    <p className="text-gray-700">{lead.title}</p>
                    <p className="text-gray-500">{[lead.address, lead.phone].filter(Boolean).join(" · ")}</p>
                  </div>
                  <button type="button" className="text-sm text-brand underline" onClick={() => setLead(null)}>
                    Change
                  </button>
                </div>
              ) : (
                <div>
                  <label className="label" htmlFor="lead-search">
                    Search by name, phone, address or job
                  </label>
                  <input id="lead-search" className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. Smith or 513-555" autoFocus />
                  <ul className="mt-2 max-h-56 divide-y overflow-y-auto rounded-md border">
                    {results.length === 0 && <li className="p-3 text-sm text-gray-500">No matches{kind === "estimate" ? ". Use “New customer” to add one." : "."}</li>}
                    {results.map((r) => {
                      const disabled = kind === "job" && !r.hasJob;
                      return (
                        <li key={r.id}>
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => setLead(r)}
                            className="w-full p-3 text-left text-sm hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <span className="font-semibold">{r.customer}</span> – {r.title}
                            <span className="block text-gray-500">
                              {[r.address, r.phone].filter(Boolean).join(" · ")}
                              {disabled ? " · no job yet (the deposit creates it)" : ""}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )
            ) : (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <label className="label" htmlFor="customerName">
                      Name
                    </label>
                    <input id="customerName" name="customerName" className="input" required autoFocus />
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
                </div>
                <div className="grid gap-3 sm:grid-cols-6">
                  <AddressFields apiKey={mapsKey} />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
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
                    <select id="trade" name="trade" className="input" defaultValue="hvac">
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
                </div>
              </div>
            )}
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            <h3 className="text-sm font-semibold sm:col-span-2">When &amp; who</h3>
            <ArrivalFields
              key={kind}
              idPrefix="appt"
              defaultDate={defaults.date}
              defaultWindow={WINDOW_STARTS[defaults.time] ?? "exact"}
              defaultTime={defaults.time}
              defaultHours={kind === "job" ? 8 : 1}
            />
            <TechField id="appt-tech" techs={staff} defaultTechId={defaults.techId} allowNone onChange={setTech} />
            <div className="sm:col-span-2">
              <label className="label" htmlFor="appt-notes">
                Notes for the visit
              </label>
              <textarea id="appt-notes" name="notes" className="input min-h-20" placeholder="Gate code, what to bring…" />
            </div>
          </section>

          <p className="text-xs text-gray-500">
            {tech
              ? "Booking adds the visit to the tech's Google Calendar and texts the customer the arrival window and technician (plus a reminder)."
              : "No text yet: the appointment waits in Needs tech. The customer gets the confirmation once you assign a technician."}
          </p>

          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={pending || (mode === "existing" && !lead)}>
              {pending ? "Booking…" : tech ? "Book & text customer" : "Book without a tech"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
