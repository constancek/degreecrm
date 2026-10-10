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
import { formatCents, lineTotalCents, marginPercent, optionTotals, parseDollars } from "@/lib/money";
import type { PriceCategory, Tier, Trade } from "@/generated/prisma/enums";
import { addToPriceBookAction, saveProposalAction } from "../actions";

type Line = {
  key: string;
  description: string;
  qty: number;
  unit: string;
  unitCents: number;
  isOptional: boolean;
  priceBookItemId: string | null;
};
type Option = { tier: Tier; title: string; summary: string; highlights: string[]; warrantyText: string; lineItems: Line[] };
type Content = {
  summary: string;
  recommendedTier: Tier | null;
  assumptions: string[];
  exclusions: string[];
  options: Option[];
};
type BookItem = { id: string; name: string; unit: string; priceCents: number; costCents: number | null; category: PriceCategory };

const TIER_LABEL: Record<Tier, string> = { good: "Good", better: "Better", best: "Best" };
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
            Recommended option
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
          {message?.error && <p className="text-sm text-red-700">{message.error}</p>}
          {message?.ok && <p className="text-sm text-green-700">{message.ok}</p>}
          <p className="ml-auto hidden text-xs text-gray-500 sm:block">Drag a line by its ⠿ handle to move it to another option.</p>
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
  const totals = optionTotals(o.lineItems, props.taxRateBps);
  const margin = marginPercent(
    o.lineItems.map((l) => ({ ...l, costCents: l.priceBookItemId ? (props.book.get(l.priceBookItemId)?.costCents ?? null) : null })),
  );
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
      <p className="text-right text-xs text-gray-500">
        {formatCents(totals.subtotalCents, { cents: true })} + {formatCents(totals.taxCents, { cents: true })} tax · deposit {depositPct}%
        {margin != null ? ` · margin ${margin}%` : ""}
      </p>

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

      <div className="mt-4 space-y-2">
        {o.lineItems.map((l, i) => (
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
        {o.lineItems.length === 0 && <p className="rounded border border-dashed p-3 text-center text-xs text-gray-500">No lines yet</p>}
      </div>

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
  const needsPrice = l.unitCents <= 0;
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
          <button className="cursor-grab px-1 text-gray-400 active:cursor-grabbing" aria-label="Drag to another option" {...listeners} {...attributes}>
            ⠿
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
          <button className="px-1 text-gray-400 hover:text-red-700" aria-label="Remove line" onClick={props.onRemove}>
            ✕
          </button>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 pl-6">
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
        <span className="text-gray-500">×</span>
        <span className="text-gray-500">$</span>
        <input
          className="input w-24 py-1 text-sm"
          inputMode="decimal"
          value={price}
          readOnly={ro}
          aria-label="Unit price"
          onChange={(e) => {
            setPrice(e.target.value);
            const cents = parseDollars(e.target.value);
            if (cents != null) props.onChange((x) => void (x.unitCents = cents));
          }}
        />
        <span className="ml-auto font-medium">{formatCents(lineTotalCents(l), { cents: true })}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-3 pl-6 text-xs text-gray-500">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={l.isOptional} disabled={ro} onChange={(e) => props.onChange((x) => void (x.isOptional = e.target.checked))} />
          Optional add-on
        </label>
        {props.fromBook ? (
          <span>
            Price book: {props.fromBook.name}
            {props.fromBook.priceCents !== l.unitCents ? ` (list ${formatCents(props.fromBook.priceCents, { cents: true })})` : ""}
          </span>
        ) : needsPrice ? (
          <span className="font-medium text-amber-800">Needs price</span>
        ) : (
          <span>Custom line</span>
        )}
        {!props.fromBook && !needsPrice && !ro && props.isOwner && !saved && (
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
        {saved && <span>{saved}</span>}
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
