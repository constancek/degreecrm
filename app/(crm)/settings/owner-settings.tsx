"use client";

import { useActionState, useState } from "react";
import { formatRate } from "@/lib/money";
import type { CompanyProfile } from "@/lib/services/company";
import { Close } from "@/components/ui/icons";
import {
  addTechAction,
  removeLogoAction,
  saveCompanyAction,
  saveTaxRatesAction,
  saveTermsAction,
  uploadLogoAction,
  type SettingsState,
} from "./actions";

function Status({ state }: { state: SettingsState }) {
  if (state?.error) return <p role="alert" className="text-sm text-red-700">{state.error}</p>;
  if (state?.ok) return <p role="status" className="text-sm text-green-700">{state.ok}</p>;
  return null;
}

function Field({ label, name, defaultValue, ...rest }: { label: string; name: string; defaultValue: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label className="label" htmlFor={name}>
        {label}
      </label>
      <input id={name} name={name} className="input" defaultValue={defaultValue} {...rest} />
    </div>
  );
}

export function CompanySettings({
  company,
  phoneDisplay,
  alertPhoneDisplay,
}: {
  company: CompanyProfile;
  phoneDisplay: string;
  alertPhoneDisplay: string;
}) {
  const [state, action, pending] = useActionState(saveCompanyAction, undefined);
  const [logoState, logoAction, logoPending] = useActionState(uploadLogoAction, undefined);

  return (
    <section className="card p-4">
      <h2 className="font-semibold">Company</h2>
      <p className="mt-1 text-sm text-gray-600">Shown on proposals, the PDF and client pages.</p>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        {company.logoPath ? (
          // eslint-disable-next-line @next/next/no-img-element -- streamed from private storage
          <img src={`/brand/logo?v=${company.logoVersion}`} alt="Company logo" className="h-14 w-auto rounded border bg-white p-1" />
        ) : (
          <div className="flex h-14 w-28 items-center justify-center rounded border border-dashed text-xs text-gray-500">No logo</div>
        )}
        <form action={logoAction} className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="logo">
            Logo file
          </label>
          <input id="logo" name="logo" type="file" accept="image/png,image/jpeg,image/webp" className="text-sm" />
          <button className="btn-secondary" disabled={logoPending}>
            {logoPending ? "Uploading…" : company.logoPath ? "Replace logo" : "Upload logo"}
          </button>
        </form>
        {company.logoPath && (
          <form action={removeLogoAction}>
            <button className="text-sm text-red-700 underline">Remove</button>
          </form>
        )}
        <Status state={logoState} />
      </div>
      <p className="mt-1 text-xs text-gray-500">PNG, JPEG or WebP, up to 2 MB. A wide logo on a transparent background looks best.</p>

      <form action={action} className="mt-4 grid gap-3 sm:grid-cols-6">
        <div className="sm:col-span-6">
          <Field label="Company name" name="name" defaultValue={company.name} required />
        </div>
        <div className="sm:col-span-6">
          <Field label="Street address" name="street" defaultValue={company.street} />
        </div>
        <div className="sm:col-span-3">
          <Field label="City" name="city" defaultValue={company.city} />
        </div>
        <div className="sm:col-span-1">
          <Field label="State" name="state" defaultValue={company.state} maxLength={2} />
        </div>
        <div className="sm:col-span-2">
          <Field label="ZIP" name="zip" defaultValue={company.zip} />
        </div>
        <div className="sm:col-span-3">
          <Field label="Phone number" name="phone" defaultValue={phoneDisplay} type="tel" />
        </div>
        <div className="sm:col-span-3">
          <Field label="Support email" name="email" defaultValue={company.email} type="email" />
        </div>
        <div className="sm:col-span-3">
          <Field label="License number" name="licenseNumber" defaultValue={company.licenseNumber} />
        </div>
        <div className="sm:col-span-3">
          <Field label="Website" name="website" defaultValue={company.website} />
        </div>

        <div className="sm:col-span-3">
          <Field label="Your mobile for alerts (signed proposals, urgent texts)" name="ownerAlertPhone" defaultValue={alertPhoneDisplay} type="tel" />
        </div>
        <div className="sm:col-span-3">
          <Field label="Google review link" name="googleReviewUrl" defaultValue={company.googleReviewUrl} placeholder="https://g.page/r/…" />
        </div>
        <div className="sm:col-span-6">
          <Field label="Acorn Finance contractor link (shows “Pay monthly”)" name="acornLink" defaultValue={company.acornLink} placeholder="https://…" />
        </div>

        <div className="sm:col-span-3">
          <Field
            label="Service call fee (charged when an estimate is declined, if the tech chooses)"
            name="serviceCallFee"
            defaultValue={(company.serviceCallFeeCents / 100).toFixed(2)}
          />
        </div>

        <fieldset className="rounded-md border border-gray-200 p-3 sm:col-span-6">
          <legend className="px-1 text-sm font-medium">Deposit (jobs scheduled for a return visit; same-visit repairs pay at the end)</legend>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <input name="depositBelow" type="number" min={0} max={100} className="input w-20" defaultValue={company.depositBelowPercent} aria-label="Deposit percent below threshold" />
            % for jobs under $
            <input
              name="depositThreshold"
              className="input w-28"
              defaultValue={(company.depositThresholdCents / 100).toFixed(0)}
              aria-label="Deposit threshold"
            />
            , otherwise
            <input name="depositAbove" type="number" min={0} max={100} className="input w-20" defaultValue={company.depositAbovePercent} aria-label="Deposit percent at or above threshold" />
            %
          </div>
        </fieldset>

        <div className="flex items-center gap-3 sm:col-span-6">
          <button className="btn-primary" disabled={pending}>
            {pending ? "Saving…" : "Save company details"}
          </button>
          <Status state={state} />
        </div>
      </form>
    </section>
  );
}

export function TermsSettings({ version, body, keyTerms }: { version: number | null; body: string; keyTerms: string }) {
  const [state, action, pending] = useActionState(saveTermsAction, undefined);
  return (
    <section className="card p-4">
      <h2 className="font-semibold">Terms &amp; Conditions {version ? <span className="text-sm font-normal text-gray-500">· version {version}</span> : null}</h2>
      <p className="mt-1 text-sm text-gray-600">
        Saving creates a new version. Proposals keep the version they were sent with, so a customer&apos;s agreement never
        changes after the fact. Have an attorney review this before real customers sign.
      </p>
      <form action={action} className="mt-3 space-y-3">
        <div>
          <label className="label" htmlFor="keyTerms">
            Key terms (one per line, shown above the checkbox). Use {"{deposit}"} and {"{expires}"}.
          </label>
          <textarea id="keyTerms" name="keyTerms" className="input min-h-36 font-mono text-xs" defaultValue={keyTerms} />
        </div>
        <div>
          <label className="label" htmlFor="termsBody">
            Full Terms &amp; Conditions (Markdown: # Heading, **bold**, - bullet)
          </label>
          <textarea id="termsBody" name="body" className="input min-h-96 font-mono text-xs" defaultValue={body} />
        </div>
        <div className="flex items-center gap-3">
          <button className="btn-primary" disabled={pending}>
            {pending ? "Saving…" : "Save as new version"}
          </button>
          {version && (
            <a href={`/terms/${version}`} target="_blank" rel="noreferrer" className="text-sm text-brand underline">
              View current version
            </a>
          )}
          <Status state={state} />
        </div>
      </form>
    </section>
  );
}

export function TaxSettings({ rates }: { rates: { state: string; county: string; rateBps: number }[] }) {
  const [state, action, pending] = useActionState(saveTaxRatesAction, undefined);
  const [rows, setRows] = useState(rates.map((r, i) => ({ key: i, ...r, rate: formatRate(r.rateBps).replace("%", "") })));
  return (
    <section className="card p-4">
      <h2 className="font-semibold">Sales tax rates</h2>
      <p className="mt-1 text-sm text-gray-600">
        The job address decides the rate: its county row first, then the state row (blank county). Ohio rates are the state
        5.75% plus the county&apos;s; check them each quarter at tax.ohio.gov.
      </p>
      <form action={action} className="mt-3">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="pb-1 font-medium">State</th>
              <th className="pb-1 font-medium">County (blank = whole state)</th>
              <th className="pb-1 font-medium">Rate %</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="py-1 pr-2">
                  <input name="state" defaultValue={r.state} className="input w-16" maxLength={2} aria-label="State" />
                </td>
                <td className="py-1 pr-2">
                  <input name="county" defaultValue={r.county} className="input" aria-label="County" />
                </td>
                <td className="py-1 pr-2">
                  <input name="rate" defaultValue={r.rate} className="input w-24" inputMode="decimal" aria-label="Rate percent" />
                </td>
                <td className="py-1">
                  <button type="button" className="icon-btn hover:text-red-700" aria-label="Remove row" onClick={() => setRows((x) => x.filter((y) => y.key !== r.key))}>
                    <Close />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setRows((x) => [...x, { key: Date.now(), state: "OH", county: "", rateBps: 0, rate: "" }])}
          >
            Add row
          </button>
          <button className="btn-primary" disabled={pending}>
            {pending ? "Saving…" : "Save tax rates"}
          </button>
          <Status state={state} />
        </div>
      </form>
    </section>
  );
}

/** Owner adds a tech by name + Google address; they can sign in right away. */
export function AddTechForm() {
  const [state, action, pending] = useActionState(addTechAction, undefined);
  return (
    <form action={action} className="mt-4 space-y-3 border-t pt-4" key={state?.ok}>
      <h3 className="text-sm font-semibold">Add a tech</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="tech-name">
            Name
          </label>
          <input id="tech-name" name="name" className="input" autoComplete="off" required />
        </div>
        <div>
          <label className="label" htmlFor="tech-email">
            Google sign-in email
          </label>
          <input id="tech-email" name="email" type="email" className="input" autoComplete="off" required />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button className="btn-primary" disabled={pending}>
          {pending ? "Adding…" : "Add tech"}
        </button>
        <Status state={state} />
      </div>
    </form>
  );
}
