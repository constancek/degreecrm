// npm run seed — resets and loads demo data: owner + 2 techs, 5 customers, 3 leads, a sample price
// book, T&C v1 and one full proposal (sent, link printed below). Tax rates come from a migration.
import "dotenv/config";
import { db } from "@/lib/db";
import type { LeadStage } from "@/generated/prisma/enums";
import { PLACEHOLDER_KEY_TERMS, PLACEHOLDER_TERMS } from "@/lib/services/terms";
import { createProposalDraft, sendProposal } from "@/lib/services/proposals";

const HOUR = 3_600_000;

async function main() {
  if (process.env.VERCEL_ENV === "production") throw new Error("Refusing to seed production");

  await db.$transaction([
    db.lineItem.deleteMany(),
    db.proposalOption.deleteMany(),
    db.proposal.deleteMany(),
    db.leadPhoto.deleteMany(),
    db.priceBookItem.deleteMany(),
    db.termsVersion.deleteMany(),
    db.setting.deleteMany(),
    db.activity.deleteMany(),
    db.outboxEvent.deleteMany(),
    db.oAuthToken.deleteMany(),
    db.oAuthCode.deleteMany(),
    db.oAuthClient.deleteMany(),
    db.lead.deleteMany(),
    db.property.deleteMany(),
    db.customer.deleteMany(),
    db.user.deleteMany(),
  ]);

  const ownerEmail = process.env.OWNER_EMAIL?.toLowerCase() || "owner@example.com";
  const owner = await db.user.create({ data: { name: "Owner", email: ownerEmail, role: "owner", phone: "+15135550100" } });
  const mike = await db.user.create({ data: { name: "Mike Reyes", email: "tech1@example.com", role: "tech", phone: "+15135550101" } });
  const dana = await db.user.create({ data: { name: "Dana Cole", email: "tech2@example.com", role: "tech", phone: "+15135550102" } });

  const customers = [
    { name: "Sarah Mitchell", phone: "+15135550111", email: "sarah.m@example.com", street: "3412 Erie Ave", zip: "45208" },
    { name: "James & Linda Porter", phone: "+15135550112", email: "porters@example.com", street: "6120 Ridge Ave", zip: "45213" },
    { name: "Oakley Coffee Co.", phone: "+15135550113", email: "manager@oakleycoffee.example", street: "3071 Madison Rd", zip: "45209", type: "commercial" as const },
    { name: "Priya Shah", phone: "+15135550114", email: "priya.shah@example.com", street: "1520 Herschel Ave", zip: "45208" },
    { name: "Tom Becker", phone: "+15135550115", email: null, street: "4410 Hamilton Ave", zip: "45223" },
  ];
  const created = [];
  for (const c of customers) {
    const customer = await db.customer.create({
      data: {
        name: c.name,
        phone: c.phone,
        email: c.email,
        type: c.type ?? "residential",
        properties: { create: { street: c.street, zip: c.zip, city: "Cincinnati", state: "OH", county: "Hamilton" } },
      },
      include: { properties: true },
    });
    created.push(customer);
  }

  const leads: {
    c: number;
    title: string;
    trade: "hvac" | "plumbing" | "electrical";
    stage: LeadStage;
    tech: string | null;
    hoursAgo: number;
    notes: string;
  }[] = [
    { c: 0, title: "AC not cooling upstairs", trade: "hvac", stage: "new", tech: null, hoursAgo: 2, notes: "Upstairs 82°F, downstairs fine. 14-year-old Trane." },
    { c: 1, title: "Water heater leaking from bottom", trade: "plumbing", stage: "estimate_scheduled", tech: mike.id, hoursAgo: 30, notes: "50 gal gas, basement. Wants replacement options." },
    { c: 2, title: "Panel upgrade for new espresso machines", trade: "electrical", stage: "estimate_sent", tech: dana.id, hoursAgo: 96, notes: "Needs two 240V 30A circuits. 100A panel today." },
  ];

  for (const l of leads) {
    const customer = created[l.c]!;
    const at = new Date(Date.now() - l.hoursAgo * HOUR);
    const lead = await db.lead.create({
      data: {
        customerId: customer.id,
        propertyId: customer.properties[0]!.id,
        title: l.title,
        trade: l.trade,
        source: "phone",
        stage: l.stage,
        notes: l.notes,
        assignedToId: l.tech,
        createdAt: at,
        stageChangedAt: at,
        lastActivityAt: at,
      },
    });
    await db.activity.create({ data: { type: "lead_created", leadId: lead.id, customerId: customer.id, userId: owner.id, createdAt: at } });
    if (l.stage !== "new") {
      await db.activity.create({
        data: { type: "stage_changed", leadId: lead.id, userId: owner.id, data: { from: "new", to: l.stage }, createdAt: at },
      });
    }
  }

  // ---- Price book (samples — the real one is entered in the app) ----
  const book = await Promise.all(
    [
      { trade: "plumbing", category: "equipment", name: "50 gal gas water heater (standard)", unit: "ea", costCents: 72000, priceCents: 129500 },
      { trade: "plumbing", category: "equipment", name: "50 gal gas water heater (high-efficiency)", unit: "ea", costCents: 115000, priceCents: 199500 },
      { trade: "plumbing", category: "equipment", name: "Tankless gas water heater 199k BTU", unit: "ea", costCents: 160000, priceCents: 329500 },
      { trade: "plumbing", category: "material", name: "Expansion tank 2 gal", unit: "ea", costCents: 4500, priceCents: 14500 },
      { trade: "plumbing", category: "material", name: "Gas flex connector, drain pan and fittings", unit: "ea", costCents: 6000, priceCents: 16500 },
      { trade: "plumbing", category: "labor", name: "Plumbing labor", unit: "hr", costCents: 4500, priceCents: 12500 },
      { trade: "plumbing", category: "fee", name: "Haul-away and disposal", unit: "ea", costCents: 2000, priceCents: 9500 },
      { trade: "hvac", category: "labor", name: "HVAC labor", unit: "hr", costCents: 5000, priceCents: 14500 },
      { trade: "electrical", category: "labor", name: "Electrician labor", unit: "hr", costCents: 5000, priceCents: 13500 },
      { trade: null, category: "fee", name: "Permit and inspection", unit: "ea", costCents: 9000, priceCents: 15000 },
    ].map((i) => db.priceBookItem.create({ data: i as never })),
  );
  const id = (name: string) => book.find((b) => b.name === name)!.id;

  await db.termsVersion.create({ data: { version: 1, body: PLACEHOLDER_TERMS, keyTerms: PLACEHOLDER_KEY_TERMS, createdById: owner.id } });

  // ---- One full proposal on the water heater lead, sent ----
  const ownerActor = { kind: "user" as const, id: owner.id, role: "owner" as const, name: owner.name, email: owner.email };
  const wh = await db.lead.findFirstOrThrow({ where: { title: { startsWith: "Water heater" } } });
  const line = (name: string, qty = 1) => ({ description: name, qty, unit: "ea", priceBookItemId: id(name), isOptional: false });
  const labor = (qty: number) => ({ description: "Installation labor", qty, unit: "hr", priceBookItemId: id("Plumbing labor"), isOptional: false });
  const proposal = await createProposalDraft(ownerActor, wh.id, {
    summary:
      "Your 50-gallon gas water heater is leaking from the tank, which means it has to be replaced. Here are three ways to do it, from a like-for-like swap to an endless-hot-water tankless system.",
    recommendedTier: "better",
    assumptions: ["Existing gas line and venting can be reused", "Clear access to the basement"],
    exclusions: ["Drywall or flooring repairs", "Gas line upgrades beyond the connector"],
    options: [
      {
        tier: "good",
        title: "Standard 50-gallon replacement",
        summary: "Like-for-like replacement of your current heater.",
        highlights: ["Same-day install in most cases", "Old heater hauled away", "Permit and inspection handled", "1-year labor warranty"],
        warrantyText: "1-year labor; 6-year manufacturer tank warranty",
        lineItems: [line("50 gal gas water heater (standard)"), line("Gas flex connector, drain pan and fittings"), line("Expansion tank 2 gal"), labor(3), line("Haul-away and disposal"), line("Permit and inspection")],
      },
      {
        tier: "better",
        title: "High-efficiency 50-gallon",
        summary: "A higher-efficiency tank that recovers faster and costs less to run.",
        highlights: ["Lower gas bills than a standard tank", "Faster hot-water recovery", "Old heater hauled away", "2-year labor warranty"],
        warrantyText: "2-year labor; 10-year manufacturer tank warranty",
        lineItems: [line("50 gal gas water heater (high-efficiency)"), line("Gas flex connector, drain pan and fittings"), line("Expansion tank 2 gal"), labor(3.5), line("Haul-away and disposal"), line("Permit and inspection")],
      },
      {
        tier: "best",
        title: "Tankless: endless hot water",
        summary: "A wall-mounted tankless heater that never runs out and frees up floor space.",
        highlights: ["Never run out of hot water", "Up to 20-year life", "Frees up basement space", "5-year labor warranty"],
        warrantyText: "5-year labor; 12-year manufacturer heat exchanger warranty",
        lineItems: [
          line("Tankless gas water heater 199k BTU"),
          line("Gas flex connector, drain pan and fittings"),
          labor(8),
          line("Haul-away and disposal"),
          line("Permit and inspection"),
          { description: "Annual tankless descaling service", qty: 1, unit: "ea", priceBookItemId: null, isOptional: true },
        ],
      },
    ],
  });
  // The optional add-on needs a price before sending.
  await db.lineItem.updateMany({ where: { description: "Annual tankless descaling service" }, data: { unitCents: 17500, needsPrice: false } });
  const sent = await sendProposal(ownerActor, proposal.id, { textCustomer: false });

  console.log(`Seeded: 3 staff (owner ${ownerEmail}), ${created.length} customers, ${leads.length} leads, ${book.length} price book items`);
  console.log(`Demo proposal (phone check: 0112): ${sent.link}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
