import { db } from "@/lib/db";
import { getGeocodingClient } from "@/lib/integrations/google-maps";

/**
 * Fill in lat/lng and county for a property. Properties are geocoded once; `force` re-runs it when the
 * county is still missing (e.g. coordinates came from autocomplete without a county).
 */
export async function geocodeProperty(propertyId: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const client = getGeocodingClient();
  if (!client) return false;
  const p = await db.property.findUnique({ where: { id: propertyId } });
  if (!p) return false;
  if (p.lat != null && p.county) return false; // fully geocoded
  if (p.lat != null && !opts.force) return false;
  const address = [p.street, p.unit, p.city, p.state, p.zip].filter(Boolean).join(", ");
  const geo = await client.geocode(address);
  if (!geo) return false;
  await db.property.update({
    where: { id: propertyId },
    data: {
      lat: p.lat ?? geo.lat,
      lng: p.lng ?? geo.lng,
      county: p.county ?? geo.county,
      state: geo.state ?? p.state,
    },
  });
  return true;
}

/** Geocode after the response is sent, when running inside a Next.js request. */
export async function geocodePropertySoon(propertyId: string) {
  const run = () => geocodeProperty(propertyId).catch((e) => console.error("[geocode]", e));
  try {
    const { after } = await import("next/server");
    after(run);
  } catch {
    await run();
  }
}
