import { expect, type Page } from "@playwright/test";

export async function login(page: Page, email = "owner@e2e.test") {
  await page.goto("/login");
  await page.getByLabel("Test login (E2E_AUTH)").fill(email);
  await page.getByRole("button", { name: "Sign in without Google" }).click();
  await expect(page.getByRole("heading", { name: "Pipeline" })).toBeVisible();
}

import { createHash, randomBytes } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";

export const ORIGIN = "http://localhost:3100";

/** Runs the Claude connector OAuth flow as `email` and returns an MCP caller. */
export async function connectMcp(page: Page, request: APIRequestContext, email: string) {
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const reg = await (await request.post("/oauth/register", { data: { client_name: "Claude", redirect_uris: [redirectUri] } })).json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  await login(page, email);
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
  await page.getByRole("button", { name: "Allow" }).click();
  await expect.poll(() => callback).toContain("code=");
  const code = new URL(callback).searchParams.get("code")!;
  const { access_token } = await (
    await request.post("/oauth/token", {
      form: { grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirectUri },
    })
  ).json();
  let id = 0;
  const rpc = async (method: string, params?: object) =>
    (
      await request.post("/mcp", {
        headers: { authorization: `Bearer ${access_token}`, accept: "application/json, text/event-stream" },
        data: { jsonrpc: "2.0", id: ++id, method, params },
      })
    ).json();
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  return {
    rpc,
    /** Calls a tool and returns its parsed JSON result (throws on tool errors). */
    async tool(name: string, args: object) {
      const res = await rpc("tools/call", { name, arguments: args });
      if (res.result?.isError) throw new Error(res.result.content[0].text);
      return JSON.parse(res.result.content[0].text);
    },
  };
}
