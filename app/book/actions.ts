"use server";

import { ZodError } from "zod";
import { requestBooking, type BookingInput } from "@/lib/services/booking";
import { RateLimitedError } from "@/lib/services/intake";
import { ValidationError } from "@/lib/services/actor";
import { requestMeta } from "@/lib/server/request-meta";

export async function submitBookingAction(input: BookingInput & { company_website?: string }): Promise<{ ok?: boolean; error?: string }> {
  // Honeypot: real people never fill this in. Pretend it worked.
  if (input.company_website) return { ok: true };
  const { company_website: _ignored, ...data } = input;
  void _ignored;
  try {
    const meta = await requestMeta();
    await requestBooking({ kind: "system", label: "Website booking" }, data, { ip: meta.ip, source: "website" });
    return { ok: true };
  } catch (err) {
    if (err instanceof ZodError) return { error: err.issues[0]?.message ?? "Please check the form" };
    if (err instanceof ValidationError || err instanceof RateLimitedError) return { error: err.message };
    console.error("[booking]", err);
    return { error: "Something went wrong. Please call us." };
  }
}
