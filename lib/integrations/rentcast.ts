// RentCast property records + value estimate (RENTCAST_API_KEY). Two calls per property; the service caches
// the result on Property.intel so a repeat customer costs nothing.
// https://developers.rentcast.io/reference/property-records · https://developers.rentcast.io/reference/value-estimate

import { mockIntegrations } from "@/lib/env";

/** What we keep about a house. Every field is optional: public records are patchy. */
export type PropertyFacts = {
  propertyType?: string | null;
  yearBuilt?: number | null;
  squareFootage?: number | null;
  lotSize?: number | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
  floorCount?: number | null;
  heatingType?: string | null;
  coolingType?: string | null;
  hasPool?: boolean | null;
  hasFireplace?: boolean | null;
  lastSaleDate?: string | null;
  lastSalePrice?: number | null;
  ownerNames?: string[];
  ownerOccupied?: boolean | null;
  /** Latest county assessment (dollars). */
  assessedValue?: number | null;
  assessedYear?: number | null;
  /** RentCast automated value estimate (dollars). */
  valueEstimate?: number | null;
  valueLow?: number | null;
  valueHigh?: number | null;
};

export interface PropertyDataClient {
  /** Null when RentCast has no record for the address. */
  lookup(address: string): Promise<PropertyFacts | null>;
}

type RecordResponse = {
  propertyType?: string;
  yearBuilt?: number;
  squareFootage?: number;
  lotSize?: number;
  bedrooms?: number;
  bathrooms?: number;
  lastSaleDate?: string;
  lastSalePrice?: number;
  ownerOccupied?: boolean;
  owner?: { names?: string[] };
  features?: {
    floorCount?: number;
    heatingType?: string;
    heating?: boolean;
    coolingType?: string;
    cooling?: boolean;
    pool?: boolean;
    fireplace?: boolean;
  };
  taxAssessments?: Record<string, { year?: number; value?: number }>;
};

export function createPropertyDataClient(apiKey: string): PropertyDataClient {
  async function get<T>(path: string, address: string): Promise<T | null> {
    const url = new URL(`https://api.rentcast.io/v1/${path}`);
    url.searchParams.set("address", address);
    const res = await fetch(url, {
      headers: { "X-Api-Key": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`RentCast ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  return {
    async lookup(address) {
      const records = await get<RecordResponse[] | RecordResponse>("properties", address);
      const r = Array.isArray(records) ? records[0] : records;
      if (!r) return null;
      // The value estimate is a nice-to-have; a failure there keeps the record.
      const avm = await get<{
        price?: number;
        priceRangeLow?: number;
        priceRangeHigh?: number;
      }>("avm/value", address).catch((e) => {
        console.warn("[rentcast] value estimate failed:", (e as Error).message);
        return null;
      });
      const latestTax = Object.values(r.taxAssessments ?? {}).sort((a, b) => (b.year ?? 0) - (a.year ?? 0))[0];
      const f = r.features ?? {};
      return {
        propertyType: r.propertyType ?? null,
        yearBuilt: r.yearBuilt ?? null,
        squareFootage: r.squareFootage ?? null,
        lotSize: r.lotSize ?? null,
        bedrooms: r.bedrooms ?? null,
        bathrooms: r.bathrooms ?? null,
        floorCount: f.floorCount ?? null,
        heatingType: f.heatingType ?? (f.heating ? "Yes" : null),
        coolingType: f.coolingType ?? (f.cooling ? "Yes" : null),
        hasPool: f.pool ?? null,
        hasFireplace: f.fireplace ?? null,
        lastSaleDate: r.lastSaleDate ?? null,
        lastSalePrice: r.lastSalePrice ?? null,
        ownerNames: r.owner?.names ?? [],
        ownerOccupied: r.ownerOccupied ?? null,
        assessedValue: latestTax?.value ?? null,
        assessedYear: latestTax?.year ?? null,
        valueEstimate: avm?.price ?? null,
        valueLow: avm?.priceRangeLow ?? null,
        valueHigh: avm?.priceRangeHigh ?? null,
      };
    },
  };
}

export const SAMPLE_FACTS: PropertyFacts = {
  propertyType: "Single Family",
  yearBuilt: 1998,
  squareFootage: 2450,
  lotSize: 10454,
  bedrooms: 4,
  bathrooms: 2.5,
  floorCount: 2,
  heatingType: "Forced Air",
  coolingType: "Central",
  hasPool: false,
  hasFireplace: true,
  lastSaleDate: "2025-06-12T00:00:00.000Z",
  lastSalePrice: 412000,
  ownerNames: ["Sample Owner"],
  ownerOccupied: true,
  assessedValue: 131000,
  assessedYear: 2025,
  valueEstimate: 438000,
  valueLow: 405000,
  valueHigh: 471000,
};

export function createMockPropertyDataClient(facts: PropertyFacts | null = SAMPLE_FACTS) {
  const calls: string[] = [];
  return {
    calls,
    async lookup(address: string) {
      calls.push(address);
      return facts;
    },
  } satisfies PropertyDataClient & { calls: string[] };
}

let override: PropertyDataClient | null = null;

/** Swap the client in tests. */
export function setPropertyDataClient(client: PropertyDataClient | null) {
  override = client;
}

/** Null when no key is configured (the card then shows only our own history). */
export function getPropertyDataClient(): PropertyDataClient | null {
  if (override) return override;
  if (mockIntegrations()) return createMockPropertyDataClient();
  const key = process.env.RENTCAST_API_KEY;
  return key ? createPropertyDataClient(key) : null;
}
