import { db } from "@/lib/db";
import { getGeocodingClient } from "@/lib/integrations/google-maps";

/** Fill in lat/lng for a property that doesn't have them yet. Properties are geocoded once. */
export async function geocodeProperty(propertyId: string): Promise<boolean> {
  const client = getGeocodingClient();
  if (!client) return false;
  const p = await db.property.findUnique({ where: { id: propertyId } });
  if (!p || p.lat != null) return false;
  const address = [p.street, p.unit, p.city, p.state, p.zip].filter(Boolean).join(", ");
  const point = await client.geocode(address);
  if (!point) return false;
  await db.property.updateMany({ where: { id: propertyId, lat: null }, data: { lat: point.lat, lng: point.lng } });
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
