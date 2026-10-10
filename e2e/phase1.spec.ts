import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const ORIGIN = "http://localhost:3100";

test("owner signs in, creates a lead, moves it through the pipeline and adds a note", async ({ page }) => {
  await login(page);

  // Seeded board: 11 columns (Lost hidden), seeded leads in place.
  await expect(page.locator("section[data-stage]")).toHaveCount(11);
  await expect(page.locator('section[data-stage="new"]')).toContainText("Sarah Mitchell");

  await page.getByRole("link", { name: "New lead" }).first().click();
  await page.getByLabel("Name").fill("Grace Hopper");
  await page.getByLabel("Phone").fill("513-555-0177");
  await page.getByLabel("Street address").fill("200 W 4th St");
  await page.getByLabel("ZIP").fill("45202");
  await page.getByLabel("What's the job?").fill("Furnace short cycling");
  await page.getByLabel("Assign to").selectOption({ label: "Mike Reyes" });
  await page.getByRole("button", { name: "Create lead" }).click();

  await expect(page.getByRole("heading", { name: "Furnace short cycling" })).toBeVisible();
  await expect(page.getByText("(513) 555-0177")).toBeVisible();
  const leadUrl = page.url();

  await page.getByLabel("Move to stage").selectOption("estimate_scheduled");
  await page.getByRole("button", { name: "Update stage" }).click();
  await expect(page.getByText("moved it from New to Estimate scheduled")).toBeVisible();

  await page.getByLabel("Add a note").fill("Booked Tuesday 9–11am");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByRole("list", { name: "Activity timeline" })).toContainText("Booked Tuesday 9–11am");

  await page.goto("/pipeline");
  await expect(page.locator('section[data-stage="estimate_scheduled"]')).toContainText("Grace Hopper");

  // Marking lost requires a reason and hides it from the default board.
  await page.goto(leadUrl);
  await page.getByLabel("Move to stage").selectOption("lost");
  await page.getByLabel("Lost reason").fill("Went with another company");
  await page.getByRole("button", { name: "Update stage" }).click();
  await expect(page.getByText("Reason: Went with another company")).toBeVisible();
});

test("a tech only sees their own leads", async ({ page }) => {
  await login(page, "tech1@example.com");
  await expect(page.getByText("assigned to you")).toBeVisible();
  await expect(page.locator("[data-lead-id]")).toHaveCount(1);
  await expect(page.locator("[data-lead-id]")).toContainText("James & Linda Porter");
});

test("host routing: go. serves client pages only, with noindex", async ({ request }) => {
  // Node doesn't resolve *.localhost, so send the go. Host header to the same server.
  const asClient = (path: string) =>
    request.get(`${ORIGIN}${path}`, { headers: { host: "go.localhost:3100" }, maxRedirects: 0 });

  expect(await (await asClient("/robots.txt")).text()).toContain("Disallow: /");

  const proposal = await asClient("/p/sometoken");
  expect(proposal.status()).toBe(200);
  expect(proposal.headers()["x-robots-tag"]).toBe("noindex, nofollow, noarchive");

  expect((await asClient("/pipeline")).status()).toBe(404);
  expect((await asClient("/api/auth/session")).status()).toBe(404);
  expect((await request.get(`${ORIGIN}/p/sometoken`)).status()).toBe(404);
  expect((await request.get(`${ORIGIN}/login`, { headers: { host: "evil.example" } })).status()).toBe(404);
});

test("website form creates a web lead", async ({ page, request }) => {
  const res = await request.post("/api/intake/web", {
    headers: { origin: "https://cincydegreeofcomfort.com" },
    data: { name: "Website Visitor", phone: "513-555-0144", message: "Breaker keeps tripping in kitchen" },
  });
  expect(res.status()).toBe(200);
  expect(res.headers()["access-control-allow-origin"]).toBe("https://cincydegreeofcomfort.com");

  const blocked = await request.post("/api/intake/web", {
    headers: { origin: "https://evil.example" },
    data: { name: "x", phone: "5135550000" },
  });
  expect(blocked.status()).toBe(403);

  await login(page);
  await expect(page.locator('section[data-stage="new"]')).toContainText("Website Visitor");
});

test("Claude connector: OAuth sign-in, then MCP tools act as that user", async ({ page, request }) => {
  // 1. Claude discovers the auth server from the 401.
  const unauth = await request.post("/mcp", { data: {} });
  expect(unauth.status()).toBe(401);
  expect(unauth.headers()["www-authenticate"]).toContain("oauth-protected-resource");
  const meta = await (await request.get("/.well-known/oauth-authorization-server")).json();
  expect(meta.code_challenge_methods_supported).toEqual(["S256"]);

  // 2. Dynamic client registration.
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const reg = await (
    await request.post("/oauth/register", { data: { client_name: "Claude", redirect_uris: [redirectUri] } })
  ).json();

  // 3. The tech signs in and approves.
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  await login(page, "tech1@example.com");
  let callback = "";
  await page.route("https://claude.ai/**", async (route) => {
    callback = route.request().url();
    await route.fulfill({ status: 200, body: "ok" });
  });
  const params = new URLSearchParams({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s1",
    resource: `${ORIGIN}/mcp`,
  });
  await page.goto(`/oauth/authorize?${params}`);
  await expect(page.getByText("It will act as")).toContainText("tech1@example.com");
  await page.getByRole("button", { name: "Allow" }).click();
  await expect.poll(() => callback).toContain("code=");
  const cb = new URL(callback);
  expect(cb.searchParams.get("state")).toBe("s1");

  // 4. Token exchange.
  const tokenRes = await request.post("/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code: cb.searchParams.get("code")!,
      code_verifier: verifier,
      client_id: reg.client_id,
      redirect_uri: redirectUri,
    },
  });
  expect(tokenRes.status()).toBe(200);
  const { access_token } = await tokenRes.json();

  // 5. MCP calls run as the tech.
  const mcp = (body: object) =>
    request.post("/mcp", {
      headers: { authorization: `Bearer ${access_token}`, accept: "application/json, text/event-stream" },
      data: body,
    });
  const init = await mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } },
  });
  expect(init.status()).toBe(200);

  const tools = await (await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  expect(tools.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
    "create_lead",
    "get_lead",
    "log_note",
    "search_leads",
  ]);

  const search = await (
    await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_leads", arguments: {} } })
  ).json();
  const all = JSON.parse(search.result.content[0].text) as { customer: string; assignedTo: string }[];
  expect(all.length).toBeGreaterThan(0);
  expect(all.every((l) => l.assignedTo === "Mike Reyes")).toBe(true); // tech sees only their leads

  const porter = await (
    await mcp({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "search_leads", arguments: { query: "Porter" } } })
  ).json();
  const leads = JSON.parse(porter.result.content[0].text);
  expect(leads).toHaveLength(1);
  expect(leads[0].customer).toBe("James & Linda Porter");

  // A lead assigned to someone else is invisible to the tech.
  const hidden = await (
    await mcp({ jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "search_leads", arguments: { query: "Oakley" } } })
  ).json();
  expect(JSON.parse(hidden.result.content[0].text)).toEqual([]);

  const note = await (
    await mcp({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "log_note", arguments: { leadId: leads[0].id, body: "Measured the flue, 3 inch" } },
    })
  ).json();
  expect(note.result.isError).toBeFalsy();

  await page.goto(`/leads/${leads[0].id}`);
  await expect(page.getByRole("list", { name: "Activity timeline" })).toContainText("Measured the flue, 3 inch");
  await expect(page.getByText("via Claude").first()).toBeVisible();
});
