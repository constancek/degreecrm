import { db, type Tx } from "@/lib/db";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { leadStageEmbed } from "@/lib/notifications/discord-embeds";
import type { LeadStage } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { ForbiddenError, NotFoundError, ValidationError, isOwner, type Actor } from "./actor";
import { recordActivity } from "./activity";
import { enqueueDiscord, flushOutboxSoon } from "./outbox";
import { geocodePropertySoon } from "./geocode";
import { getDiscordStages } from "./settings";
import {
  createLeadInput,
  noteInput,
  stageInput,
  updateLeadInput,
  type CreateLeadInput,
} from "./schemas";

const leadSummaryInclude = {
  customer: { select: { id: true, name: true, phone: true, email: true, type: true } },
  property: { select: { id: true, street: true, unit: true, city: true, state: true, zip: true } },
  assignedTo: { select: { id: true, name: true } },
} satisfies Prisma.LeadInclude;

export type LeadSummary = Prisma.LeadGetPayload<{ include: typeof leadSummaryInclude }>;

/** Techs only see leads assigned to them (SPEC.md Security). */
export function leadScope(actor: Actor): Prisma.LeadWhereInput {
  return scope(actor);
}

function scope(actor: Actor): Prisma.LeadWhereInput {
  return isOwner(actor) ? {} : { assignedToId: (actor as { id: string }).id };
}

async function loadScoped(tx: Tx | typeof db, actor: Actor, id: string) {
  const lead = await tx.lead.findFirst({ where: { id, ...scope(actor) }, include: leadSummaryInclude });
  if (!lead) throw new NotFoundError("Lead not found");
  return lead;
}

function actorName(actor: Actor) {
  return actor.kind === "user" ? actor.name : actor.label;
}

// ---- Customers --------------------------------------------------------------

/** Match an existing customer by phone, then email; otherwise create one. */
export async function findOrCreateCustomer(
  tx: Tx,
  actor: Actor,
  input: NonNullable<ReturnType<typeof createLeadInput.parse>["customer"]>,
) {
  const phone = normalizePhone(input.phone);
  const email = normalizeEmail(input.email);
  if (input.phone && !phone) throw new ValidationError("Phone number doesn't look like a US number");
  if (input.email && !email) throw new ValidationError("Email address doesn't look right");

  const existing =
    (phone && (await tx.customer.findFirst({ where: { phone }, orderBy: { createdAt: "asc" } }))) ||
    (email && (await tx.customer.findFirst({ where: { email }, orderBy: { createdAt: "asc" } }))) ||
    null;
  if (existing) {
    // Fill in contact details we didn't have.
    const patch: Prisma.CustomerUpdateInput = {};
    if (!existing.phone && phone) patch.phone = phone;
    if (!existing.email && email) patch.email = email;
    return Object.keys(patch).length ? tx.customer.update({ where: { id: existing.id }, data: patch }) : existing;
  }

  const customer = await tx.customer.create({
    data: { name: input.name, phone, email, type: input.type },
  });
  await recordActivity(tx, actor, { type: "customer_created", customerId: customer.id });
  return customer;
}

async function findOrCreateProperty(
  tx: Tx,
  customerId: string,
  input: NonNullable<ReturnType<typeof createLeadInput.parse>["property"]>,
) {
  const existing = await tx.property.findFirst({
    where: { customerId, street: { equals: input.street, mode: "insensitive" }, unit: input.unit ?? null },
  });
  if (existing) {
    if (existing.lat == null && input.lat != null && input.lng != null) {
      return tx.property.update({
        where: { id: existing.id },
        data: { lat: input.lat, lng: input.lng, county: existing.county ?? input.county },
      });
    }
    return existing;
  }
  return tx.property.create({
    data: {
      customerId,
      street: input.street,
      unit: input.unit,
      city: input.city ?? "Cincinnati",
      state: (input.state ?? "OH").toUpperCase(),
      zip: input.zip,
      notes: input.notes,
      county: input.county,
      lat: input.lat,
      lng: input.lng,
    },
  });
}

// ---- Leads ------------------------------------------------------------------

export async function createLead(actor: Actor, raw: CreateLeadInput) {
  const input = createLeadInput.parse(raw);

  let assignedToId = input.assignedToId ?? null;
  if (!isOwner(actor)) {
    // Techs can create leads but they land on their own board.
    assignedToId = (actor as { id: string }).id;
  } else if (assignedToId) {
    const tech = await db.user.findFirst({ where: { id: assignedToId, active: true } });
    if (!tech) throw new ValidationError("Assigned user not found");
  }

  const lead = await db.$transaction(async (tx) => {
    let customerId = input.customerId;
    if (customerId) {
      const found = await tx.customer.findUnique({ where: { id: customerId } });
      if (!found) throw new ValidationError("Customer not found");
    } else {
      customerId = (await findOrCreateCustomer(tx, actor, input.customer!)).id;
    }

    let propertyId = input.propertyId ?? null;
    if (propertyId) {
      const found = await tx.property.findFirst({ where: { id: propertyId, customerId } });
      if (!found) throw new ValidationError("Property doesn't belong to this customer");
    } else if (input.property) {
      propertyId = (await findOrCreateProperty(tx, customerId, input.property)).id;
    }

    const created = await tx.lead.create({
      data: {
        customerId,
        propertyId,
        title: input.title,
        trade: input.trade,
        source: input.source,
        notes: input.notes,
        assignedToId,
      },
      include: leadSummaryInclude,
    });
    await recordActivity(tx, actor, {
      type: "lead_created",
      leadId: created.id,
      customerId,
      data: { source: input.source },
    });
    if ((await getDiscordStages(tx)).has("new")) {
      await enqueueDiscord(tx, leadStageEmbed(created, { by: actorName(actor) }));
    }
    return created;
  });

  await flushOutboxSoon();
  if (lead.propertyId) await geocodePropertySoon(lead.propertyId);
  return lead;
}

export async function getLead(actor: Actor, id: string) {
  const lead = await db.lead.findFirst({
    where: { id, ...scope(actor) },
    include: {
      ...leadSummaryInclude,
      customer: true,
      property: true,
      activities: {
        orderBy: { createdAt: "desc" },
        take: 200,
        include: { user: { select: { id: true, name: true } } },
      },
    },
  });
  if (!lead) throw new NotFoundError("Lead not found");
  return lead;
}

export async function listBoardLeads(actor: Actor, opts: { includeLost?: boolean } = {}) {
  return db.lead.findMany({
    where: {
      ...scope(actor),
      ...(opts.includeLost ? {} : { stage: { not: "lost" } }),
    },
    include: leadSummaryInclude,
    orderBy: [{ stageChangedAt: "desc" }],
    take: 500,
  });
}

export async function searchLeads(actor: Actor, query: string, opts: { stage?: LeadStage; limit?: number } = {}) {
  const q = query.trim();
  const phoneDigits = q.replace(/\D/g, "");
  return db.lead.findMany({
    where: {
      ...scope(actor),
      ...(opts.stage ? { stage: opts.stage } : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { customer: { name: { contains: q, mode: "insensitive" } } },
              { customer: { email: { contains: q, mode: "insensitive" } } },
              ...(phoneDigits.length >= 4 ? [{ customer: { phone: { contains: phoneDigits } } }] : []),
              { property: { street: { contains: q, mode: "insensitive" } } },
            ],
          }
        : {}),
    },
    include: leadSummaryInclude,
    orderBy: { lastActivityAt: "desc" },
    take: opts.limit ?? 20,
  });
}

export async function changeStage(
  actor: Actor,
  leadId: string,
  rawStage: LeadStage,
  opts: { lostReason?: string } = {},
) {
  const stage = stageInput.parse(rawStage);
  const result = await db.$transaction(async (tx) => {
    const lead = await loadScoped(tx, actor, leadId);
    if (lead.stage === stage) return { updated: lead, changed: false };

    const lostReason = stage === "lost" ? opts.lostReason?.trim() || "No reason given" : null;
    const updated = await tx.lead.update({
      where: { id: leadId },
      data: { stage, stageChangedAt: new Date(), lostReason },
      include: leadSummaryInclude,
    });
    await recordActivity(tx, actor, {
      type: "stage_changed",
      leadId,
      body: lostReason,
      data: { from: lead.stage, to: stage },
    });
    if ((await getDiscordStages(tx)).has(stage)) {
      await enqueueDiscord(tx, leadStageEmbed(updated, { by: actorName(actor) }));
    }
    return { updated, changed: lead.stage !== stage };
  });
  await flushOutboxSoon();
  if (result.changed) {
    // Lazy import: sequences → proposals → leads would otherwise be circular.
    const { onLeadStageChanged } = await import("./sequences");
    await onLeadStageChanged(leadId, stage).catch((e) => console.error("[sequences]", e));
  }
  return result.updated;
}

export async function assignLead(actor: Actor, leadId: string, userId: string | null) {
  if (!isOwner(actor)) throw new ForbiddenError("Only the owner can assign leads");
  return db.$transaction(async (tx) => {
    const lead = await loadScoped(tx, actor, leadId);
    if (lead.assignedToId === userId) return lead;
    const user = userId ? await tx.user.findFirst({ where: { id: userId, active: true } }) : null;
    if (userId && !user) throw new ValidationError("User not found");
    const updated = await tx.lead.update({
      where: { id: leadId },
      data: { assignedToId: userId },
      include: leadSummaryInclude,
    });
    await recordActivity(tx, actor, {
      type: "assigned",
      leadId,
      body: user ? `Assigned to ${user.name}` : "Unassigned",
      data: { from: lead.assignedToId, to: userId },
    });
    return updated;
  });
}

export async function updateLead(actor: Actor, leadId: string, raw: unknown) {
  const parsed = updateLeadInput.parse(raw);
  const input = { ...parsed, notes: parsed.notes === undefined ? undefined : parsed.notes.trim() || null };
  return db.$transaction(async (tx) => {
    const lead = await loadScoped(tx, actor, leadId);
    const changed = Object.fromEntries(
      Object.entries(input).filter(([k, v]) => v !== undefined && v !== (lead as Record<string, unknown>)[k]),
    );
    if (!Object.keys(changed).length) return lead;
    const updated = await tx.lead.update({ where: { id: leadId }, data: changed, include: leadSummaryInclude });
    await recordActivity(tx, actor, {
      type: "lead_updated",
      leadId,
      data: { fields: Object.keys(changed) },
    });
    return updated;
  });
}

export async function logNote(actor: Actor, leadId: string, rawBody: string) {
  const body = noteInput.parse(rawBody);
  return db.$transaction(async (tx) => {
    await loadScoped(tx, actor, leadId);
    return recordActivity(tx, actor, { type: "note", leadId, body });
  });
}
