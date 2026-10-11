import { z } from "zod";
import { db, type Tx } from "@/lib/db";
import { clientUrl } from "@/lib/env";
import { randomToken } from "@/lib/crypto";
import { packageTotals } from "@/lib/money";
import { TIER_LABELS } from "@/lib/tiers";
import { formatAddress } from "@/lib/notifications/discord-embeds";
import { getBlobStore } from "@/lib/integrations/blob";
import { getDrafter, type DraftInput } from "@/lib/integrations/claude";
import { getQuoClient } from "@/lib/integrations/quo";
import { STAGES, TRADE_IDS } from "@/lib/stages";
import type { LeadStage, Tier, Trade } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { ForbiddenError, NotFoundError, ValidationError, actorUserId, isOwner, type Actor } from "./actor";
import { recordActivity } from "./activity";
import { changeStage, leadScope } from "./leads";
import { listPriceBook } from "./pricebook";
import { taxForProperty } from "./tax";
import { currentTerms } from "./terms";

export const TIERS: Tier[] = ["good", "better", "best"];
export const PROPOSAL_TTL_DAYS = 30;

// ---- Input shapes -------------------------------------------------------------

const lineItemInput = z.object({
  description: z.string().trim().min(1, "Every line needs a description").max(500),
  qty: z.number().positive("Quantity must be more than 0").max(100_000),
  unit: z.string().trim().max(20).default("ea"),
  /** Cents. Only optional add-ons carry a price; included lines are scope text (the package has one price). */
  unitCents: z.number().int().min(0).default(0),
  isOptional: z.boolean().default(false),
  priceBookItemId: z.string().nullable().default(null),
});

const optionInput = z.object({
  tier: z.enum(["good", "better", "best"]),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(2000).default(""),
  highlights: z.array(z.string().trim().min(1).max(200)).max(8).default([]),
  warrantyText: z.string().trim().max(500).default(""),
  /** Lump-sum package price before tax, typed by the owner or tech. Null until someone prices it. */
  priceCents: z.number().int().min(0).max(100_000_000).nullable().default(null),
  lineItems: z.array(lineItemInput).max(60),
});

export const proposalContentInput = z.object({
  summary: z.string().trim().max(4000).default(""),
  recommendedTier: z.enum(["good", "better", "best"]).nullable().default(null),
  assumptions: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  exclusions: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  options: z.array(optionInput).length(3, "An estimate has exactly three packages: Essential, Premium and Supreme"),
});
export type ProposalContentInput = z.input<typeof proposalContentInput>;

const milestoneInput = z.object({
  label: z.string().trim().min(1, "Name each payment milestone").max(120),
  percent: z.number().int().min(1, "Milestones need a percent").max(100),
});

export const proposalEditInput = proposalContentInput.extend({
  depositPercent: z.number().int().min(0).max(100).nullable().default(null),
  /** Payment schedule after the deposit. Empty = deposit now, balance at completion. */
  milestones: z.array(milestoneInput).max(8).default([]),
  taxRateBps: z.number().int().min(0).max(2000).optional(),
  taxLabel: z.string().trim().max(200).optional(),
});

// ---- Loading ------------------------------------------------------------------

const fullInclude = {
  options: { orderBy: { sortOrder: "asc" }, include: { lineItems: { orderBy: { sortOrder: "asc" } } } },
  lead: { include: { customer: true, property: true, assignedTo: { select: { id: true, name: true } } } },
  terms: true,
  milestones: { orderBy: { sortOrder: "asc" } },
} satisfies Prisma.ProposalInclude;

export type FullProposal = Prisma.ProposalGetPayload<{ include: typeof fullInclude }>;

export async function getProposal(actor: Actor, id: string): Promise<FullProposal> {
  const p = await db.proposal.findFirst({ where: { id, lead: leadScope(actor) }, include: fullInclude });
  if (!p) throw new NotFoundError("Proposal not found");
  return p;
}

export async function listLeadProposals(actor: Actor, leadId: string) {
  return db.proposal.findMany({
    where: { leadId, lead: leadScope(actor) },
    orderBy: { version: "desc" },
    include: { options: { select: { tier: true, totalCents: true, id: true } } },
  });
}

async function assertLead(actor: Actor, leadId: string) {
  const lead = await db.lead.findFirst({ where: { id: leadId, ...leadScope(actor) }, include: { customer: true, property: true } });
  if (!lead) throw new NotFoundError("Lead not found");
  return lead;
}

// ---- Writing content ----------------------------------------------------------

type ResolvedLine = z.output<typeof lineItemInput> & { needsPrice: boolean };

/**
 * Included lines are scope text: no price (the package carries one lump sum). Optional add-ons are priced:
 * a price book item sets the price when drafting (Claude never sets prices); `trustPrices` keeps the given
 * unitCents (owner/tech edits); otherwise an unmatched add-on is $0 and flagged needsPrice.
 */
async function resolveLines(lines: z.output<typeof lineItemInput>[], trustPrices: boolean): Promise<ResolvedLine[]> {
  const ids = [...new Set(lines.map((l) => l.priceBookItemId).filter((x): x is string => Boolean(x)))];
  const book = new Map((await db.priceBookItem.findMany({ where: { id: { in: ids } } })).map((i) => [i.id, i]));
  return lines.map((l) => {
    const item = l.priceBookItemId ? book.get(l.priceBookItemId) : undefined;
    if (!l.isOptional) return { ...l, unit: item?.unit ?? l.unit, priceBookItemId: item ? item.id : null, unitCents: 0, needsPrice: false };
    if (item && !trustPrices) return { ...l, unitCents: item.priceCents, unit: item.unit, needsPrice: false };
    const unitCents = trustPrices ? l.unitCents : 0;
    return { ...l, priceBookItemId: item ? item.id : null, unitCents, needsPrice: unitCents === 0 };
  });
}

async function writeOptions(
  tx: Tx,
  proposalId: string,
  options: (Omit<z.output<typeof optionInput>, "lineItems"> & { lineItems: ResolvedLine[] })[],
  taxRateBps: number,
) {
  const tiers = options.map((o) => o.tier);
  if (new Set(tiers).size !== 3) throw new ValidationError("Packages must be one Essential, one Premium and one Supreme");
  await tx.proposalOption.deleteMany({ where: { proposalId } });
  for (const o of options) {
    const totals = packageTotals(o.priceCents, taxRateBps);
    await tx.proposalOption.create({
      data: {
        proposalId,
        tier: o.tier,
        title: o.title,
        summary: o.summary,
        highlights: o.highlights,
        warrantyText: o.warrantyText,
        priceCents: o.priceCents,
        sortOrder: TIERS.indexOf(o.tier),
        ...totals,
        lineItems: {
          create: o.lineItems.map((l, i) => ({
            description: l.description,
            qty: l.qty,
            unit: l.unit,
            unitCents: l.unitCents,
            isOptional: l.isOptional,
            needsPrice: l.needsPrice,
            priceBookItemId: l.priceBookItemId,
            sortOrder: i,
          })),
        },
      },
    });
  }
}

export type DraftMeta = { inputNotes?: string | null; targetMarginPercent?: number | null; aiModel?: string | null };

/** Creates the next draft version for a lead from structured content (Claude in the app, or Claude over MCP). */
export async function createProposalDraft(actor: Actor, leadId: string, raw: ProposalContentInput, meta: DraftMeta = {}) {
  const lead = await assertLead(actor, leadId);
  const content = proposalContentInput.parse(raw);
  const options = await Promise.all(
    content.options.map(async (o) => ({ ...o, lineItems: await resolveLines(o.lineItems, false) })),
  );
  const tax = await taxForProperty(lead.propertyId);

  const proposal = await db.$transaction(async (tx) => {
    const last = await tx.proposal.findFirst({ where: { leadId }, orderBy: { version: "desc" }, select: { version: true, number: true } });
    const p = await tx.proposal.create({
      data: {
        leadId,
        version: (last?.version ?? 0) + 1,
        // One estimate number per job request; revisions keep it (shown as #1001, rev 2).
        ...(last ? { number: last.number } : {}),
        summary: content.summary,
        recommendedTier: content.recommendedTier,
        assumptions: content.assumptions,
        exclusions: content.exclusions,
        taxRateBps: tax?.rateBps ?? 0,
        taxLabel: tax?.label ?? "",
        inputNotes: meta.inputNotes ?? null,
        targetMarginPercent: meta.targetMarginPercent ?? null,
        aiModel: meta.aiModel ?? null,
        createdById: actorUserId(actor),
      },
    });
    await writeOptions(tx, p.id, options, p.taxRateBps);
    await recordActivity(tx, actor, {
      type: "proposal_drafted",
      leadId,
      body: `Proposal v${p.version} drafted${meta.aiModel ? " with Claude" : ""}`,
      data: { proposalId: p.id, version: p.version },
    });
    return p;
  });
  return getProposal(actor, proposal.id);
}

const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export const generateInput = z.object({
  trade: z.enum(TRADE_IDS),
  notes: z.string().trim().min(10, "Add a few sentences of notes about the job").max(30_000),
  equipment: z.string().trim().max(5_000).optional(),
  targetMarginPercent: z.number().int().min(0).max(90).nullable().default(null),
});

/** Owner/tech flow in the app: store photos, ask Claude for a draft, save it. */
export async function generateProposal(
  actor: Actor,
  leadId: string,
  raw: z.input<typeof generateInput>,
  photos: { body: Buffer; contentType: string }[],
) {
  const input = generateInput.parse(raw);
  const lead = await assertLead(actor, leadId);
  if (photos.length > 6) throw new ValidationError("Attach up to 6 photos");
  for (const p of photos) {
    if (!(PHOTO_TYPES as readonly string[]).includes(p.contentType)) throw new ValidationError("Photos must be JPEG, PNG or WebP");
    if (p.body.length > 4 * 1024 * 1024) throw new ValidationError("Each photo must be under 4 MB");
  }

  const blob = getBlobStore();
  for (const p of photos) {
    const ext = p.contentType.split("/")[1];
    const blobPath = `leads/${leadId}/photos/${randomToken(12)}.${ext}`;
    await blob.put(blobPath, p.body, p.contentType);
    await db.leadPhoto.create({ data: { leadId, blobPath, contentType: p.contentType } });
  }

  const priceBook = await listPriceBook({ trade: input.trade });
  const draftInput: DraftInput = {
    trade: input.trade as Trade,
    customerName: lead.customer.name,
    customerType: lead.customer.type,
    address: lead.property ? formatAddress(lead.property) : null,
    jobTitle: lead.title,
    notes: input.notes,
    equipment: input.equipment || null,
    targetMarginPercent: input.targetMarginPercent,
    priceBook: priceBook.map((i) => ({
      id: i.id,
      category: i.category,
      name: i.name,
      description: i.description,
      unit: i.unit,
      priceCents: i.priceCents,
    })),
    photos: photos.map((p) => ({ mediaType: p.contentType as DraftInput["photos"][number]["mediaType"], base64: p.body.toString("base64") })),
  };
  const { draft, model } = await getDrafter().draft(draftInput);
  return createProposalDraft(actor, leadId, draft, {
    inputNotes: [input.notes, input.equipment && `Equipment:\n${input.equipment}`].filter(Boolean).join("\n\n"),
    targetMarginPercent: input.targetMarginPercent,
    aiModel: model,
  });
}

/** Editor save. Only drafts can change; a sent proposal is revised by creating a new version. */
export async function saveProposal(actor: Actor, id: string, raw: z.input<typeof proposalEditInput>) {
  const existing = await getProposal(actor, id);
  if (existing.status !== "draft") throw new ValidationError("This proposal was already sent. Create a revision to change it.");
  const input = proposalEditInput.parse(raw);
  if (input.taxRateBps !== undefined && !isOwner(actor)) throw new ForbiddenError("Only the owner can change the tax rate");
  const taxRateBps = input.taxRateBps ?? existing.taxRateBps;
  const options = await Promise.all(input.options.map(async (o) => ({ ...o, lineItems: await resolveLines(o.lineItems, true) })));
  checkSchedule(input.depositPercent, input.milestones);

  await db.$transaction(async (tx) => {
    await tx.proposal.update({
      where: { id },
      data: {
        summary: input.summary,
        recommendedTier: input.recommendedTier,
        assumptions: input.assumptions,
        exclusions: input.exclusions,
        depositPercent: input.depositPercent,
        taxRateBps,
        taxLabel: input.taxRateBps !== undefined ? (input.taxLabel ?? "Set manually") : existing.taxLabel,
        pdfPath: null,
        pdfKey: null,
      },
    });
    await writeOptions(tx, id, options, taxRateBps);
    await tx.paymentMilestone.deleteMany({ where: { proposalId: id } });
    if (input.milestones.length) {
      await tx.paymentMilestone.createMany({ data: input.milestones.map((m, i) => ({ proposalId: id, label: m.label, percent: m.percent, sortOrder: i })) });
    }
  });
  return getProposal(actor, id);
}

/** A payment schedule needs a fixed deposit, and deposit + milestones must add up to 100%. */
function checkSchedule(depositPercent: number | null, milestones: { percent: number }[]) {
  if (!milestones.length) return;
  if (depositPercent == null) throw new ValidationError("Set the deposit % to use a payment schedule.");
  const sum = depositPercent + milestones.reduce((s, m) => s + m.percent, 0);
  if (sum !== 100) throw new ValidationError(`The deposit and payment milestones add up to ${sum}%. They need to add up to 100%.`);
}

/** Editor view → the same shape `saveProposal` takes. Used by MCP's update_proposal_option. */
export function toEditInput(p: FullProposal): z.input<typeof proposalEditInput> {
  return {
    summary: p.summary,
    recommendedTier: p.recommendedTier,
    assumptions: p.assumptions,
    exclusions: p.exclusions,
    depositPercent: p.depositPercent,
    milestones: p.milestones.map((m) => ({ label: m.label, percent: m.percent })),
    options: p.options.map((o) => ({
      tier: o.tier,
      title: o.title,
      summary: o.summary,
      highlights: o.highlights,
      warrantyText: o.warrantyText,
      priceCents: o.priceCents,
      lineItems: o.lineItems.map((l) => ({
        description: l.description,
        qty: l.qty,
        unit: l.unit,
        unitCents: l.unitCents,
        isOptional: l.isOptional,
        priceBookItemId: l.priceBookItemId,
      })),
    })),
  };
}

/** Copies a sent proposal into a new draft version. */
export async function createRevision(actor: Actor, id: string) {
  const p = await getProposal(actor, id);
  if (p.status === "draft") return p;
  const next = await createProposalDraft(actor, p.leadId, toEditInput(p) as ProposalContentInput, {
    inputNotes: p.inputNotes,
    targetMarginPercent: p.targetMarginPercent,
  });
  // Keep the owner's manual price and tax decisions from the original.
  return saveProposal(actor, next.id, { ...toEditInput(p), taxRateBps: isOwner(actor) ? p.taxRateBps : undefined, taxLabel: p.taxLabel });
}

// ---- Sending ------------------------------------------------------------------

export function proposalLink(token: string) {
  return `${clientUrl()}/p/${token}`;
}

export function sendProblems(p: FullProposal): string[] {
  const problems: string[] = [];
  if (p.options.length !== 3) problems.push("The estimate needs three packages.");
  for (const o of p.options) {
    const name = TIER_LABELS[o.tier];
    if (!o.priceCents || o.priceCents <= 0) problems.push(`${name}: enter the package price.`);
    if (!o.lineItems.some((l) => !l.isOptional)) problems.push(`${name}: add at least one line to what's included.`);
    const unpriced = o.lineItems.filter((l) => l.isOptional && (l.needsPrice || l.unitCents <= 0));
    if (unpriced.length) problems.push(`${name}: ${unpriced.length} optional add-on(s) still need a price.`);
  }
  if (!p.summary.trim()) problems.push("Add a summary for the customer.");
  if (!p.lead.property) problems.push("The lead has no job address (needed for sales tax).");
  return problems;
}

const STAGE_ORDER = STAGES.map((s) => s.id);

export async function sendProposal(actor: Actor, id: string, opts: { textCustomer: boolean }) {
  // Techs send (or present) estimates for their own leads on site; getProposal limits them to those.
  const p = await getProposal(actor, id);
  if (!isOwner(actor) && opts.textCustomer) throw new ForbiddenError("Only the owner can text a proposal link");
  if (p.status !== "draft") throw new ValidationError("This proposal was already sent.");
  const problems = sendProblems(p);
  if (problems.length) throw new ValidationError(problems.join(" "));
  const terms = await currentTerms();
  if (!terms) throw new ValidationError("Add your Terms & Conditions in Settings before sending.");

  const token = randomToken(24);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PROPOSAL_TTL_DAYS * 86_400_000);

  await db.$transaction(async (tx) => {
    // Older live versions stop working once a newer one is sent.
    await tx.proposal.updateMany({
      where: { leadId: p.leadId, id: { not: id }, status: { in: ["sent", "viewed"] } },
      data: { status: "superseded" },
    });
    await tx.proposal.update({
      where: { id },
      data: { status: "sent", token, sentAt: now, expiresAt, termsVersionId: terms.id },
    });
    await recordActivity(tx, actor, {
      type: "proposal_sent",
      leadId: p.leadId,
      body: `Proposal v${p.version} sent`,
      data: { proposalId: id, version: p.version },
    });
  });

  const stage = p.lead.stage as LeadStage;
  if (stage === "lost" || STAGE_ORDER.indexOf(stage) < STAGE_ORDER.indexOf("estimate_sent")) {
    await changeStage(actor, p.leadId, "estimate_sent");
  }

  const link = proposalLink(token);
  let texted = false;
  let textError: string | null = null;
  if (opts.textCustomer) {
    const customer = p.lead.customer;
    const quo = getQuoClient();
    if (!customer.phone) textError = "The customer has no phone number.";
    else if (customer.smsOptOut) textError = "The customer has opted out of texts.";
    else if (!quo) textError = "Texting isn't set up (QUO_API_KEY / QUO_INBOX_ID).";
    else {
      const first = customer.name.split(/\s+/)[0];
      const content = `Hi ${first}, here's your proposal from Degree of Comfort: ${link} Pick the option that works best for you. Reply STOP to opt out.`;
      try {
        const sent = await quo.sendText({ to: customer.phone, content });
        texted = true;
        await db.$transaction((tx) =>
          recordActivity(tx, actor, {
            type: "sms_sent",
            leadId: p.leadId,
            body: content,
            data: { quoMessageId: sent.id, proposalId: id, to: customer.phone },
          }),
        );
      } catch (err) {
        textError = "The text didn't go through. Copy the link and send it another way.";
        console.error("[quo]", err);
      }
    }
    if (textError) {
      await db.$transaction((tx) =>
        recordActivity(tx, actor, { type: "sms_failed", leadId: p.leadId, body: textError, data: { proposalId: id } }),
      );
    }
  }
  return { link, texted, textError };
}

export function viewSummary(p: { viewCount: number; lastViewedAt: Date | null }) {
  return p.viewCount ? { count: p.viewCount, last: p.lastViewedAt } : null;
}


/** How the link reached the customer, from the activity log: "texted" with the number, the failure reason, or null. */
export async function proposalTextStatus(proposalId: string) {
  const row = await db.activity.findFirst({
    where: { type: { in: ["sms_sent", "sms_failed"] }, data: { path: ["proposalId"], equals: proposalId } },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return null;
  return row.type === "sms_sent"
    ? { texted: true as const, to: (row.data as { to?: string } | null)?.to ?? null }
    : { texted: false as const, reason: row.body ?? "The text didn't go through." };
}
