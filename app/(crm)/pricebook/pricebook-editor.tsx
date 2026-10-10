"use client";

import Link from "next/link";
import { useActionState, useEffect, useMemo, useState } from "react";
import { TRADES, tradeLabel } from "@/lib/stages";
import { formatCents } from "@/lib/money";
import type { PriceCategory, Trade } from "@/generated/prisma/enums";
import { savePriceBookItemAction, setActiveAction } from "./actions";

type Item = {
  id: string;
  trade: Trade | null;
  category: PriceCategory;
  name: string;
  description: string;
  sku: string;
  unit: string;
  costCents: number | null;
  priceCents: number;
  active: boolean;
};

const CATEGORIES: PriceCategory[] = ["equipment", "material", "labor", "fee"];
const dollars = (c: number | null) => (c == null ? "" : (c / 100).toFixed(2));

export function PriceBookEditor({ items, canEdit, showInactive }: { items: Item[]; canEdit: boolean; showInactive: boolean }) {
  const [query, setQuery] = useState("");
  const [trade, setTrade] = useState<string>("");
  const [editing, setEditing] = useState<Item | "new" | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(
      (i) =>
        (!trade || (trade === "all" ? i.trade === null : i.trade === trade)) &&
        (!q || `${i.name} ${i.description} ${i.sku}`.toLowerCase().includes(q)),
    );
  }, [items, query, trade]);

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-2">
        <input className="input max-w-xs" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search price book" />
        <select className="input w-auto" value={trade} onChange={(e) => setTrade(e.target.value)} aria-label="Filter by trade">
          <option value="">All trades</option>
          {TRADES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
          <option value="all">Shared (every trade)</option>
        </select>
        <Link href={showInactive ? "/pricebook" : "/pricebook?inactive=1"} className="text-sm text-brand underline">
          {showInactive ? "Hide inactive" : "Show inactive"}
        </Link>
        {canEdit && (
          <button className="btn-primary ml-auto" onClick={() => setEditing("new")}>
            Add item
          </button>
        )}
      </div>

      {editing && canEdit && <ItemForm key={editing === "new" ? "new" : editing.id} item={editing === "new" ? null : editing} onDone={() => setEditing(null)} />}

      {items.length === 0 ? (
        <div className="card mt-4 p-8 text-center text-sm text-gray-600">
          Your price book is empty. Add equipment, materials, labor rates and fees{canEdit ? " with “Add item”" : ""}.
        </div>
      ) : (
        <div className="card mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-500">
              <tr>
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 font-medium">Trade</th>
                <th className="px-3 py-2 font-medium">Category</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
                <th className="px-3 py-2 text-right font-medium">Price</th>
                <th className="px-3 py-2 font-medium">Unit</th>
                {canEdit && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {filtered.map((i) => (
                <tr key={i.id} className={`border-t ${i.active ? "" : "text-gray-500"}`}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{i.name}</div>
                    {i.description && <div className="text-xs text-gray-500">{i.description}</div>}
                    {i.sku && <div className="text-xs text-gray-500">SKU {i.sku}</div>}
                  </td>
                  <td className="px-3 py-2">{i.trade ? tradeLabel(i.trade) : "All"}</td>
                  <td className="px-3 py-2 capitalize">{i.category}</td>
                  <td className="px-3 py-2 text-right">{i.costCents == null ? "—" : formatCents(i.costCents, { cents: true })}</td>
                  <td className="px-3 py-2 text-right font-medium">{formatCents(i.priceCents, { cents: true })}</td>
                  <td className="px-3 py-2">{i.unit}</td>
                  {canEdit && (
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button className="text-brand underline" onClick={() => setEditing(i)}>
                        Edit
                      </button>{" "}
                      <button className="ml-2 text-gray-500 underline" onClick={() => setActiveAction(i.id, !i.active)}>
                        {i.active ? "Deactivate" : "Activate"}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ItemForm({ item, onDone }: { item: Item | null; onDone: () => void }) {
  const [state, action, pending] = useActionState(savePriceBookItemAction, undefined);
  useEffect(() => {
    if (state?.savedId) onDone();
  }, [state, onDone]);

  return (
    <form action={action} className="card mt-4 grid gap-3 p-4 sm:grid-cols-6">
      <h2 className="font-semibold sm:col-span-6">{item ? "Edit item" : "New price book item"}</h2>
      {item && <input type="hidden" name="id" value={item.id} />}
      <div className="sm:col-span-3">
        <label className="label" htmlFor="pb-name">
          Name
        </label>
        <input id="pb-name" name="name" className="input" defaultValue={item?.name} required />
      </div>
      <div className="sm:col-span-3">
        <label className="label" htmlFor="pb-sku">
          SKU / model (optional)
        </label>
        <input id="pb-sku" name="sku" className="input" defaultValue={item?.sku} />
      </div>
      <div className="sm:col-span-6">
        <label className="label" htmlFor="pb-desc">
          Description (helps Claude pick the right item)
        </label>
        <input id="pb-desc" name="description" className="input" defaultValue={item?.description} />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="pb-trade">
          Trade
        </label>
        <select id="pb-trade" name="trade" className="input" defaultValue={item?.trade ?? ""}>
          <option value="">All trades</option>
          {TRADES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="pb-category">
          Category
        </label>
        <select id="pb-category" name="category" className="input capitalize" defaultValue={item?.category ?? "material"}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="pb-unit">
          Unit
        </label>
        <input id="pb-unit" name="unit" className="input" defaultValue={item?.unit ?? "ea"} placeholder="ea, hr, ft" />
      </div>
      <div className="sm:col-span-3">
        <label className="label" htmlFor="pb-cost">
          Your cost $ (optional, for margin)
        </label>
        <input id="pb-cost" name="cost" className="input" inputMode="decimal" defaultValue={dollars(item?.costCents ?? null)} />
      </div>
      <div className="sm:col-span-3">
        <label className="label" htmlFor="pb-price">
          Customer price $
        </label>
        <input id="pb-price" name="price" className="input" inputMode="decimal" defaultValue={dollars(item?.priceCents ?? null)} required />
      </div>
      <div className="flex items-center gap-3 sm:col-span-6">
        <button className="btn-primary" disabled={pending}>
          {pending ? "Saving…" : "Save item"}
        </button>
        <button type="button" className="btn-secondary" onClick={onDone}>
          Cancel
        </button>
        {state?.error && <p role="alert" className="text-sm text-red-700">{state.error}</p>}
      </div>
    </form>
  );
}
