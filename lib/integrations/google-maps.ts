// Google Geocoding API (server key GOOGLE_MAPS_API_KEY, not the browser key).
// https://developers.google.com/maps/documentation/geocoding/requests-geocoding

export type GeoPoint = { lat: number; lng: number };

export interface GeocodingClient {
  geocode(address: string): Promise<GeoPoint | null>;
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
        results?: { geometry: { location: GeoPoint } }[];
      };
      if (data.status === "ZERO_RESULTS") return null;
      if (data.status !== "OK") throw new Error(`Geocoding failed: ${data.status} ${data.error_message ?? ""}`.trim());
      return data.results?.[0]?.geometry.location ?? null;
    },
  };
}

export function createMockGeocodingClient(point: GeoPoint | null = { lat: 39.1031, lng: -84.512 }) {
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
