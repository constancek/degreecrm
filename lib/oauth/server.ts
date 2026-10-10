// Minimal OAuth 2.1 authorization server for the MCP connector (SPEC.md "MCP server for workers").
// Authorization code + PKCE (S256) only, public clients, dynamic client registration (RFC 7591),
// rotating refresh tokens. Staff authenticate with Google via Auth.js on the /oauth/authorize page.

import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { pkceChallenge, randomToken, sha256 } from "@/lib/crypto";
import type { StaffActor } from "@/lib/session";

export const SCOPE = "crm";
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    description: string,
    readonly status = 400,
  ) {
    super(description);
  }
  toResponse() {
    return Response.json(
      { error: this.error, error_description: this.message },
      { status: this.status, headers: { "cache-control": "no-store" } },
    );
  }
}

export function mcpResourceUrl() {
  return `${appUrl()}/mcp`;
}

export function authorizationServerMetadata() {
  const base = appUrl();
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
  };
}

export function protectedResourceMetadata() {
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [appUrl()],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Degree of Comfort CRM",
  };
}

/** https anywhere, or http on loopback (for local MCP clients). */
export function isAllowedRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

// ---- Registration -----------------------------------------------------------

export async function registerClient(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const redirectUris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u) => typeof u === "string") : [];
  if (!redirectUris.length) throw new OAuthError("invalid_redirect_uri", "redirect_uris is required");
  const bad = redirectUris.find((u) => !isAllowedRedirectUri(u));
  if (bad) throw new OAuthError("invalid_redirect_uri", `Redirect URI not allowed: ${bad}`);
  const method = b.token_endpoint_auth_method ?? "none";
  if (method !== "none") {
    throw new OAuthError("invalid_client_metadata", "Only public clients (token_endpoint_auth_method=none) are supported");
  }

  const name = typeof b.client_name === "string" ? b.client_name.slice(0, 200) : null;
  const client = await db.oAuthClient.create({
    data: { id: `mcp_${randomToken(16)}`, name, redirectUris },
  });
  return {
    client_id: client.id,
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    client_name: client.name ?? undefined,
    redirect_uris: client.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

// ---- Authorization ----------------------------------------------------------

export type AuthorizeParams = {
  clientId: string;
  clientName: string | null;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: string | null;
  resource: string | null;
};

/**
 * Validates an /oauth/authorize request. Errors about the client or redirect URI must be shown to the
 * user, never redirected (RFC 6749 §4.1.2.1), so they come back as `{ fatal }`.
 */
export async function validateAuthorizeRequest(
  q: Record<string, string | undefined>,
): Promise<{ ok: AuthorizeParams } | { fatal: string } | { redirect: string }> {
  const clientId = q.client_id;
  const redirectUri = q.redirect_uri;
  if (!clientId) return { fatal: "Missing client_id." };
  const client = await db.oAuthClient.findUnique({ where: { id: clientId } });
  if (!client) return { fatal: "Unknown client. Remove the connector in Claude and add it again." };
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return { fatal: "The redirect URI doesn't match this client's registration." };
  }

  const fail = (error: string, description: string) => {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    u.searchParams.set("error_description", description);
    if (q.state) u.searchParams.set("state", q.state);
    return { redirect: u.toString() };
  };
  if (q.response_type !== "code") return fail("unsupported_response_type", "response_type must be code");
  if (!q.code_challenge || q.code_challenge_method !== "S256") {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  if (q.resource && q.resource !== mcpResourceUrl()) return fail("invalid_target", "Unknown resource");

  return {
    ok: {
      clientId,
      clientName: client.name,
      redirectUri,
      state: q.state ?? null,
      codeChallenge: q.code_challenge,
      scope: q.scope ?? SCOPE,
      resource: q.resource ?? null,
    },
  };
}

export async function issueAuthorizationCode(user: StaffActor, p: AuthorizeParams): Promise<string> {
  const code = randomToken(32);
  await db.oAuthCode.create({
    data: {
      codeHash: sha256(code),
      clientId: p.clientId,
      userId: user.id,
      redirectUri: p.redirectUri,
      codeChallenge: p.codeChallenge,
      scope: p.scope,
      resource: p.resource,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  });
  const u = new URL(p.redirectUri);
  u.searchParams.set("code", code);
  if (p.state) u.searchParams.set("state", p.state);
  u.searchParams.set("iss", appUrl());
  return u.toString();
}

// ---- Token endpoint ---------------------------------------------------------

async function issueTokens(args: { clientId: string; userId: string; scope: string | null; resource: string | null }) {
  const accessToken = `doc_at_${randomToken(32)}`;
  const refreshToken = `doc_rt_${randomToken(32)}`;
  await db.oAuthToken.create({
    data: {
      accessTokenHash: sha256(accessToken),
      refreshTokenHash: sha256(refreshToken),
      clientId: args.clientId,
      userId: args.userId,
      scope: args.scope,
      resource: args.resource,
      expiresAt: new Date(Date.now() + ACCESS_TTL_MS),
      refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_MS / 1000,
    refresh_token: refreshToken,
    scope: args.scope ?? SCOPE,
  };
}

export async function exchangeToken(form: URLSearchParams) {
  const grant = form.get("grant_type");
  const clientId = form.get("client_id");
  if (!clientId) throw new OAuthError("invalid_client", "client_id is required", 401);
  const client = await db.oAuthClient.findUnique({ where: { id: clientId } });
  if (!client) throw new OAuthError("invalid_client", "Unknown client", 401);

  if (grant === "authorization_code") {
    const code = form.get("code");
    const verifier = form.get("code_verifier");
    if (!code || !verifier) throw new OAuthError("invalid_request", "code and code_verifier are required");

    // Single use: claim the code atomically.
    const row = await db.oAuthCode.findUnique({ where: { codeHash: sha256(code) }, include: { user: true } });
    if (!row || row.clientId !== clientId) throw new OAuthError("invalid_grant", "Invalid authorization code");
    const claimed = await db.oAuthCode.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count === 0) {
      // Replay: revoke anything issued from this grant's user+client pair.
      await db.oAuthToken.updateMany({
        where: { clientId, userId: row.userId, createdAt: { gte: row.createdAt }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new OAuthError("invalid_grant", "Authorization code already used");
    }
    if (row.expiresAt < new Date()) throw new OAuthError("invalid_grant", "Authorization code expired");
    if (form.get("redirect_uri") && form.get("redirect_uri") !== row.redirectUri) {
      throw new OAuthError("invalid_grant", "redirect_uri mismatch");
    }
    if (pkceChallenge(verifier) !== row.codeChallenge) throw new OAuthError("invalid_grant", "PKCE verification failed");
    if (!row.user.active) throw new OAuthError("invalid_grant", "User is deactivated");

    return issueTokens({ clientId, userId: row.userId, scope: row.scope, resource: row.resource });
  }

  if (grant === "refresh_token") {
    const refresh = form.get("refresh_token");
    if (!refresh) throw new OAuthError("invalid_request", "refresh_token is required");
    const row = await db.oAuthToken.findUnique({
      where: { refreshTokenHash: sha256(refresh) },
      include: { user: true },
    });
    if (!row || row.clientId !== clientId) throw new OAuthError("invalid_grant", "Invalid refresh token");
    // Rotation: each refresh token works once.
    const rotated = await db.oAuthToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (rotated.count === 0 || row.refreshExpiresAt < new Date() || !row.user.active) {
      throw new OAuthError("invalid_grant", "Refresh token expired or revoked");
    }
    return issueTokens({ clientId, userId: row.userId, scope: row.scope, resource: row.resource });
  }

  throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token");
}

export async function revokeToken(token: string) {
  const hash = sha256(token);
  await db.oAuthToken.updateMany({
    where: { OR: [{ accessTokenHash: hash }, { refreshTokenHash: hash }], revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// ---- Resource server --------------------------------------------------------

/** Resolves a Bearer token to the staff member it was issued to, or null. */
export async function verifyAccessToken(authorization: string | null): Promise<StaffActor | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!m) return null;
  const row = await db.oAuthToken.findUnique({
    where: { accessTokenHash: sha256(m[1]!) },
    include: { user: true },
  });
  if (!row || row.revokedAt || row.expiresAt < new Date() || !row.user.active) return null;
  if (row.resource && row.resource !== mcpResourceUrl()) return null;
  const u = row.user;
  return { kind: "user", id: u.id, role: u.role, name: u.name, email: u.email, via: "mcp" };
}
