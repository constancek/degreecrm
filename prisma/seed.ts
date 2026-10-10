// npm run seed — resets and loads demo data: owner + 2 techs, 5 customers, 3 leads.
// (The "1 full proposal" from SPEC.md arrives with the Proposal models in Phase 2.)
import "dotenv/config";
import { db } from "@/lib/db";
import type { LeadStage } from "@/generated/prisma/enums";

const HOUR = 3_600_000;

async function main() {
  if (process.env.VERCEL_ENV === "production") throw new Error("Refusing to seed production");

  await db.$transaction([
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
        properties: { create: { street: c.street, zip: c.zip, city: "Cincinnati", state: "OH" } },
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

  console.log(`Seeded: 3 staff (owner ${ownerEmail}), ${created.length} customers, ${leads.length} leads`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
