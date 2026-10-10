"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { WINDOWS } from "@/lib/booking";
import { TRADES } from "@/lib/stages";
import { submitBookingAction } from "./actions";

export function BookingForm({ dates, embedded }: { dates: { ymd: string; label: string }[]; embedded: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [showThird, setShowThird] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Tell the parent page (our website) how tall the form is, so the iframe fits without scrolling.
  useEffect(() => {
    if (!embedded || !root.current) return;
    const post = () => window.parent?.postMessage({ type: "doc-booking-height", height: document.documentElement.scrollHeight }, "*");
    const ro = new ResizeObserver(post);
    ro.observe(root.current);
    post();
    return () => ro.disconnect();
  }, [embedded, done, showThird, error]);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const s = (k: string) => String(fd.get(k) ?? "");
    setError(null);
    start(async () => {
      const res = await submitBookingAction({
        name: s("name"),
        phone: s("phone"),
        email: s("email"),
        street: s("street"),
        city: s("city"),
        zip: s("zip"),
        trade: s("trade") as never,
        message: s("message"),
        date: s("date"),
        window: s("window"),
        altDate: s("altDate"),
        altWindow: s("altWindow"),
        alt2Date: showThird && s("alt2Date") ? s("alt2Date") : undefined,
        alt2Window: showThird && s("alt2Window") ? s("alt2Window") : undefined,
        company_website: s("company_website"),
      });
      if (res.ok) setDone(true);
      else setError(res.error ?? "Something went wrong.");
    });
  }

  if (done) {
    return (
      <div ref={root} className="rounded-xl border-2 border-green-600 bg-green-50 p-6 text-center">
        <h2 className="text-xl font-semibold text-green-800">Request received</h2>
        <p className="mt-2 text-sm text-gray-700">Thanks! We&apos;ll text you shortly to confirm your appointment.</p>
      </div>
    );
  }

  return (
    <div ref={root}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-6" aria-label="Request an appointment">
        <div className="sm:col-span-3">
          <label className="label" htmlFor="b-name">
            Name
          </label>
          <input id="b-name" name="name" className="input" autoComplete="name" required />
        </div>
        <div className="sm:col-span-3">
          <label className="label" htmlFor="b-phone">
            Mobile phone
          </label>
          <input id="b-phone" name="phone" type="tel" className="input" autoComplete="tel" required />
        </div>
        <div className="sm:col-span-6">
          <label className="label" htmlFor="b-email">
            Email (optional)
          </label>
          <input id="b-email" name="email" type="email" className="input" autoComplete="email" />
        </div>
        <div className="sm:col-span-6">
          <label className="label" htmlFor="b-street">
            Service address
          </label>
          <input id="b-street" name="street" className="input" autoComplete="street-address" required />
        </div>
        <div className="sm:col-span-4">
          <label className="label" htmlFor="b-city">
            City
          </label>
          <input id="b-city" name="city" className="input" autoComplete="address-level2" defaultValue="Cincinnati" />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="b-zip">
            ZIP
          </label>
          <input id="b-zip" name="zip" className="input" inputMode="numeric" autoComplete="postal-code" required />
        </div>
        <fieldset className="sm:col-span-6">
          <legend className="label">What do you need?</legend>
          <div className="flex flex-wrap gap-2">
            {TRADES.map((t, i) => (
              <label key={t.id} className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm has-[:checked]:border-brand has-[:checked]:bg-brand/5">
                <input type="radio" name="trade" value={t.id} defaultChecked={i === 0} />
                {t.id === "hvac" ? "Heating & cooling" : t.label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="sm:col-span-6">
          <label className="label" htmlFor="b-message">
            What&apos;s going on?
          </label>
          <textarea id="b-message" name="message" className="input min-h-24" placeholder="e.g. Upstairs AC is blowing warm air" required />
        </div>

        <div className="grid gap-4 sm:col-span-6 md:grid-cols-2">
          <Choice title="First choice" dayName="date" windowName="window" dates={dates} required defaultWindow="09-12" />
          <Choice title="Second choice" dayName="altDate" windowName="altWindow" dates={dates} required defaultWindow="12-15" />
          {showThird ? (
            <Choice title="Third choice (optional)" dayName="alt2Date" windowName="alt2Window" dates={dates} required={false} />
          ) : (
            <button type="button" className="self-start text-sm text-brand underline md:col-span-2" onClick={() => setShowThird(true)}>
              Add a third choice
            </button>
          )}
        </div>

        {/* Honeypot: hidden from people, bots fill it in. */}
        <input name="company_website" tabIndex={-1} autoComplete="off" aria-hidden="true" className="absolute -left-[9999px] h-0 w-0" />

        <div className="sm:col-span-6">
          <button className="btn-primary w-full py-3 text-base" disabled={pending}>
            {pending ? "Sending…" : "Request appointment"}
          </button>
          {error && <p className="mt-2 rounded-md bg-red-50 p-2 text-sm text-red-700">{error}</p>}
          <p className="mt-2 text-xs text-gray-500">
            We&apos;ll confirm by text. By submitting you agree to receive texts about your appointment; reply STOP to opt out. See our{" "}
            <a href="/privacy" target="_blank" rel="noreferrer" className="underline">
              Privacy Policy
            </a>
            .
          </p>
        </div>
      </form>
    </div>
  );
}

function Choice(props: {
  title: string;
  dayName: string;
  windowName: string;
  dates: { ymd: string; label: string }[];
  required: boolean;
  defaultWindow?: string;
}) {
  return (
    <fieldset className="rounded-lg border p-4">
      <legend className="px-1 text-sm font-semibold">{props.title}</legend>
      <label className="label" htmlFor={`b-${props.dayName}`}>
        Day
      </label>
      <select id={`b-${props.dayName}`} name={props.dayName} className="input" required={props.required} defaultValue="">
        <option value="" disabled={props.required}>
          {props.required ? "Choose a day" : "No third choice"}
        </option>
        {props.dates.map((d) => (
          <option key={d.ymd} value={d.ymd}>
            {d.label}
          </option>
        ))}
      </select>
      <span className="label mt-3">Arrival window</span>
      <div className="grid gap-2">
        {WINDOWS.map((w) => (
          <label
            key={w.id}
            className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm has-[:checked]:border-brand has-[:checked]:bg-brand/5"
          >
            <input type="radio" name={props.windowName} value={w.id} defaultChecked={w.id === props.defaultWindow} required={props.required} />
            {w.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
