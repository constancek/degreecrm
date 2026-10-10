// Google Geocoding API (server key GOOGLE_MAPS_API_KEY, not the browser key).
// https://developers.google.com/maps/documentation/geocoding/requests-geocoding

export type GeoPoint = { lat: number; lng: number };
export type GeoResult = GeoPoint & { county: string | null; state: string | null };

export interface GeocodingClient {
  geocode(address: string): Promise<GeoResult | null>;
}

export function createGeocodingClient(apiKey: string): GeocodingClient {
  return {
    async geocode(address) {
      const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
      url.searchParams.set("address", address);
      url.searchParams.set("region", "us");
      url.searchParams.set("key", apiKey);
      const res = await fetch(url);
      const data = (await res.json()) as {
        status: string;
        error_message?: string;
        results?: {
          geometry: { location: GeoPoint };
          address_components: { long_name: string; short_name: string; types: string[] }[];
        }[];
      };
      if (data.status === "ZERO_RESULTS") return null;
      if (data.status !== "OK") throw new Error(`Geocoding failed: ${data.status} ${data.error_message ?? ""}`.trim());
      const r = data.results?.[0];
      if (!r) return null;
      const comp = (type: string) => r.address_components.find((c) => c.types.includes(type));
      return {
        ...r.geometry.location,
        county: comp("administrative_area_level_2")?.long_name ?? null,
        state: comp("administrative_area_level_1")?.short_name ?? null,
      };
    },
  };
}

export function createMockGeocodingClient(
  point: GeoResult | null = { lat: 39.1031, lng: -84.512, county: "Hamilton County", state: "OH" },
) {
  const calls: string[] = [];
  return {
    calls,
    async geocode(address: string) {
      calls.push(address);
      return point;
    },
  } satisfies GeocodingClient & { calls: string[] };
}

let override: GeocodingClient | null = null;

/** Swap the client in tests. */
export function setGeocodingClient(client: GeocodingClient | null) {
  override = client;
}

/** Null when no server key is configured. */
export function getGeocodingClient(): GeocodingClient | null {
  if (override) return override;
  const key = process.env.GOOGLE_MAPS_API_KEY;
  return key ? createGeocodingClient(key) : null;
}

// ---- Drive times -------------------------------------------------------------------

export type LatLng = { lat: number; lng: number };

/** Straight-line distance × 1.35 road factor at ~30 mph average city/suburban speed, in minutes. */
export function estimateDriveMinutes(a: LatLng, b: LatLng): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  const miles = 2 * R * Math.asin(Math.sqrt(h)) * 1.35;
  if (miles < 0.1) return 0; // same address
  return Math.round((miles / 30) * 60) + 5;
}

/**
 * Drive minutes from each origin to one destination via the Routes API (computeRouteMatrix).
 * Falls back to the straight-line estimate when the API isn't enabled or fails.
 */
export async function driveMinutesTo(origins: LatLng[], destination: LatLng): Promise<number[]> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key || !origins.length || process.env.MOCK_INTEGRATIONS === "1") return origins.map((o) => estimateDriveMinutes(o, destination));
  try {
    const res = await fetch("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "originIndex,duration,condition" },
      body: JSON.stringify({
        origins: origins.map((o) => ({ waypoint: { location: { latLng: { latitude: o.lat, longitude: o.lng } } } })),
        destinations: [{ waypoint: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } } }],
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_UNAWARE",
      }),
    });
    if (!res.ok) throw new Error(`Routes API ${res.status}`);
    const rows = (await res.json()) as { originIndex?: number; duration?: string; condition?: string }[];
    const out = origins.map((o) => estimateDriveMinutes(o, destination));
    for (const r of rows) {
      if (r.condition === "ROUTE_EXISTS" && r.duration) out[r.originIndex ?? 0] = Math.round(parseInt(r.duration, 10) / 60);
    }
    return out;
  } catch (err) {
    console.warn("[routes] falling back to estimates:", (err as Error).message);
    return origins.map((o) => estimateDriveMinutes(o, destination));
  }
}
