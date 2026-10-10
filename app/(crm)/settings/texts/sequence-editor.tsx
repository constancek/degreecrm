"use client";

import { useState, useTransition } from "react";
import { saveSequenceAction } from "../../ops-actions";

type Step = { anchor: string; offsetHours: number; template: string; personalize: boolean };

function describe(s: Step) {
  const h = Math.abs(s.offsetHours);
  const span = h >= 48 && h % 24 === 0 ? `${h / 24} days` : `${h} hours`;
  if (s.anchor === "enrolled") return s.offsetHours === 0 ? "right away" : `${span} after it starts`;
  const rel = s.anchor === "visit_start" ? "the visit starts" : "the visit ends";
  return s.offsetHours === 0 ? `when ${rel}` : `${span} ${s.offsetHours < 0 ? "before" : "after"} ${rel}`;
}

export function SequenceEditor({ id, triggerLabel, initial }: { id: string; triggerLabel: string; initial: { name: string; active: boolean; steps: Step[] } }) {
  const [seq, setSeq] = useState(initial);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const update = (i: number, patch: Partial<Step>) => setSeq((s) => ({ ...s, steps: s.steps.map((st, j) => (j === i ? { ...st, ...patch } : st)) }));

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <input className="input max-w-xs font-semibold" value={seq.name} onChange={(e) => setSeq({ ...seq, name: e.target.value })} aria-label="Sequence name" />
        <span className="text-sm text-gray-500">Starts when: {triggerLabel}</span>
        <label className="ml-auto flex items-center gap-2 text-sm">
          <input type="checkbox" checked={seq.active} onChange={(e) => setSeq({ ...seq, active: e.target.checked })} /> On
        </label>
      </div>
      <ol className="mt-3 space-y-3">
        {seq.steps.map((st, i) => (
          <li key={i} className="rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">Text {i + 1}</span>
              <select className="input w-auto py-1" value={st.anchor} onChange={(e) => update(i, { anchor: e.target.value })} aria-label="Timing anchor">
                <option value="enrolled">after it starts</option>
                <option value="visit_start">relative to visit start</option>
                <option value="visit_end">relative to visit end</option>
              </select>
              <input
                className="input w-24 py-1"
                type="number"
                step={1}
                value={st.offsetHours}
                onChange={(e) => update(i, { offsetHours: Number(e.target.value) })}
                aria-label="Hours"
              />
              <span className="text-gray-500">hours ({describe(st)})</span>
              <label className="ml-auto flex items-center gap-1 text-xs text-gray-600">
                <input type="checkbox" checked={st.personalize} onChange={(e) => update(i, { personalize: e.target.checked })} /> Let Claude personalize
              </label>
              <button className="text-red-700" aria-label="Remove text" onClick={() => setSeq({ ...seq, steps: seq.steps.filter((_, j) => j !== i) })}>
                ✕
              </button>
            </div>
            <textarea className="input mt-2 min-h-16 text-sm" value={st.template} onChange={(e) => update(i, { template: e.target.value })} aria-label="Message" />
            <p className="text-right text-xs text-gray-400">{st.template.length} characters</p>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex items-center gap-3">
        <button
          className="btn-secondary"
          onClick={() => setSeq({ ...seq, steps: [...seq.steps, { anchor: "enrolled", offsetHours: 24, template: "", personalize: false }] })}
        >
          Add text
        </button>
        <button
          className="btn-primary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await saveSequenceAction(id, seq);
              setMsg(r.error ?? r.ok ?? null);
            })
          }
        >
          {pending ? "Saving…" : "Save"}
        </button>
        {msg && <span className="text-sm">{msg}</span>}
      </div>
    </section>
  );
}
