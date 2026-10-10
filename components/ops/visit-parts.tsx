// Presentational pieces for the tech's Today list and appointment page (server-safe, no hooks).

import { Check, Message, Navigate, Phone } from "@/components/ui/icons";
import { formatPhone } from "@/lib/phone";
import { phaseLabel, visitPhase, visitSteps, type VisitStepInput } from "@/lib/visit-steps";

/**
 * "On the way · On site · Estimate · Signed · Wrapped up" with the current step marked. Phones show the bars
 * plus "Step 3 of 5 · Estimate"; wider screens label every step.
 */
export function StepStrip({ visit }: { visit: VisitStepInput }) {
  const steps = visitSteps(visit);
  const at = steps.findIndex((s) => s.state === "current");
  return (
    <div>
      <ol className="flex items-center gap-1 text-xs" aria-label="Visit progress">
        {steps.map((s) => (
          <li key={s.label} className="flex min-w-0 flex-1 flex-col gap-1.5" aria-current={s.state === "current" ? "step" : undefined}>
            <span className={`h-1.5 rounded-full ${s.state === "done" ? "bg-brand" : s.state === "current" ? "bg-brand/45" : "bg-gray-200"}`} />
            <span
              className={`hidden items-center gap-1 truncate sm:flex ${s.state === "current" ? "font-semibold text-gray-900" : s.state === "done" ? "text-gray-700" : "text-gray-500"}`}
            >
              {s.state === "done" && <Check className="size-3 shrink-0 text-brand" />}
              <span className="truncate">{s.label}</span>
            </span>
            <span className="sr-only">
              {s.label}
              {s.state === "done" ? " (done)" : s.state === "current" ? " (now)" : ""}
            </span>
          </li>
        ))}
      </ol>
      {at >= 0 && (
        <p aria-hidden className="mt-1.5 text-xs text-gray-600 sm:hidden">
          Step {at + 1} of {steps.length} · <span className="font-semibold text-gray-900">{steps[at]!.label}</span>
        </p>
      )}
    </div>
  );
}

const CHIP: Record<string, string> = {
  en_route: "bg-sky-50 text-sky-900 ring-sky-200",
  on_site_no_estimate: "bg-sky-50 text-sky-900 ring-sky-200",
  on_site_estimate: "bg-sky-50 text-sky-900 ring-sky-200",
  working: "bg-sky-50 text-sky-900 ring-sky-200",
  on_site_signed: "bg-green-50 text-green-900 ring-green-200",
  done: "bg-green-50 text-green-900 ring-green-200",
  no_tech: "bg-amber-50 text-amber-900 ring-amber-200",
};

export function PhaseChip({ visit }: { visit: VisitStepInput }) {
  const phase = visitPhase(visit);
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${CHIP[phase] ?? "bg-gray-50 text-gray-700 ring-gray-200"}`}
    >
      {phaseLabel(phase, visit.outcome)}
    </span>
  );
}

/** Directions, Call, Text: the three things a tech does from the truck. */
export function ContactButtons({ address, phone, canText }: { address: string | null; phone: string | null; canText: boolean }) {
  const btn = "btn-secondary min-w-0 flex-1 px-2 py-2.5";
  return (
    <div className="flex gap-2">
      {address && (
        <a className={btn} href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`} target="_blank" rel="noreferrer">
          <Navigate className="size-4 shrink-0 text-brand" /> Directions
        </a>
      )}
      {phone && (
        <a className={btn} href={`tel:${phone}`} aria-label={`Call ${formatPhone(phone)}`}>
          <Phone className="size-4 shrink-0 text-brand" /> Call
        </a>
      )}
      {phone && canText && (
        <a className={btn} href={`sms:${phone}`} aria-label={`Text ${formatPhone(phone)}`}>
          <Message className="size-4 shrink-0 text-brand" /> Text
        </a>
      )}
    </div>
  );
}
