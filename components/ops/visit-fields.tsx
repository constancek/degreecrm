"use client";

// Form pieces shared by the pipeline drag dialog and the tech's visit buttons (My day).

import { useState } from "react";
import { WINDOWS } from "@/lib/booking";
import type { StageMovePayload } from "@/lib/services/stage-moves";

export const RESCHEDULE_REASON_OPTIONS = [
  ["tech_delayed", "Tech held up at a previous call"],
  ["tech_unavailable", "Tech unavailable"],
  ["customer_request", "Customer asked to reschedule"],
  ["other", "Other"],
] as const;

export function ReasonSelect({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  return (
    <select className="input" aria-label="Reason" value={value} onChange={(e) => onChange(e.target.value)}>
      {RESCHEDULE_REASON_OPTIONS.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

/** Declined estimate: reason + whether to charge the service call fee. Shared with My day. */
export function DeclineFields({ p, set }: { p: StageMovePayload; set: (patch: StageMovePayload) => void }) {
  return (
    <>
      <select className="input" aria-label="Why declined" value={p.reason ?? ""} onChange={(e) => set({ reason: e.target.value })}>
        <option value="">Why did they decline?</option>
        <option>Too expensive</option>
        <option>Wants to think about it</option>
        <option>Getting other quotes</option>
        <option>Will do it themselves</option>
        <option>Not needed right now</option>
        <option>Other</option>
      </select>
      <fieldset className="space-y-2">
        <legend className="mb-1 font-medium">Service call fee</legend>
        {(
          [
            ["none", "No charge"],
            ["collect", "Collected on site"],
            ["invoice", "Send an invoice"],
          ] as const
        ).map(([v, l]) => (
          <label key={v} className="flex items-center gap-2">
            <input type="radio" name="fee" checked={(p.fee ?? "none") === v} onChange={() => set({ fee: v })} /> {l}
          </label>
        ))}
        {p.fee && p.fee !== "none" && (
          <div className="flex gap-2">
            <input className="input w-28" aria-label="Fee amount" inputMode="decimal" value={p.feeDollars ?? ""} onChange={(e) => set({ feeDollars: e.target.value })} />
            {p.fee === "collect" && (
              <select className="input" aria-label="Paid by" value={p.feeMethod ?? "card"} onChange={(e) => set({ feeMethod: e.target.value as "cash" | "check" | "card" })}>
                <option value="card">Card</option>
                <option value="cash">Cash</option>
                <option value="check">Check</option>
              </select>
            )}
          </div>
        )}
      </fieldset>
    </>
  );
}

const EXACT = "exact";

/**
 * Date + arrival window (or an exact time) + time on site. Posts `date`, `window`, `time`, `hours`;
 * the server turns them into the visit block and the window texted to the customer (`bookingTimes`).
 */
export function ArrivalFields(props: { idPrefix: string; defaultDate: string; defaultWindow?: string; defaultTime?: string; defaultHours?: number; hoursOptions?: number[] }) {
  const [win, setWin] = useState(props.defaultWindow ?? WINDOWS[0].id);
  const hours = props.hoursOptions ?? [0.5, 1, 1.5, 2, 3, 4, 6, 8];
  return (
    <>
      <div>
        <label className="label" htmlFor={`${props.idPrefix}-date`}>
          Date
        </label>
        <input id={`${props.idPrefix}-date`} name="date" type="date" className="input" defaultValue={props.defaultDate} required />
      </div>
      <div>
        <label className="label" htmlFor={`${props.idPrefix}-window`}>
          Arrival window
        </label>
        <select id={`${props.idPrefix}-window`} name="window" className="input" value={win} onChange={(e) => setWin(e.target.value)}>
          {WINDOWS.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label}
            </option>
          ))}
          <option value={EXACT}>Exact time…</option>
        </select>
      </div>
      {win === EXACT && (
        <div>
          <label className="label" htmlFor={`${props.idPrefix}-time`}>
            Arrival time
          </label>
          <input id={`${props.idPrefix}-time`} name="time" type="time" step={900} className="input" defaultValue={props.defaultTime ?? "09:00"} required />
        </div>
      )}
      <div>
        <label className="label" htmlFor={`${props.idPrefix}-hours`}>
          Time on site
        </label>
        <select id={`${props.idPrefix}-hours`} name="hours" className="input" defaultValue={String(props.defaultHours ?? 1)}>
          {hours.map((h) => (
            <option key={h} value={String(h)}>
              {h === 0.5 ? "30 min" : h === 1 ? "1 hour" : `${h} hours`}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

/** Tech picker with "assign later". */
export function TechField(props: { id: string; techs: { id: string; name: string }[]; defaultTechId?: string | null; allowNone?: boolean; onChange?: (v: string) => void }) {
  return (
    <div>
      <label className="label" htmlFor={props.id}>
        Technician
      </label>
      <select id={props.id} name="techId" className="input" defaultValue={props.defaultTechId ?? props.techs[0]?.id ?? ""} onChange={(e) => props.onChange?.(e.target.value)}>
        {props.techs.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
        {props.allowNone && <option value="">Assign a tech later</option>}
      </select>
    </div>
  );
}
