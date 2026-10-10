"use client";

import { useActionState, useState } from "react";
import { WINDOWS, dateLabel, windowLabel } from "@/lib/booking";
import { confirmBookingAction, declineBookingAction } from "@/app/(crm)/ops-actions";

export function BookingPanel(props: {
  bookingId: string;
  leadId: string;
  date: string;
  window: string;
  altDate: string | null;
  altWindow: string | null;
  techs: { id: string; name: string }[];
  defaultTechId: string | null;
  dates: { ymd: string; label: string }[];
  canConfirm: boolean;
}) {
  const [confirmState, confirm, confirming] = useActionState(confirmBookingAction.bind(null, props.bookingId, props.leadId), undefined);
  const [declineState, decline, declining] = useActionState(declineBookingAction.bind(null, props.bookingId, props.leadId), undefined);
  const [choice, setChoice] = useState<"first" | "second">("first");
  const date = choice === "first" ? props.date : (props.altDate ?? props.date);
  const window = choice === "first" ? props.window : (props.altWindow ?? props.window);
  const dates = props.dates.some((d) => d.ymd === date) ? props.dates : [{ ymd: date, label: dateLabel(date) }, ...props.dates];

  return (
    <section className="card border-amber-400 p-4" aria-label="Booking request">
      <h2 className="font-semibold">Booking request</h2>
      <p className="mt-1 text-sm">
        Wants an estimate <strong>{dateLabel(props.date)}, {windowLabel(props.window)}</strong>
        {props.altDate && (
          <>
            {" "}or <strong>{dateLabel(props.altDate)}, {windowLabel(props.altWindow)}</strong>
          </>
        )}
        .
      </p>
      {props.canConfirm && (
        <>
          {props.altDate && (
            <div className="mt-2 flex gap-3 text-sm">
              <label className="flex items-center gap-1">
                <input type="radio" checked={choice === "first"} onChange={() => setChoice("first")} /> First choice
              </label>
              <label className="flex items-center gap-1">
                <input type="radio" checked={choice === "second"} onChange={() => setChoice("second")} /> Second choice
              </label>
            </div>
          )}
          <form key={choice} action={confirm} className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
            <select name="date" className="input" defaultValue={date} aria-label="Day">
              {dates.map((d) => (
                <option key={d.ymd} value={d.ymd}>
                  {d.label}
                </option>
              ))}
            </select>
            <select name="window" className="input" defaultValue={window} aria-label="Arrival window">
              {WINDOWS.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
            </select>
            <select name="techId" className="input" defaultValue={props.defaultTechId ?? props.techs[0]?.id} aria-label="Tech">
              {props.techs.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button className="btn-primary sm:col-span-3" disabled={confirming}>
              {confirming ? "Confirming…" : "Confirm & text customer"}
            </button>
            {confirmState?.error && <p className="text-red-700 sm:col-span-3">{confirmState.error}</p>}
            {confirmState?.ok && <p className="text-green-700 sm:col-span-3">{confirmState.ok}</p>}
          </form>
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-gray-600">Decline</summary>
            <form action={decline} className="mt-2 space-y-2">
              <textarea name="text" className="input min-h-16" placeholder="Optional text to the customer, e.g. a different time you can offer" aria-label="Text to customer" />
              <button className="btn-secondary" disabled={declining}>
                Decline request
              </button>
              {declineState?.error && <p className="text-red-700">{declineState.error}</p>}
            </form>
          </details>
        </>
      )}
    </section>
  );
}
