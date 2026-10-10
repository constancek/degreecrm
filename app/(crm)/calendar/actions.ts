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
import { bookingTimes } from "@/lib/services/booking";

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

export async function createAppointmentAction(_prev: AppointmentResult | undefined, fd: FormData): Promise<AppointmentResult> {
  const user = await requireUser();
  const s = (k: string) => String(fd.get(k) ?? "").trim();
  const opt = (k: string) => s(k) || undefined;
  try {
    if (!isOwner(user)) throw new ForbiddenError("Only the owner books appointments");
    const kind = s("kind") === "job" ? "job" : "estimate";
    // No tech = book the time now; it waits in "Needs tech" and the customer is texted once one is assigned.
    const techId = s("techId") || null;
    const times = bookingTimes({ date: s("date"), window: s("window"), time: s("time"), hours: Number(s("hours") || "1") });

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
        assignedToId: techId ?? undefined,
      });
      leadId = lead.id;
    }
    if (!leadId) throw new ValidationError("Pick a customer, or add a new one");

    await scheduleVisit(user, {
      leadId,
      kind,
      techId,
      ...times,
      notes: opt("notes"),
    });
    revalidatePath("/calendar");
    revalidatePath("/dispatch");
    revalidatePath("/my-day");
    revalidatePath("/pipeline");
    revalidatePath(`/leads/${leadId}`);
    return { ok: techId ? "Appointment booked" : "Booked without a tech (Needs tech)", leadId };
  } catch (err) {
    if (err instanceof z.ZodError) return { error: err.issues[0]?.message ?? "Please check the form" };
    if (err instanceof ValidationError || err instanceof ForbiddenError || err instanceof NotFoundError) return { error: err.message };
    console.error(err);
    return { error: "Something went wrong. Please try again." };
  }
}
