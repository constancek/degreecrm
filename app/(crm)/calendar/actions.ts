"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { formatPhone } from "@/lib/phone";
import { formatAddress } from "@/lib/notifications/discord-embeds";
import { ForbiddenError, NotFoundError, ValidationError, isOwner } from "@/lib/services/actor";
import { createLead, searchLeads } from "@/lib/services/leads";
import { scheduleVisit } from "@/lib/services/visits";
import { easternMidnight } from "@/lib/services/dispatch";

export type LeadOption = { id: string; customer: string; title: string; address: string; phone: string; hasJob: boolean };
export type AppointmentResult = { error?: string; ok?: string; leadId?: string };

/** Lead picker in "New appointment" (owner only, like scheduling itself). */
export async function lookupLeadsAction(query: string): Promise<LeadOption[]> {
  const user = await requireUser();
  if (!isOwner(user)) return [];
  const leads = await searchLeads(user, query.slice(0, 100), { limit: 8 });
  const withJobs = new Set(
    (await db.job.findMany({ where: { leadId: { in: leads.map((l) => l.id) } }, select: { leadId: true } })).map((j) => j.leadId),
  );
  return leads.map((l) => ({
    id: l.id,
    customer: l.customer.name,
    title: l.title,
    address: formatAddress(l.property),
    phone: formatPhone(l.customer.phone),
    hasJob: withJobs.has(l.id),
  }));
}

/** "2026-10-14" + "09:30" (Eastern) → Date. */
function easternAt(date: string, time: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new ValidationError("Pick a date and start time");
  const [h, m] = time.split(":").map(Number) as [number, number];
  return new Date(easternMidnight(date).getTime() + (h * 60 + m) * 60_000);
}

export async function createAppointmentAction(_prev: AppointmentResult | undefined, fd: FormData): Promise<AppointmentResult> {
  const user = await requireUser();
  const s = (k: string) => String(fd.get(k) ?? "").trim();
  const opt = (k: string) => s(k) || undefined;
  try {
    if (!isOwner(user)) throw new ForbiddenError("Only the owner books appointments");
    const kind = s("kind") === "job" ? "job" : "estimate";
    const techId = s("techId");
    if (!techId) throw new ValidationError("Choose who's going");
    const start = easternAt(s("date"), s("time"));
    const hours = Number(s("hours") || "1");
    if (!(hours >= 0.25 && hours <= 12)) throw new ValidationError("Length must be between 15 minutes and 12 hours");

    let leadId = s("leadId");
    if (s("customerMode") === "new") {
      if (kind === "job") throw new ValidationError("A job visit needs an existing lead with a job");
      const lead = await createLead(user, {
        customer: { name: s("customerName"), phone: opt("phone"), email: opt("email"), type: "residential" },
        property: s("street")
          ? {
              street: s("street"),
              unit: opt("unit"),
              city: opt("city"),
              state: opt("state"),
              county: opt("county"),
              zip: opt("zip"),
              lat: opt("lat"),
              lng: opt("lng"),
            }
          : undefined,
        title: s("title"),
        trade: s("trade") as never,
        source: (s("source") || "phone") as never,
        notes: opt("leadNotes"),
        assignedToId: techId,
      });
      leadId = lead.id;
    }
    if (!leadId) throw new ValidationError("Pick a customer, or add a new one");

    await scheduleVisit(user, {
      leadId,
      kind,
      techId,
      start,
      end: new Date(start.getTime() + hours * 3_600_000),
      notes: opt("notes"),
    });
    revalidatePath("/calendar");
    revalidatePath("/dispatch");
    revalidatePath("/my-day");
    revalidatePath("/pipeline");
    revalidatePath(`/leads/${leadId}`);
    return { ok: "Appointment booked", leadId };
  } catch (err) {
    if (err instanceof z.ZodError) return { error: err.issues[0]?.message ?? "Please check the form" };
    if (err instanceof ValidationError || err instanceof ForbiddenError || err instanceof NotFoundError) return { error: err.message };
    console.error(err);
    return { error: "Something went wrong. Please try again." };
  }
}
