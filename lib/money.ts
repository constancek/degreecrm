// Money is integer cents everywhere. Rates are basis points (780 = 7.80%).

export function formatCents(cents: number, opts: { cents?: boolean } = {}): string {
  const showCents = opts.cents ?? cents % 100 !== 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  }).format(cents / 100);
}

/** "1,234.5" / "$1234.50" → 123450. Returns null for anything that isn't a non-negative amount. */
export function parseDollars(input: string | null | undefined): number | null {
  const s = (input ?? "").replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

export function formatRate(bps: number): string {
  return `${(bps / 100).toFixed(bps % 10 === 0 ? (bps % 100 === 0 ? 0 : 1) : 2)}%`;
}

/** "7.8" / "7.80%" → 780. */
export function parseRate(input: string | null | undefined): number | null {
  const s = (input ?? "").replace(/[%\s]/g, "");
  if (!/^\d{1,2}(\.\d{0,3})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

export function lineTotalCents(item: { qty: number; unitCents: number }): number {
  return Math.round(item.qty * item.unitCents);
}

/** Totals for a package: its lump-sum price plus sales tax. Optional add-ons are priced on their own lines. */
export function packageTotals(priceCents: number | null, taxRateBps: number) {
  const subtotalCents = Math.max(0, priceCents ?? 0);
  const taxCents = Math.round((subtotalCents * taxRateBps) / 10_000);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

/** Even split of the payment schedule: amount for `percent` of a total, in cents. */
export function percentOf(totalCents: number, percent: number) {
  return Math.round((totalCents * percent) / 100);
}

/** Gross margin % of price over cost, or null when any line has no cost. */
export function marginPercent(items: { qty: number; unitCents: number; costCents: number | null; isOptional: boolean }[]) {
  const included = items.filter((i) => !i.isOptional);
  if (!included.length || included.some((i) => i.costCents == null)) return null;
  const price = included.reduce((s, i) => s + lineTotalCents(i), 0);
  const cost = included.reduce((s, i) => s + Math.round(i.qty * (i.costCents ?? 0)), 0);
  return price > 0 ? Math.round(((price - cost) / price) * 1000) / 10 : null;
}
