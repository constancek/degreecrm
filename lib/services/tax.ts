import { db } from "@/lib/db";
import { formatRate } from "@/lib/money";
import { ForbiddenError, ValidationError, isOwner, type Actor } from "./actor";
import { geocodeProperty } from "./geocode";

/** "Hamilton County" / "hamilton" → "Hamilton". Counties are stored without the word "County". */
export function normalizeCounty(input: string | null | undefined): string {
  return (input ?? "")
    .replace(/\s+county$/i, "")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function listTaxRates() {
  return db.taxRate.findMany({ orderBy: [{ state: "asc" }, { county: "asc" }] });
}

export type TaxResolution = { rateBps: number; label: string } | null;

/** Rate for a property: county row first, then the state's statewide row. Geocodes the property if needed. */
export async function taxForProperty(propertyId: string | null): Promise<TaxResolution> {
  if (!propertyId) return null;
  let property = await db.property.findUnique({ where: { id: propertyId } });
  if (!property) return null;
  if (!property.county) {
    await geocodeProperty(propertyId, { force: true }).catch((e) => console.error("[tax geocode]", e));
    property = await db.property.findUnique({ where: { id: propertyId } });
  }
  const state = (property?.state ?? "").toUpperCase();
  const county = normalizeCounty(property?.county);
  if (!state) return null;

  const rows = await db.taxRate.findMany({ where: { state, county: { in: county ? [county, ""] : [""] } } });
  const exact = rows.find((r) => r.county === county && county);
  const statewide = rows.find((r) => r.county === "");
  const row = exact ?? statewide;
  if (!row) return null;
  return {
    rateBps: row.rateBps,
    label: exact ? `${county} County, ${state} (${formatRate(row.rateBps)})` : `${state} (${formatRate(row.rateBps)})`,
  };
}

export async function saveTaxRates(actor: Actor, rows: { state: string; county: string; rateBps: number }[]) {
  if (!isOwner(actor)) throw new ForbiddenError("Only the owner can change tax rates");
  const clean = rows.map((r) => ({ state: r.state.trim().toUpperCase(), county: normalizeCounty(r.county), rateBps: r.rateBps }));
  for (const r of clean) {
    if (!/^[A-Z]{2}$/.test(r.state)) throw new ValidationError(`"${r.state}" isn't a two-letter state`);
    if (!Number.isInteger(r.rateBps) || r.rateBps < 0 || r.rateBps > 2000) throw new ValidationError("Rates must be between 0% and 20%");
  }
  const keys = new Set(clean.map((r) => `${r.state}|${r.county}`));
  if (keys.size !== clean.length) throw new ValidationError("Each state + county can only appear once");
  await db.$transaction([db.taxRate.deleteMany(), db.taxRate.createMany({ data: clean })]);
}

/** Cincinnati-area defaults (Ohio Dept. of Taxation rates for Q4 2026). Editable in Settings. */
export const DEFAULT_TAX_RATES = [
  { state: "OH", county: "Hamilton", rateBps: 780 },
  { state: "OH", county: "Butler", rateBps: 650 },
  { state: "OH", county: "Clermont", rateBps: 675 },
  { state: "OH", county: "Warren", rateBps: 725 },
  { state: "OH", county: "Brown", rateBps: 700 },
  { state: "OH", county: "Clinton", rateBps: 725 },
  { state: "OH", county: "Highland", rateBps: 725 },
  { state: "OH", county: "Montgomery", rateBps: 750 },
  { state: "OH", county: "Greene", rateBps: 675 },
  { state: "OH", county: "Preble", rateBps: 725 },
  { state: "OH", county: "Adams", rateBps: 725 },
  { state: "OH", county: "", rateBps: 575 },
  { state: "KY", county: "", rateBps: 600 },
  { state: "IN", county: "", rateBps: 700 },
];
