// QuickBooks OAuth 2: one connection for the company, made by the owner. Tokens are encrypted at rest.
// Intuit refresh tokens rotate and expire after ~100 days unused, so the scheduler refreshes them daily.

import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { decrypt, encrypt, randomToken } from "@/lib/crypto";
import {
  QBO_URLS,
  createMockQuickBooksClient,
  createQuickBooksClient,
  qboEnv,
  type QuickBooksClient,
} from "@/lib/integrations/quickbooks";
import type { Prisma } from "@/generated/prisma/client";

const KEY = "quickbooks";
const INCOME_KEY = "quickbooks_income_account";
const SCOPES = "com.intuit.quickbooks.accounting com.intuit.quickbooks.payment";

type Stored = {
  realmId: string;
  accessToken: string; // encrypted
  accessExpiresAt: string;
  refreshToken: string; // encrypted
  refreshExpiresAt: string;
  connectedAt: string;
  env: string;
};

export function redirectUri() {
  return process.env.QBO_REDIRECT_URI || `${appUrl()}/api/quickbooks/callback`;
}

function sign(value: string) {
  return createHmac("sha256", process.env.AUTH_SECRET ?? "").update(`qbo:${value}`).digest("base64url");
}

export function authorizeUrl(): string {
  const nonce = randomToken(16);
  const state = `${nonce}.${sign(nonce)}`;
  const qs = new URLSearchParams({
    client_id: process.env.QBO_CLIENT_ID ?? "",
    response_type: "code",
    scope: SCOPES,
    redirect_uri: redirectUri(),
    state,
  });
  return `${QBO_URLS.authorize}?${qs}`;
}

export function stateValid(state: string | null): boolean {
  const [nonce, sig] = (state ?? "").split(".");
  if (!nonce || !sig) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(nonce));
  return a.length === b.length && timingSafeEqual(a, b);
}

async function tokenRequest(body: Record<string, string>) {
  const basic = Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(QBO_URLS.token, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    x_refresh_token_expires_in?: number;
    error?: string;
  };
  if (!res.ok || !data.access_token || !data.refresh_token) throw new Error(`QuickBooks token request failed: ${data.error ?? res.status}`);
  return data as Required<Pick<typeof data, "access_token" | "refresh_token" | "expires_in" | "x_refresh_token_expires_in">>;
}

async function save(realmId: string, t: Awaited<ReturnType<typeof tokenRequest>>, connectedAt?: string) {
  const value: Stored = {
    realmId,
    accessToken: encrypt(t.access_token),
    accessExpiresAt: new Date(Date.now() + t.expires_in * 1000).toISOString(),
    refreshToken: encrypt(t.refresh_token),
    refreshExpiresAt: new Date(Date.now() + t.x_refresh_token_expires_in * 1000).toISOString(),
    connectedAt: connectedAt ?? new Date().toISOString(),
    env: qboEnv(),
  };
  const json = value as unknown as Prisma.InputJsonValue;
  await db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: json }, update: { value: json } });
}

export async function completeConnection(code: string, realmId: string) {
  await save(realmId, await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri() }));
}

async function stored(): Promise<Stored | null> {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  const v = row?.value as Stored | undefined;
  return v?.realmId && v.env === qboEnv() ? v : null;
}

export async function connectionStatus() {
  if (mock()) return { connected: true as const, realmId: "mock", env: "mock", connectedAt: null, refreshExpiresAt: null };
  const s = await stored();
  return s
    ? { connected: true as const, realmId: s.realmId, env: s.env, connectedAt: s.connectedAt, refreshExpiresAt: s.refreshExpiresAt }
    : { connected: false as const, env: qboEnv() };
}

export async function disconnect() {
  const s = await stored();
  if (s) {
    await fetch(QBO_URLS.revoke, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ token: decrypt(s.refreshToken) }),
    }).catch(() => undefined);
  }
  await db.setting.deleteMany({ where: { key: KEY } });
}

/** Refreshes now (scheduler) or when the access token is about to expire. */
export async function refreshTokens(opts: { force?: boolean } = {}): Promise<string | null> {
  const s = await stored();
  if (!s) return null;
  if (!opts.force && new Date(s.accessExpiresAt).getTime() > Date.now() + 5 * 60_000) return decrypt(s.accessToken);
  const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: decrypt(s.refreshToken) });
  await save(s.realmId, t, s.connectedAt);
  return t.access_token;
}

function mock() {
  return process.env.MOCK_INTEGRATIONS === "1" && process.env.VERCEL_ENV !== "production";
}

let override: QuickBooksClient | null = null;
export function setQuickBooksClient(c: QuickBooksClient | null) {
  override = c;
}

/** Null when QuickBooks isn't connected. */
export async function getQuickBooksClient(): Promise<QuickBooksClient | null> {
  if (override) return override;
  if (mock()) return createMockQuickBooksClient();
  const s = await stored();
  if (!s) return null;
  const income = await db.setting.findUnique({ where: { key: INCOME_KEY } });
  return createQuickBooksClient({
    realmId: s.realmId,
    incomeAccountId: (income?.value as { id?: string } | null)?.id ?? null,
    getAccessToken: async () => {
      const token = await refreshTokens();
      if (!token) throw new Error("QuickBooks is not connected");
      return token;
    },
  });
}

export async function getIncomeAccountSetting(): Promise<{ id: string; name: string } | null> {
  const row = await db.setting.findUnique({ where: { key: INCOME_KEY } });
  return (row?.value as { id: string; name: string } | undefined) ?? null;
}

export async function setIncomeAccount(account: { id: string; name: string }) {
  const value = account as unknown as Prisma.InputJsonValue;
  await db.setting.upsert({ where: { key: INCOME_KEY }, create: { key: INCOME_KEY, value }, update: { value } });
}
