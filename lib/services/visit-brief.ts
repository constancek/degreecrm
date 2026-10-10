import { db } from "@/lib/db";
import { getPropertyDataClient, type PropertyFacts } from "@/lib/integrations/rentcast";
import { formatAddress } from "@/lib/notifications/discord-embeds";
import type { Trade } from "@/generated/prisma/enums";
import type { Actor } from "./actor";
import { getVisit } from "./visits";

/** Re-check public records after this long (sales, renovations). */
const REFRESH_MS = 180 * 24 * 3_600_000;

/**
 * Public-record facts for a property, from the cache or one RentCast lookup. Never throws: a failed lookup
 * just leaves the card with our own history.
 */
export async function propertyFacts(propertyId: string, now = new Date()): Promise<PropertyFacts | null> {
  const p = await db.property.findUnique({ where: { id: propertyId } });
  if (!p) return null;
  const fresh = p.intelFetchedAt && now.getTime() - p.intelFetchedAt.getTime() < REFRESH_MS;
  if (fresh) return (p.intel as PropertyFacts | null) ?? null;
  const client = getPropertyDataClient();
  const address = formatAddress(p);
  if (!client || !address) return (p.intel as PropertyFacts | null) ?? null;
  try {
    const facts = await client.lookup(address);
    await db.property.update({
      where: { id: p.id },
      data: { intel: facts ?? undefined, intelFetchedAt: now },
    });
    return facts ?? (p.intel as PropertyFacts | null) ?? null;
  } catch (e) {
    console.warn("[property facts]", (e as Error).message);
    return (p.intel as PropertyFacts | null) ?? null;
  }
}

export type CustomerHistory = {
  customerSince: Date;
  otherRequests: number;
  jobsDone: number;
  paidCents: number;
  declined: { title: string; reason: string | null; when: Date }[];
  lastVisit: { when: Date; title: string } | null;
};

async function customerHistory(customerId: string, leadId: string): Promise<CustomerHistory> {
  const [customer, leads, paid, lastVisit] = await Promise.all([
    db.customer.findUniqueOrThrow({
      where: { id: customerId },
      select: { createdAt: true },
    }),
    db.lead.findMany({
      where: { customerId, id: { not: leadId } },
      select: {
        title: true,
        stage: true,
        lostReason: true,
        stageChangedAt: true,
        jobs: { select: { status: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    db.payment.aggregate({
      where: {
        status: "succeeded",
        OR: [{ proposal: { lead: { customerId } } }, { job: { lead: { customerId } } }],
      },
      _sum: { amountCents: true },
    }),
    db.visit.findFirst({
      where: { lead: { customerId }, leadId: { not: leadId }, status: "done" },
      orderBy: { start: "desc" },
      select: { start: true, lead: { select: { title: true } } },
    }),
  ]);
  return {
    customerSince: customer.createdAt,
    otherRequests: leads.length,
    jobsDone: leads.reduce((n, l) => n + l.jobs.filter((j) => ["completed", "invoiced", "paid"].includes(j.status)).length, 0),
    paidCents: paid._sum.amountCents ?? 0,
    declined: leads
      .filter((l) => l.stage === "estimate_declined" || l.stage === "lost")
      .slice(0, 3)
      .map((l) => ({
        title: l.title,
        reason: l.lostReason,
        when: l.stageChangedAt,
      })),
    lastVisit: lastVisit ? { when: lastVisit.start, title: lastVisit.lead.title } : null,
  };
}

/** Typical service life (years) of the main equipment per trade, for the "likely due" hint. */
const LIFESPAN: Record<Trade, { thing: string; years: number }> = {
  hvac: { thing: "furnace / AC", years: 15 },
  plumbing: { thing: "water heater", years: 10 },
  electrical: { thing: "electrical panel", years: 40 },
};

/**
 * A few plain-language things worth knowing before the door opens. Only claims the data supports; anything
 * inferred says so ("if original").
 */
export function talkingPoints(trade: Trade, facts: PropertyFacts | null, history: CustomerHistory, now = new Date()): string[] {
  const out: string[] = [];
  const year = now.getFullYear();
  if (facts?.yearBuilt) {
    const age = year - facts.yearBuilt;
    const life = LIFESPAN[trade];
    if (age >= life.years)
      out.push(
        `Built in ${facts.yearBuilt}. If the ${life.thing} is original, it's about ${age} years old (typical life ~${life.years}). Show the replacement option.`,
      );
  }
  if (facts?.lastSaleDate) {
    const months = (now.getTime() - new Date(facts.lastSaleDate).getTime()) / (30.4 * 24 * 3_600_000);
    if (months >= 0 && months <= 24)
      out.push(
        `Bought ${months < 1 ? "this month" : `${Math.round(months)} months ago`}. New owners often want to fix things once, properly. Lead with the better/best options.`,
      );
  }
  const value = facts?.valueEstimate ?? facts?.lastSalePrice;
  if (value && value >= 600_000) out.push("Higher-value home: expect interest in premium equipment and comfort upgrades.");
  if (facts?.squareFootage && facts.squareFootage >= 3000 && trade === "hvac")
    out.push(`${facts.squareFootage.toLocaleString()} sq ft: check whether one system really covers both floors (zoning or a second unit).`);
  if (facts?.ownerOccupied === false) out.push("Records say the owner doesn't live here (rental?). Confirm who approves and pays.");
  if (history.jobsDone > 0)
    out.push(`Returning customer: ${history.jobsDone} job${history.jobsDone === 1 ? "" : "s"} done before. Thank them for coming back.`);
  for (const d of history.declined.slice(0, 1))
    out.push(`Declined "${d.title}" before${d.reason ? ` (${d.reason.toLowerCase()})` : ""}. Worth asking if that's still on their mind.`);
  return out;
}

/** Everything the tech's appointment card shows beyond the visit itself. */
export async function visitBrief(actor: Actor, visitId: string) {
  const visit = await getVisit(actor, visitId);
  const [facts, history] = await Promise.all([
    visit.lead.propertyId ? propertyFacts(visit.lead.propertyId) : Promise.resolve(null),
    customerHistory(visit.lead.customerId, visit.leadId),
  ]);
  return {
    facts,
    history,
    points: talkingPoints(visit.lead.trade, facts, history),
  };
}
