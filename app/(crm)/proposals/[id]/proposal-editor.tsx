"use client";

import { useBoardSensors } from "@/lib/client/dnd-sensors";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState, useTransition } from "react";
import {
  DndContext,
  useDraggable,
  useDroppable,
  type DragEndEvent,
} from "@dnd-kit/core";
import { formatCents, lineTotalCents, packageTotals, parseDollars } from "@/lib/money";
import { TIER_LABELS as TIER_LABEL } from "@/lib/tiers";
import type { PriceCategory, Tier, Trade } from "@/generated/prisma/enums";
import { addToPriceBookAction, saveProposalAction } from "../actions";
import { Close, Grip, Plus } from "@/components/ui/icons";

type Line = {
  key: string;
  description: string;
  qty: number;
  unit: string;
  unitCents: number;
  isOptional: boolean;
  priceBookItemId: string | null;
};
type Option = { tier: Tier; title: string; summary: string; highlights: string[]; warrantyText: string; priceCents: number | null; lineItems: Line[] };
type Milestone = { key: string; label: string; percent: number };
type Content = {
  summary: string;
  recommendedTier: Tier | null;
  assumptions: string[];
  exclusions: string[];
  options: Option[];
  milestones: Milestone[];
};
type BookItem = { id: string; name: string; unit: string; priceCents: number; costCents: number | null; category: PriceCategory };

let keySeq = 0;
const newKey = () => `new-${Date.now()}-${keySeq++}`;
const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

export function ProposalEditor(props: {
  proposalId: string;
  editable: boolean;
  isOwner: boolean;
  trade: Trade;
  taxRateBps: number;
  deposit: { override: number | null; thresholdCents: number; below: number; above: number };
  priceBook: BookItem[];
  initial: Content;
}) {
  const router = useRouter();
  const [content, setContent] = useState<Content>(props.initial);
  const [depositOverride, setDepositOverride] = useState<string>(props.deposit.override?.toString() ?? "");
  const [dirty, setDirty] = useState(false);
  const [saving, startSave] = useTransition();
  const [message, setMessage] = useState<{ error?: string; ok?: string } | null>(null);
  const book = useMemo(() => new Map(props.priceBook.map((b) => [b.id, b])), [props.priceBook]);
  const sensors = useBoardSensors();
  const ro = !props.editable;
  const dndId = useId();

  function update(fn: (c: Content) => Content) {
    setContent((c) => fn(structuredClone(c)));
    setDirty(true);
    setMessage(null);
  }
  const updateOption = (tier: Tier, fn: (o: Option) => void) =>
    update((c) => {
      fn(c.options.find((o) => o.tier === tier)!);
      return c;
    });

  function onDragEnd(e: DragEndEvent) {
    const to = e.over?.id as Tier | undefined;
    const [fromTier, key] = String(e.active.id).split(":") as [Tier, string];
    if (!to || to === fromTier) return;
    update((c) => {
      const from = c.options.find((o) => o.tier === fromTier)!;
      const idx = from.lineItems.findIndex((l) => l.key === key);
      if (idx < 0) return c;
      const [line] = from.lineItems.splice(idx, 1);
      c.options.find((o) => o.tier === to)!.lineItems.push(line!);
      return c;
    });
  }

  function save() {
    const override = depositOverride.trim() === "" ? null : Number(depositOverride);
    startSave(async () => {
      const res = await saveProposalAction(props.proposalId, {
        ...content,
        depositPercent: override,
        milestones: content.milestones.map((m) => ({ label: m.label, percent: m.percent })),
        options: content.options.map((o) => ({
          ...o,
          lineItems: o.lineItems.map((l) => ({
          description: l.description,
          qty: l.qty,
          unit: l.unit,
          unitCents: l.unitCents,
          isOptional: l.isOptional,
          priceBookItemId: l.priceBookItemId,
        })),
        })),
      });
      if (res.error) setMessage({ error: res.error });
      else {
        setDirty(false);
        setMessage({ ok: "Saved" });
        router.refresh();
      }
    });
  }

  return (
    <div className="mt-4 space-y-4">
      <section className="card grid gap-3 p-4 lg:grid-cols-2">
        <div className="lg:col-span-2">
          <label className="label" htmlFor="summary">
            Summary for the customer
          </label>
          <textarea
            id="summary"
            className="input min-h-24"
            value={content.summary}
            readOnly={ro}
            onChange={(e) => update((c) => ({ ...c, summary: e.target.value }))}
          />
        </div>
        <ListField label="Assumptions (one per line)" value={content.assumptions} readOnly={ro} onChange={(v) => update((c) => ({ ...c, assumptions: v }))} />
        <ListField label="Not included (one per line)" value={content.exclusions} readOnly={ro} onChange={(v) => update((c) => ({ ...c, exclusions: v }))} />
        <div>
          <label className="label" htmlFor="recommended">
            Recommended package
          </label>
          <select
            id="recommended"
            className="input"
            disabled={ro}
            value={content.recommendedTier ?? ""}
            onChange={(e) => update((c) => ({ ...c, recommendedTier: (e.target.value || null) as Tier | null }))}
          >
            <option value="">None</option>
            {(["good", "better", "best"] as Tier[]).map((t) => (
              <option key={t} value={t}>
                {TIER_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="deposit">
            Deposit % (blank = {props.deposit.below}% under {formatCents(props.deposit.thresholdCents)}, else {props.deposit.above}%)
          </label>
          <input
            id="deposit"
            className="input"
            inputMode="numeric"
            readOnly={ro}
            value={depositOverride}
            onChange={(e) => {
              setDepositOverride(e.target.value.replace(/\D/g, "").slice(0, 3));
              setDirty(true);
            }}
          />
        </div>
        <ScheduleEditor
          milestones={content.milestones}
          depositOverride={depositOverride}
          readOnly={ro}
          onChange={(milestones) => update((c) => ({ ...c, milestones }))}
        />
      </section>

      <DndContext id={dndId} sensors={sensors} onDragEnd={onDragEnd}>
        <div className="grid gap-4 2xl:grid-cols-3">
          {content.options.map((o) => (
            <OptionEditor
              key={o.tier}
              option={o}
              readOnly={ro}
              recommended={content.recommendedTier === o.tier}
              taxRateBps={props.taxRateBps}
              deposit={props.deposit}
              depositOverride={depositOverride}
              book={book}
              priceBook={props.priceBook}
              trade={props.trade}
              isOwner={props.isOwner}
              onChange={(fn) => updateOption(o.tier, fn)}
            />
          ))}
        </div>
      </DndContext>

      {!ro && (
        <div className="sticky bottom-0 z-10 -mx-4 flex items-center gap-3 border-t bg-white/95 px-4 py-3 backdrop-blur">
          <button className="btn-primary" onClick={save} disabled={saving || !dirty}>
            {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </button>
          {message?.error && <p role="alert" className="text-sm text-red-700">{message.error}</p>}
          {message?.ok && <p role="status" className="text-sm text-green-700">{message.ok}</p>}
          <p className="ml-auto hidden text-xs text-gray-500 sm:block">Drag a line by its handle to move it to another package.</p>
        </div>
      )}
    </div>
  );
}

function ListField({ label, value, readOnly, onChange }: { label: string; value: string[]; readOnly: boolean; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join("\n"));
  const id = label.replace(/\W+/g, "-").toLowerCase();
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="input min-h-24"
        value={text}
        readOnly={readOnly}
        onChange={(e) => {
          setText(e.target.value);
          onChange(lines(e.target.value));
        }}
      />
    </div>
  );
}

function OptionEditor(props: {
  option: Option;
  readOnly: boolean;
  recommended: boolean;
  taxRateBps: number;
  deposit: { thresholdCents: number; below: number; above: number };
  depositOverride: string;
  book: Map<string, BookItem>;
  priceBook: BookItem[];
  trade: Trade;
  isOwner: boolean;
  onChange: (fn: (o: Option) => void) => void;
}) {
  const { option: o, readOnly: ro, onChange } = props;
  const { setNodeRef, isOver } = useDroppable({ id: o.tier });
  const totals = packageTotals(o.priceCents, props.taxRateBps);
  const [price, setPrice] = useState(o.priceCents != null ? (o.priceCents / 100).toFixed(2) : "");
  const priceId = useId();
  const included = o.lineItems.map((l, i) => ({ l, i })).filter(({ l }) => !l.isOptional);
  const addOns = o.lineItems.map((l, i) => ({ l, i })).filter(({ l }) => l.isOptional);
  const depositPct =
    props.depositOverride.trim() !== ""
      ? Number(props.depositOverride)
      : totals.totalCents < props.deposit.thresholdCents
        ? props.deposit.below
        : props.deposit.above;
  const [highlights, setHighlights] = useState(o.highlights.join("\n"));

  return (
    <section
      ref={setNodeRef}
      data-tier={o.tier}
      className={`card min-w-0 p-4 ${isOver ? "ring-2 ring-brand" : ""} ${props.recommended ? "border-accent" : ""}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold tracking-wide text-gray-500 uppercase">{TIER_LABEL[o.tier]}</span>
        {props.recommended && <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-white">Recommended</span>}
        <span className="ml-auto text-lg font-bold" data-testid={`total-${o.tier}`}>
          {formatCents(totals.totalCents, { cents: true })}
        </span>
      </div>
      <div className={`mt-2 rounded-md p-3 ${o.priceCents ? "bg-gray-50" : "bg-amber-50 ring-1 ring-amber-300"}`}>
        <label className="label" htmlFor={priceId}>
          Package price (before tax)
        </label>
        <div className="flex items-center gap-2">
          <span className="text-gray-600">$</span>
          <input
            id={priceId}
            className="input text-lg font-semibold tabular-nums"
            inputMode="decimal"
            placeholder="0.00"
            value={price}
            readOnly={ro}
            aria-label={`${TIER_LABEL[o.tier]} package price`}
            onChange={(e) => {
              setPrice(e.target.value);
              const cents = e.target.value.trim() === "" ? null : parseDollars(e.target.value);
              if (cents != null || e.target.value.trim() === "") onChange((x) => void (x.priceCents = cents));
            }}
          />
        </div>
        <p className="mt-1 text-xs text-gray-600">
          {o.priceCents
            ? `${formatCents(totals.subtotalCents, { cents: true })} + ${formatCents(totals.taxCents, { cents: true })} tax · deposit ${depositPct}%`
            : "Enter the price the customer pays for this package."}
        </p>
      </div>

      <div className="mt-3 space-y-2">
        <input
          className="input font-medium"
          value={o.title}
          readOnly={ro}
          aria-label={`${TIER_LABEL[o.tier]} title`}
          onChange={(e) => onChange((x) => void (x.title = e.target.value))}
        />
        <textarea
          className="input min-h-16 text-sm"
          value={o.summary}
          readOnly={ro}
          placeholder="Short description"
          aria-label={`${TIER_LABEL[o.tier]} summary`}
          onChange={(e) => onChange((x) => void (x.summary = e.target.value))}
        />
        <textarea
          className="input min-h-24 text-sm"
          value={highlights}
          readOnly={ro}
          placeholder="Highlights, one per line (4–6)"
          aria-label={`${TIER_LABEL[o.tier]} highlights`}
          onChange={(e) => {
            setHighlights(e.target.value);
            onChange((x) => void (x.highlights = lines(e.target.value)));
          }}
        />
        <input
          className="input text-sm"
          value={o.warrantyText}
          readOnly={ro}
          placeholder="Warranty, e.g. 2-year labor"
          aria-label={`${TIER_LABEL[o.tier]} warranty`}
          onChange={(e) => onChange((x) => void (x.warrantyText = e.target.value))}
        />
      </div>

      <h3 className="mt-4 text-sm font-semibold text-gray-800">What&apos;s included</h3>
      <p className="text-xs text-gray-600">The customer sees this list without prices.</p>
      <div className="mt-2 space-y-2">
        {included.map(({ l, i }) => (
          <LineEditor
            key={l.key}
            tier={o.tier}
            line={l}
            readOnly={ro}
            fromBook={l.priceBookItemId ? props.book.get(l.priceBookItemId) : undefined}
            trade={props.trade}
            isOwner={props.isOwner}
            onChange={(fn) => onChange((x) => fn(x.lineItems[i]!))}
            onRemove={() => onChange((x) => void x.lineItems.splice(i, 1))}
          />
        ))}
        {included.length === 0 && <p className="rounded border border-dashed p-3 text-center text-xs text-gray-600">No scope lines yet</p>}
      </div>
      {addOns.length > 0 && (
        <>
          <h3 className="mt-4 text-sm font-semibold text-gray-800">Optional add-ons</h3>
          <p className="text-xs text-gray-600">Priced separately, not in the package total.</p>
          <div className="mt-2 space-y-2">
            {addOns.map(({ l, i }) => (
              <LineEditor
                key={l.key}
                tier={o.tier}
                line={l}
                readOnly={ro}
                fromBook={l.priceBookItemId ? props.book.get(l.priceBookItemId) : undefined}
                trade={props.trade}
                isOwner={props.isOwner}
                onChange={(fn) => onChange((x) => fn(x.lineItems[i]!))}
                onRemove={() => onChange((x) => void x.lineItems.splice(i, 1))}
              />
            ))}
          </div>
        </>
      )}

      {!ro && <AddLine priceBook={props.priceBook} onAdd={(line) => onChange((x) => void x.lineItems.push(line))} />}
    </section>
  );
}

function LineEditor(props: {
  tier: Tier;
  line: Line;
  readOnly: boolean;
  fromBook?: BookItem;
  trade: Trade;
  isOwner: boolean;
  onChange: (fn: (l: Line) => void) => void;
  onRemove: () => void;
}) {
  const { line: l, readOnly: ro } = props;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `${props.tier}:${l.key}`, disabled: ro });
  const [price, setPrice] = useState((l.unitCents / 100).toFixed(2));
  const [saved, setSaved] = useState<string | null>(null);
  const needsPrice = l.isOptional && l.unitCents <= 0;
  const style = transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-line={l.description}
      className={`rounded-md border p-2 text-sm ${needsPrice ? "border-amber-400 bg-amber-50" : "border-gray-200 bg-white"} ${isDragging ? "z-20 shadow-lg" : ""}`}
    >
      <div className="flex items-start gap-2">
        {!ro && (
          <button className="icon-btn cursor-grab touch-none active:cursor-grabbing" aria-label="Drag to another option" {...listeners} {...attributes}>
            <Grip />
          </button>
        )}
        <input
          className="input flex-1 py-1 text-sm"
          value={l.description}
          readOnly={ro}
          aria-label="Line description"
          onChange={(e) => props.onChange((x) => void (x.description = e.target.value))}
        />
        {!ro && (
          <button className="icon-btn hover:text-red-700" aria-label="Remove line" onClick={props.onRemove}>
            <Close />
          </button>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 pl-10">
        <input
          className="input w-16 py-1 text-sm"
          inputMode="decimal"
          value={l.qty}
          readOnly={ro}
          aria-label="Quantity"
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n >= 0) props.onChange((x) => void (x.qty = n));
          }}
        />
        <input
          className="input w-14 py-1 text-sm"
          value={l.unit}
          readOnly={ro}
          aria-label="Unit"
          onChange={(e) => props.onChange((x) => void (x.unit = e.target.value))}
        />
        {l.isOptional && (
          <>
            <span className="text-gray-600">× $</span>
            <input
              className="input w-24 py-1 text-sm"
              inputMode="decimal"
              value={price}
              readOnly={ro}
              aria-label="Add-on unit price"
              onChange={(e) => {
                setPrice(e.target.value);
                const cents = parseDollars(e.target.value);
                if (cents != null) props.onChange((x) => void (x.unitCents = cents));
              }}
            />
            <span className="ml-auto font-medium tabular-nums">{formatCents(lineTotalCents(l), { cents: true })}</span>
          </>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-3 pl-10 text-xs text-gray-600">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={l.isOptional}
            disabled={ro}
            onChange={(e) => {
              const on = e.target.checked;
              props.onChange((x) => {
                x.isOptional = on;
                // An add-on starts at its price book price; a scope line carries no price.
                x.unitCents = on ? (props.fromBook?.priceCents ?? 0) : 0;
              });
              setPrice(on ? ((props.fromBook?.priceCents ?? 0) / 100).toFixed(2) : "0.00");
            }}
          />
          Optional add-on
        </label>
        {props.fromBook ? (
          <span>
            Price book: {props.fromBook.name}
            {l.isOptional && props.fromBook.priceCents !== l.unitCents ? ` (list ${formatCents(props.fromBook.priceCents, { cents: true })})` : ""}
          </span>
        ) : needsPrice ? (
          <span className="font-medium text-amber-800">Needs price</span>
        ) : (
          <span>Custom line</span>
        )}
        {l.isOptional && !props.fromBook && !needsPrice && !ro && props.isOwner && !saved && (
          <button
            className="text-brand underline"
            onClick={async () => {
              const res = await addToPriceBookAction({ trade: props.trade, name: l.description, unit: l.unit, priceCents: l.unitCents });
              if (res.id) {
                props.onChange((x) => void (x.priceBookItemId = res.id!));
                setSaved("Added to price book");
              } else setSaved(res.error ?? "Couldn't add");
            }}
          >
            Add to price book
          </button>
        )}
        {saved && <span role="status">{saved}</span>}
      </div>
    </div>
  );
}

function AddLine({ priceBook, onAdd }: { priceBook: BookItem[]; onAdd: (l: Line) => void }) {
  const [query, setQuery] = useState("");
  const matches = query.trim()
    ? priceBook.filter((b) => b.name.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 8)
    : [];
  return (
    <div className="mt-3">
      <input
        className="input text-sm"
        placeholder="Add a line: search the price book or type a custom item"
        value={query}
        aria-label="Add line"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && query.trim()) {
            e.preventDefault();
            const m = matches[0];
            onAdd(
              m
                ? { key: newKey(), description: m.name, qty: 1, unit: m.unit, unitCents: m.priceCents, isOptional: false, priceBookItemId: m.id }
                : { key: newKey(), description: query.trim(), qty: 1, unit: "ea", unitCents: 0, isOptional: false, priceBookItemId: null },
            );
            setQuery("");
          }
        }}
      />
      {query.trim() && (
        <ul className="mt-1 overflow-hidden rounded-md border bg-white text-sm shadow">
          {matches.map((m) => (
            <li key={m.id}>
              <button
                className="flex w-full justify-between px-3 py-1.5 text-left hover:bg-gray-50"
                onClick={() => {
                  onAdd({ key: newKey(), description: m.name, qty: 1, unit: m.unit, unitCents: m.priceCents, isOptional: false, priceBookItemId: m.id });
                  setQuery("");
                }}
              >
                <span>{m.name}</span>
                <span className="text-gray-500">
                  {formatCents(m.priceCents, { cents: true })}/{m.unit}
                </span>
              </button>
            </li>
          ))}
          <li>
            <button
              className="w-full px-3 py-1.5 text-left text-brand hover:bg-gray-50"
              onClick={() => {
                onAdd({ key: newKey(), description: query.trim(), qty: 1, unit: "ea", unitCents: 0, isOptional: false, priceBookItemId: null });
                setQuery("");
              }}
            >
              + Custom line &ldquo;{query.trim()}&rdquo;
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

/** Payment schedule after the deposit. Deposit % + milestones must add up to 100%. */
function ScheduleEditor(props: { milestones: Milestone[]; depositOverride: string; readOnly: boolean; onChange: (m: Milestone[]) => void }) {
  const { milestones: ms, readOnly: ro } = props;
  const deposit = props.depositOverride.trim() === "" ? null : Number(props.depositOverride);
  const sum = (deposit ?? 0) + ms.reduce((s, m) => s + m.percent, 0);
  const set = (i: number, patch: Partial<Milestone>) => props.onChange(ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  return (
    <div className="lg:col-span-2">
      <h3 className="text-sm font-medium text-gray-700">Payment schedule</h3>
      {ms.length === 0 ? (
        <p className="mt-1 text-sm text-gray-600">Deposit on approval, balance when the work is complete.</p>
      ) : (
        <table className="mt-1 w-full max-w-lg text-sm">
          <tbody>
            <tr>
              <td className="py-1 pr-2 text-gray-700">Deposit on approval</td>
              <td className="w-24 py-1 text-right tabular-nums">{deposit == null ? "set above" : `${deposit}%`}</td>
              <td className="w-12" />
            </tr>
            {ms.map((m, i) => (
              <tr key={m.key}>
                <td className="py-1 pr-2">
                  <input className="input py-1 text-sm" value={m.label} readOnly={ro} aria-label={`Milestone ${i + 1} name`} placeholder="e.g. Rough-in complete" onChange={(e) => set(i, { label: e.target.value })} />
                </td>
                <td className="py-1">
                  <div className="flex items-center gap-1">
                    <input
                      className="input w-16 py-1 text-right text-sm tabular-nums"
                      inputMode="numeric"
                      value={m.percent || ""}
                      readOnly={ro}
                      aria-label={`Milestone ${i + 1} percent`}
                      onChange={(e) => set(i, { percent: Number(e.target.value.replace(/\D/g, "").slice(0, 3)) || 0 })}
                    />
                    %
                  </div>
                </td>
                <td className="text-right">
                  {!ro && (
                    <button className="icon-btn hover:text-red-700" aria-label={`Remove milestone ${i + 1}`} onClick={() => props.onChange(ms.filter((_, j) => j !== i))}>
                      <Close />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            <tr className="border-t">
              <td className="pt-1 text-gray-700">Total</td>
              <td className={`pt-1 text-right font-medium tabular-nums ${sum === 100 && deposit != null ? "text-green-800" : "text-amber-800"}`}>{sum}%</td>
              <td />
            </tr>
          </tbody>
        </table>
      )}
      {ms.length > 0 && (deposit == null || sum !== 100) && (
        <p className="mt-1 text-xs text-amber-800">{deposit == null ? "Set the deposit % above. " : ""}Deposit and milestones need to add up to 100%. The last milestone is billed as the final invoice.</p>
      )}
      {!ro && (
        <button
          className="btn-secondary mt-2 py-1.5"
          onClick={() =>
            props.onChange([...ms, { key: newKey(), label: ms.length ? "" : "Rough-in complete", percent: ms.length ? 0 : Math.max(0, 100 - (deposit ?? 0)) }])
          }
        >
          <Plus /> Add milestone
        </button>
      )}
    </div>
  );
}

