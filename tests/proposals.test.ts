import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createMockDiscordClient, setDiscordClient } from "@/lib/integrations/discord";
import { createMockGeocodingClient, setGeocodingClient } from "@/lib/integrations/google-maps";
import { createMockQuoClient, setQuoClient } from "@/lib/integrations/quo";
import { createMemoryBlobStore, setBlobStore } from "@/lib/integrations/blob";
import { createMockDrafter, setDrafter } from "@/lib/integrations/claude";
import { createLead } from "@/lib/services/leads";
import { savePriceBookItem } from "@/lib/services/pricebook";
import { saveTerms } from "@/lib/services/terms";
import { DEFAULT_TAX_RATES, saveTaxRates, taxForProperty } from "@/lib/services/tax";
import {
  createProposalDraft,
  createRevision,
  generateProposal,
  getProposal,
  saveProposal,
  sendProposal,
  toEditInput,
} from "@/lib/services/proposals";
import { checkGate, clientState, gateCookieValid, gateCookieValue, loadByToken, recordView, selectOption } from "@/lib/services/client-proposals";
import { processOutbox } from "@/lib/services/outbox";
import { ForbiddenError, ValidationError } from "@/lib/services/actor";
import { makeUser, resetDb } from "./helpers";

const discord = createMockDiscordClient();
const quo = createMockQuoClient();
const blob = createMemoryBlobStore();
const drafter = createMockDrafter();
setDiscordClient(discord);
setQuoClient(quo);
setBlobStore(blob);
setDrafter(drafter);
setGeocodingClient(createMockGeocodingClient({ lat: 39.27, lng: -84.4, county: "Butler County", state: "OH" }));

beforeEach(async () => {
  await resetDb();
  await db.$executeRawUnsafe(`TRUNCATE "TaxRate", "PriceBookItem", "TermsVersion" CASCADE`);
  await saveTaxRates({ kind: "system", label: "test" }, DEFAULT_TAX_RATES);
  discord.sent.length = 0;
  quo.sent.length = 0;
  drafter.calls.length = 0;
});
afterAll(() => db.$disconnect());

async function setup() {
  const owner = await makeUser("owner", "owner@test.dev");
  const tech = await makeUser("tech", "tech@test.dev");
  const heater = await savePriceBookItem(owner, { trade: "plumbing", category: "equipment", name: "50 gal heater", unit: "ea", costCents: 70000, priceCents: 130000 });
  const labor = await savePriceBookItem(owner, { trade: "plumbing", category: "labor", name: "Labor", unit: "hr", costCents: 4500, priceCents: 12500 });
  const permit = await savePriceBookItem(owner, { trade: null, category: "fee", name: "Permit", unit: "ea", costCents: null, priceCents: 15000 });
  await saveTerms(owner, { body: "# Terms\n\n" + "Standard terms apply to all work performed. ".repeat(3), keyTerms: "{deposit} deposit due.\nValid until {expires}." });
  const lead = await createLead(owner, {
    customer: { name: "Pat Jones", phone: "513-555-0123", email: "pat@example.com" },
    property: { street: "1 Vine St", zip: "45202", county: "Hamilton County" },
    title: "Water heater leaking",
    trade: "plumbing",
    assignedToId: tech.id,
  });
  return { owner, tech, lead, heater, labor, permit };
}

const option = (tier: "good" | "better" | "best", lines: { description: string; qty: number; priceBookItemId: string | null; unitCents?: number }[]) => ({
  tier,
  title: `${tier} option`,
  highlights: ["One", "Two", "Three", "Four"],
  lineItems: lines.map((l) => ({ ...l, unit: "ea", isOptional: false })),
});

describe("drafting", () => {
  it("takes prices only from the price book, flags the rest, and applies the county tax", async () => {
    const { tech, lead, heater, labor } = await setup();
    const p = await createProposalDraft(tech, lead.id, {
      summary: "Three ways to fix it",
      recommendedTier: "better",
      options: [
        // Claude can't set prices: unitCents is ignored for drafts.
        option("good", [{ description: "Heater", qty: 1, priceBookItemId: heater.id, unitCents: 1 }, { description: "Labor", qty: 3, priceBookItemId: labor.id }]),
        option("better", [{ description: "Heater", qty: 1, priceBookItemId: heater.id }]),
        option("best", [{ description: "Mystery part", qty: 1, priceBookItemId: null, unitCents: 99999 }]),
      ],
    });
    expect(p.version).toBe(1);
    expect(p.taxRateBps).toBe(780);
    expect(p.taxLabel).toContain("Hamilton County, OH");
    const good = p.options.find((o) => o.tier === "good")!;
    expect(good.lineItems.map((l) => l.unitCents)).toEqual([130000, 12500]);
    expect(good.subtotalCents).toBe(167500);
    expect(good.taxCents).toBe(13065);
    const best = p.options.find((o) => o.tier === "best")!;
    expect(best.lineItems[0]).toMatchObject({ unitCents: 0, needsPrice: true, priceBookItemId: null });
  });

  it("rejects anything but exactly good, better and best", async () => {
    const { owner, lead } = await setup();
    await expect(
      createProposalDraft(owner, lead.id, { options: [option("good", []), option("good", []), option("best", [])] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("drafts with Claude: stores photos, passes the trade's price book, saves the draft", async () => {
    const { owner, lead, heater, permit } = await setup();
    const p = await generateProposal(owner, lead.id, { trade: "plumbing", notes: "Tank is leaking at the bottom seam." }, [
      { body: Buffer.from("jpegdata"), contentType: "image/jpeg" },
    ]);
    expect(drafter.calls).toHaveLength(1);
    const call = drafter.calls[0]!;
    // The plumbing book plus shared items: heater, labor, permit.
    expect(call.priceBook).toHaveLength(3);
    expect(call.priceBook.map((i) => i.id)).toEqual(expect.arrayContaining([heater.id, permit.id]));
    expect(call.photos).toHaveLength(1);
    expect(blob.files.size).toBe(1);
    expect(await db.leadPhoto.count({ where: { leadId: lead.id } })).toBe(1);
    expect(p.aiModel).toBe("mock");
    expect(p.options).toHaveLength(3);
  });

  it("falls back to geocoding for the county when the address didn't include one", async () => {
    const { owner } = await setup();
    const lead = await createLead(owner, { customer: { name: "Sam" }, property: { street: "9 Main St", city: "Hamilton" }, title: "x", trade: "hvac" });
    expect(await taxForProperty(lead.propertyId)).toEqual({ rateBps: 650, label: "Butler County, OH (6.5%)" });
  });
});

describe("editing and sending", () => {
  async function draft() {
    const ctx = await setup();
    const p = await createProposalDraft(ctx.owner, ctx.lead.id, {
      summary: "Three ways",
      options: [
        option("good", [{ description: "Heater", qty: 1, priceBookItemId: ctx.heater.id }]),
        option("better", [{ description: "Heater", qty: 1, priceBookItemId: ctx.heater.id }, { description: "Permit", qty: 1, priceBookItemId: ctx.permit.id }]),
        option("best", [{ description: "Custom part", qty: 1, priceBookItemId: null }]),
      ],
    });
    return { ...ctx, p };
  }

  it("won't send with unpriced lines; the owner prices them, then sends and texts the link", async () => {
    const { owner, tech, lead, p } = await draft();
    await expect(sendProposal(owner, p.id, { textCustomer: true })).rejects.toThrow(/need a price/);

    const edit = toEditInput(p);
    edit.options[2]!.lineItems[0]!.unitCents = 45000; // owner sets the custom price
    const saved = await saveProposal(owner, p.id, edit);
    expect(saved.options[2]!.lineItems[0]).toMatchObject({ unitCents: 45000, needsPrice: false });

    await expect(sendProposal(tech, p.id, { textCustomer: true })).rejects.toBeInstanceOf(ForbiddenError);
    const res = await sendProposal(owner, p.id, { textCustomer: true });
    expect(res.texted).toBe(true);
    expect(res.link).toMatch(/\/p\/[A-Za-z0-9_-]{32}$/);
    expect(quo.sent[0]).toMatchObject({ to: "+15135550123" });
    expect(quo.sent[0]!.content).toContain(res.link);
    expect(quo.sent[0]!.content).toContain("Reply STOP");

    const sent = await getProposal(owner, p.id);
    expect(sent.status).toBe("sent");
    expect(sent.terms?.version).toBe(1);
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).stage).toBe("estimate_sent");
    await expect(saveProposal(owner, p.id, edit)).rejects.toThrow(/Create a revision/);
  });

  it("a revision copies prices, and sending it supersedes the old link", async () => {
    const { owner, p } = await draft();
    const edit = toEditInput(p);
    edit.options[2]!.lineItems[0]!.unitCents = 45000;
    await saveProposal(owner, p.id, edit);
    const first = await sendProposal(owner, p.id, { textCustomer: false });

    const rev = await createRevision(owner, p.id);
    expect(rev.version).toBe(2);
    expect(rev.status).toBe("draft");
    expect(rev.options[2]!.lineItems[0]!.unitCents).toBe(45000);
    await sendProposal(owner, rev.id, { textCustomer: false });

    const old = await loadByToken(first.link.split("/p/")[1]!);
    expect(clientState(old!)).toBe("superseded");
  });
});

describe("client page", () => {
  async function sent() {
    const ctx = await setup();
    const p = await createProposalDraft(ctx.owner, ctx.lead.id, {
      summary: "Three ways",
      options: ["good", "better", "best"].map((t) => option(t as never, [{ description: "Heater", qty: 1, priceBookItemId: ctx.heater.id }])),
    });
    const { link } = await sendProposal(ctx.owner, p.id, { textCustomer: false });
    const token = link.split("/p/")[1]!;
    return { ...ctx, token, p: (await loadByToken(token))! };
  }

  it("gate: last 4 of the phone, locks after 5 wrong answers and alerts Discord", async () => {
    const { p, token } = await sent();
    expect(await checkGate(p, "0123", { ip: null })).toEqual({ ok: true });
    expect(gateCookieValid(p.id, token, gateCookieValue(p.id, token))).toBe(true);
    expect(gateCookieValid(p.id, token, "forged")).toBe(false);

    for (let i = 1; i <= 4; i++) {
      const fresh = (await loadByToken(token))!;
      expect(await checkGate(fresh, "9999", { ip: "1.2.3.4" })).toEqual({ ok: false, locked: false, remaining: 5 - i });
    }
    const last = await checkGate((await loadByToken(token))!, "9999", { ip: "1.2.3.4" });
    expect(last).toEqual({ ok: false, locked: true, remaining: 0 });
    const locked = (await loadByToken(token))!;
    expect(clientState(locked)).toBe("locked");
    expect(await checkGate(locked, "0123", { ip: null })).toMatchObject({ ok: false, locked: true });
    await processOutbox();
    expect(discord.sent.some((m) => m.content?.includes("locked"))).toBe(true);
  });

  it("tracks views and the chosen option", async () => {
    const { p, token, owner } = await sent();
    await recordView(p, { ip: "1.2.3.4", userAgent: "test" });
    await recordView((await loadByToken(token))!, { ip: "1.2.3.4", userAgent: "test" });
    await selectOption((await loadByToken(token))!, p.options[1]!.id, { ip: null });
    const after = await getProposal(owner, p.id);
    expect(after).toMatchObject({ viewCount: 2, status: "viewed", selectedOptionId: p.options[1]!.id });
    // One timeline entry per 30 minutes of viewing, not per page load.
    expect(await db.activity.count({ where: { type: "proposal_viewed", leadId: p.leadId } })).toBe(1);
  });

  it("expired links say so", async () => {
    const { p, token } = await sent();
    await db.proposal.update({ where: { id: p.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(clientState((await loadByToken(token))!)).toBe("expired");
  });
});
