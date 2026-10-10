// Booking requests: the customer (website form, or staff/Claude on a call) asks for a day and a 3-hour
// arrival window; the owner confirms, which books an estimate visit for that window.

import { z } from "zod";
import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { TRADE_IDS } from "@/lib/stages";
import { WINDOWS, bookableDates, dateLabel, windowLabel } from "@/lib/booking";
import { easternMidnight } from "./dispatch";
import { ForbiddenError, NotFoundError, SYSTEM, ValidationError, isOwner, type Actor } from "./actor";
import { recordActivity } from "./activity";
import { createLead } from "./leads";
import { enqueueDiscord, flushOutboxSoon } from "./outbox";
import { alertOwner, sendCustomerText } from "./messages";
import { RateLimitedError } from "./intake";
import { scheduleVisit } from "./visits";

const windowIds = WINDOWS.map((w) => w.id) as [string, ...string[]];
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a day");

export const bookingInput = z
  .object({
    name: z.string().trim().min(2, "Please enter your name").max(200),
    phone: z.string().trim().min(7, "Please enter your phone number").max(40),
    email: z.string().trim().max(200).optional().transform((v) => v || undefined),
    street: z.string().trim().min(3, "Please enter the service address").max(200),
    city: z.string().trim().max(100).optional().transform((v) => v || undefined),
    zip: z.string().trim().max(10).optional().transform((v) => v || undefined),
    trade: z.enum(TRADE_IDS),
    message: z.string().trim().min(3, "Tell us a little about what's going on").max(5000),
    date: ymd,
    window: z.enum(windowIds, { message: "Pick an arrival window" }),
    altDate: ymd.optional(),
    altWindow: z.enum(windowIds).optional(),
  })
  .refine((v) => !v.altDate || v.altWindow, { message: "Pick a window for your second choice", path: ["altWindow"] });

export type BookingInput = z.input<typeof bookingInput>;

function assertBookable(date: string, now: Date) {
  if (!bookableDates(now).some((d) => d.ymd === date)) throw new ValidationError("Please pick a day in the next three weeks (Monday to Saturday)");
}

/** Website form or staff/Claude on a call. Creates the lead (or uses `leadId`) and the request. */
export async function requestBooking(
  actor: Actor,
  raw: BookingInput | (Omit<BookingInput, "name" | "phone" | "street" | "trade" | "message"> & { leadId: string; message?: string }),
  meta: { ip: string | null; source: "website" | "claude" | "staff"; now?: Date },
) {
  const now = meta.now ?? new Date();
  let leadId: string;
  let input: { date: string; window: string; altDate?: string; altWindow?: string; message?: string };

  if ("leadId" in raw && raw.leadId) {
    const lead = await db.lead.findUnique({ where: { id: raw.leadId } });
    if (!lead) throw new NotFoundError("Lead not found");
    const parsed = z
      .object({ date: ymd, window: z.enum(windowIds), altDate: ymd.optional(), altWindow: z.enum(windowIds).optional(), message: z.string().optional() })
      .parse(raw);
    leadId = lead.id;
    input = parsed;
  } else {
    const parsed = bookingInput.parse(raw);
    if (meta.ip) {
      const recent = await db.activity.count({
        where: { type: { in: ["web_form", "booking_request"] }, createdAt: { gte: new Date(now.getTime() - 3_600_000) }, data: { path: ["ip"], equals: meta.ip } },
      });
      if (recent >= 5) throw new RateLimitedError("Too many requests. Please call us instead.");
    }
    const lead = await createLead(actor, {
      customer: { name: parsed.name, phone: parsed.phone, email: parsed.email },
      property: { street: parsed.street, city: parsed.city, zip: parsed.zip },
      title: parsed.message.split("\n")[0]!.slice(0, 80),
      trade: parsed.trade,
      source: meta.source === "website" ? "web_form" : "phone",
      notes: parsed.message,
    });
    leadId = lead.id;
    input = parsed;
  }
  assertBookable(input.date, now);
  if (input.altDate) assertBookable(input.altDate, now);

  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, include: { customer: true, property: true, assignedTo: { select: { name: true } } } });
  const request = await db.$transaction(async (tx) => {
    // One open request per lead: a new one replaces the old.
    await tx.bookingRequest.updateMany({ where: { leadId, status: "pending" }, data: { status: "declined" } });
    const r = await tx.bookingRequest.create({
      data: { leadId, date: input.date, window: input.window, altDate: input.altDate ?? null, altWindow: input.altWindow ?? null, source: meta.source },
    });
    const wanted = `${dateLabel(input.date)}, ${windowLabel(input.window)}${input.altDate ? ` (or ${dateLabel(input.altDate)}, ${windowLabel(input.altWindow)})` : ""}`;
    await recordActivity(tx, actor, {
      type: "booking_request",
      leadId,
      body: `Asked for an estimate ${wanted}`,
      data: { bookingId: r.id, ip: meta.ip, source: meta.source },
    });
    await enqueueDiscord(tx, {
      content: `📅 Booking request from ${lead.customer.name}: ${wanted}. Confirm it: ${appUrl()}/leads/${leadId}`,
    });
    return r;
  });
  await flushOutboxSoon();
  await alertOwner(`Booking request: ${lead.customer.name}, ${dateLabel(input.date)} ${windowLabel(input.window)}. ${appUrl()}/leads/${leadId}`);
  if (meta.source === "website") {
    await sendCustomerText(SYSTEM("Booking"), {
      customerId: lead.customerId,
      leadId,
      body: `Hi ${lead.customer.name.split(/\s+/)[0]}, thanks for contacting Degree of Comfort! We got your request for ${dateLabel(input.date)}, ${windowLabel(input.window)}. We'll text you shortly to confirm. Reply STOP to opt out.`,
    });
  }
  return request;
}

/** Window → visit start/end (UTC) for an Eastern date. */
export function windowTimes(date: string, windowId: string) {
  const w = WINDOWS.find((x) => x.id === windowId);
  if (!w) throw new ValidationError("Unknown arrival window");
  const midnight = easternMidnight(date).getTime();
  return { start: new Date(midnight + w.startHour * 3_600_000), end: new Date(midnight + w.endHour * 3_600_000) };
}

/** Owner confirms (optionally a different day/window): books the estimate visit; the customer gets the confirmation text. */
export async function confirmBooking(actor: Actor, bookingId: string, input: { techId: string; date?: string; window?: string }) {
  if (!isOwner(actor)) throw new ForbiddenError("Only the owner confirms bookings");
  const b = await db.bookingRequest.findUnique({ where: { id: bookingId } });
  if (!b) throw new NotFoundError("Booking request not found");
  if (b.status !== "pending") throw new ValidationError("This request was already handled");
  const { start, end } = windowTimes(input.date ?? b.date, input.window ?? b.window);
  // scheduleVisit marks the pending request confirmed and links the visit.
  return scheduleVisit(actor, { leadId: b.leadId, kind: "estimate", techId: input.techId, start, end, notes: `Arrival window ${windowLabel(input.window ?? b.window)}` });
}

export async function declineBooking(actor: Actor, bookingId: string, opts: { textCustomer?: string } = {}) {
  if (!isOwner(actor)) throw new ForbiddenError("Only the owner handles bookings");
  const b = await db.bookingRequest.findUnique({ where: { id: bookingId }, include: { lead: true } });
  if (!b || b.status !== "pending") throw new ValidationError("This request was already handled");
  await db.bookingRequest.update({ where: { id: bookingId }, data: { status: "declined" } });
  await db.$transaction((tx) => recordActivity(tx, actor, { type: "booking_declined", leadId: b.leadId, body: opts.textCustomer ?? null }));
  if (opts.textCustomer) await sendCustomerText(actor, { customerId: b.lead.customerId, leadId: b.leadId, body: opts.textCustomer });
}

export async function pendingBookings() {
  return db.bookingRequest.findMany({
    where: { status: "pending" },
    include: { lead: { include: { customer: true, property: true } } },
    orderBy: [{ date: "asc" }, { window: "asc" }],
  });
}
