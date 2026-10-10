import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createMockDiscordClient, setDiscordClient } from "@/lib/integrations/discord";
import { createMockGeocodingClient, setGeocodingClient } from "@/lib/integrations/google-maps";
import { assignLead, changeStage, createLead, getLead, listBoardLeads, logNote } from "@/lib/services/leads";
import { processOutbox } from "@/lib/services/outbox";
import { submitWebLead } from "@/lib/services/intake";
import { isAllowedToSignIn, upsertStaffUser } from "@/lib/services/users";
import { runTick } from "@/lib/jobs/tick";
import { setDiscordStages } from "@/lib/services/settings";
import { ForbiddenError, NotFoundError } from "@/lib/services/actor";
import { exchangeToken, issueAuthorizationCode, registerClient, validateAuthorizeRequest, verifyAccessToken } from "@/lib/oauth/server";
import { pkceChallenge } from "@/lib/crypto";
import { makeUser, resetDb } from "./helpers";

const discord = createMockDiscordClient();
setDiscordClient(discord);
const geocoder = createMockGeocodingClient({ lat: 39.1, lng: -84.5, county: "Hamilton County", state: "OH" });
setGeocodingClient(geocoder);

beforeEach(async () => {
  await resetDb();
  discord.sent.length = 0;
});
afterAll(() => db.$disconnect());

const baseLead = {
  customer: { name: "Pat Jones", phone: "513-555-0123" },
  property: { street: "1 Vine St", zip: "45202" },
  title: "No heat",
  trade: "hvac" as const,
};

describe("leads", () => {
  it("creates a lead, timeline entry and Discord post; reuses the customer by phone", async () => {
    const owner = await makeUser("owner", "owner@test.dev");
    const a = await createLead(owner, baseLead);
    const b = await createLead(owner, { ...baseLead, customer: { name: "Pat J.", phone: "(513) 555-0123" }, title: "AC too" });
    expect(b.customerId).toBe(a.customerId);
    expect(b.propertyId).toBe(a.propertyId);

    const full = await getLead(owner, a.id);
    expect(full.activities.map((x) => x.type)).toContain("lead_created");

    await processOutbox();
    expect(discord.sent).toHaveLength(2);
    expect(discord.sent[0]!.embeds![0]!.title).toBe("New request: No heat");
  });

  it("scopes techs to their own leads and stops them assigning", async () => {
    const owner = await makeUser("owner", "owner@test.dev");
    const tech = await makeUser("tech", "tech@test.dev");
    const mine = await createLead(owner, { ...baseLead, assignedToId: tech.id });
    const other = await createLead(owner, { ...baseLead, title: "Other" });

    expect((await listBoardLeads(tech)).map((l) => l.id)).toEqual([mine.id]);
    await expect(getLead(tech, other.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(assignLead(tech, mine.id, null)).rejects.toBeInstanceOf(ForbiddenError);

    // A tech-created lead lands on the tech's own board.
    const created = await createLead(tech, { ...baseLead, title: "Found on site" });
    expect(created.assignedToId).toBe(tech.id);
  });

  it("records stage changes and posts only for Discord stages", async () => {
    const owner = await makeUser("owner", "owner@test.dev");
    const lead = await createLead(owner, baseLead);
    await processOutbox();
    discord.sent.length = 0;

    await changeStage(owner, lead.id, "follow_up");
    await changeStage(owner, lead.id, "estimate_scheduled");
    await changeStage(owner, lead.id, "estimate_scheduled"); // no-op
    await logNote(owner, lead.id, "Booked for Tue 9am");
    await processOutbox();

    expect(discord.sent.map((m) => m.embeds![0]!.title)).toEqual(["Scheduled: No heat"]);
    const full = await getLead(owner, lead.id);
    expect(full.activities.filter((a) => a.type === "stage_changed")).toHaveLength(2);
    expect(full.activities[0]!.body).toBe("Booked for Tue 9am");
  });

  it("respects the owner's Discord stage toggles", async () => {
    const owner = await makeUser("owner", "owner@test.dev");
    const tech = await makeUser("tech", "tech@test.dev");
    await expect(setDiscordStages(tech, [])).rejects.toBeInstanceOf(ForbiddenError);
    await setDiscordStages(owner, ["job_scheduled"]);

    const lead = await createLead(owner, baseLead); // "new" no longer posts
    await changeStage(owner, lead.id, "estimate_scheduled"); // nor this
    await changeStage(owner, lead.id, "job_scheduled");
    await processOutbox();
    expect(discord.sent.map((m) => m.embeds![0]!.title)).toEqual(["Job scheduled: No heat"]);
  });

  it("retries Discord failures with backoff", async () => {
    const owner = await makeUser("owner", "owner@test.dev");
    setDiscordClient({ send: async () => Promise.reject(new Error("discord down")) });
    await createLead(owner, baseLead);
    expect(await processOutbox()).toEqual({ sent: 0, failed: 1 });
    const row = await db.outboxEvent.findFirstOrThrow();
    expect(row.status).toBe("pending");
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    setDiscordClient(discord);
  });
});

describe("property coordinates", () => {
  it("keeps autocomplete coordinates and geocodes addresses that arrive without them", async () => {
    const owner = await makeUser("owner", "owner@test.dev");
    geocoder.calls.length = 0;

    const picked = await createLead(owner, { ...baseLead, property: { street: "3412 Erie Ave", lat: 39.14, lng: -84.43 } });
    expect(await db.property.findUniqueOrThrow({ where: { id: picked.propertyId! } })).toMatchObject({ lat: 39.14, lng: -84.43 });
    expect(geocoder.calls).toEqual([]);

    const typed = await createLead(owner, { ...baseLead, customer: { name: "Other", phone: "5135550999" } });
    expect(geocoder.calls).toEqual(["1 Vine St, Cincinnati, OH, 45202"]);
    expect(await db.property.findUniqueOrThrow({ where: { id: typed.propertyId! } })).toMatchObject({ lat: 39.1, lng: -84.5 });
  });
});

describe("automation tick", () => {
  it("moves stale new leads to follow_up and idle leads to lost", async () => {
    const owner = await makeUser("owner", "owner@test.dev");
    const fresh = await createLead(owner, baseLead);
    const stale = await createLead(owner, { ...baseLead, title: "Stale" });
    const idle = await createLead(owner, { ...baseLead, title: "Idle" });
    await db.lead.update({ where: { id: stale.id }, data: { stageChangedAt: new Date(Date.now() - 25 * 3_600_000) } });
    await db.lead.update({
      where: { id: idle.id },
      data: { stage: "estimate_sent", lastActivityAt: new Date(Date.now() - 61 * 86_400_000) },
    });

    const result = await runTick();
    expect(result.followUp).toBe(1);
    expect(result.lost).toBe(1);
    expect((await db.lead.findUniqueOrThrow({ where: { id: fresh.id } })).stage).toBe("new");
    expect((await db.lead.findUniqueOrThrow({ where: { id: stale.id } })).stage).toBe("follow_up");
    const lost = await db.lead.findUniqueOrThrow({ where: { id: idle.id } });
    expect(lost.stage).toBe("lost");
    expect(lost.lostReason).toBe("No activity for 60 days");
  });
});

describe("staff sign-in", () => {
  it("allows owner + allow-list, gives OWNER_EMAIL the owner role, blocks deactivated users", async () => {
    expect(await isAllowedToSignIn("owner@test.dev")).toBe(true);
    expect(await isAllowedToSignIn("TECH@test.dev")).toBe(true);
    expect(await isAllowedToSignIn("stranger@test.dev")).toBe(false);

    expect((await upsertStaffUser({ email: "owner@test.dev" })).role).toBe("owner");
    const tech = await upsertStaffUser({ email: "tech@test.dev", name: "Tech" });
    expect(tech.role).toBe("tech");
    await db.user.update({ where: { id: tech.id }, data: { active: false } });
    expect(await isAllowedToSignIn("tech@test.dev")).toBe(false);
  });
});

describe("website intake", () => {
  it("creates a web_form lead and rate-limits by IP", async () => {
    const meta = { ip: "203.0.113.9", userAgent: "test", form: "website" };
    const lead = await submitWebLead({ name: "Ana", phone: "5135550199", message: "Toilet running nonstop" }, meta);
    expect(lead.source).toBe("web_form");
    expect(lead.trade).toBe("plumbing");
    for (let i = 0; i < 4; i++) await submitWebLead({ name: "Ana", phone: "5135550199" }, meta);
    await expect(submitWebLead({ name: "Ana", phone: "5135550199" }, meta)).rejects.toThrow(/Too many/);
  });
});

describe("oauth for MCP", () => {
  it("runs register → authorize → token → refresh with PKCE and one-time codes", async () => {
    const tech = await makeUser("tech", "tech@test.dev");
    const reg = await registerClient({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });

    const verifier = "v".repeat(50);
    const v = await validateAuthorizeRequest({
      client_id: reg.client_id,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      response_type: "code",
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      state: "xyz",
      resource: "https://app.test/mcp",
    });
    if (!("ok" in v)) throw new Error("authorize request rejected");
    const redirect = new URL(await issueAuthorizationCode(tech, v.ok));
    expect(redirect.searchParams.get("state")).toBe("xyz");
    const code = redirect.searchParams.get("code")!;

    const form = (o: Record<string, string>) => new URLSearchParams(o);
    await expect(
      exchangeToken(form({ grant_type: "authorization_code", client_id: reg.client_id, code, code_verifier: "wrong".repeat(10) })),
    ).rejects.toThrow(/PKCE/);

    // The failed attempt above already consumed the code (codes are single-use).
    const v2 = await validateAuthorizeRequest({ ...Object.fromEntries(redirect.searchParams), client_id: reg.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", response_type: "code", code_challenge: pkceChallenge(verifier), code_challenge_method: "S256" });
    if (!("ok" in v2)) throw new Error("rejected");
    const code2 = new URL(await issueAuthorizationCode(tech, v2.ok)).searchParams.get("code")!;
    const tokens = await exchangeToken(form({ grant_type: "authorization_code", client_id: reg.client_id, code: code2, code_verifier: verifier }));

    const actor = await verifyAccessToken(`Bearer ${tokens.access_token}`);
    expect(actor).toMatchObject({ id: tech.id, role: "tech", via: "mcp" });

    const refreshed = await exchangeToken(form({ grant_type: "refresh_token", client_id: reg.client_id, refresh_token: tokens.refresh_token }));
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    // Old refresh token is rotated out.
    await expect(
      exchangeToken(form({ grant_type: "refresh_token", client_id: reg.client_id, refresh_token: tokens.refresh_token })),
    ).rejects.toThrow(/expired or revoked/);
    expect(await verifyAccessToken("Bearer nope")).toBeNull();
  });

  it("rejects unregistered redirect URIs without redirecting", async () => {
    const reg = await registerClient({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
    const v = await validateAuthorizeRequest({ client_id: reg.client_id, redirect_uri: "https://evil.example/cb" });
    expect(v).toHaveProperty("fatal");
  });
});
