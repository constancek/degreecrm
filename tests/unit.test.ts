import { describe, expect, it } from "vitest";
import { formatPhone, normalizeEmail, normalizePhone } from "@/lib/phone";
import { classifySite, hostnameOf, isClientPath } from "@/lib/hosts";
import { decrypt, encrypt, pkceChallenge } from "@/lib/crypto";
import { guessTrade, mapJotform } from "@/lib/services/intake";
import { leadStageEmbed } from "@/lib/notifications/discord-embeds";
import { isAllowedRedirectUri } from "@/lib/oauth/server";
import { STAGES } from "@/lib/stages";
import { normalizeSslMode } from "@/lib/db";

describe("phone", () => {
  it("normalizes US numbers to E.164", () => {
    expect(normalizePhone("(513) 555-0123")).toBe("+15135550123");
    expect(normalizePhone("1-513-555-0123")).toBe("+15135550123");
    expect(normalizePhone("555-0123")).toBeNull();
    expect(formatPhone("+15135550123")).toBe("(513) 555-0123");
  });
  it("validates email", () => {
    expect(normalizeEmail(" Jo@Example.COM ")).toBe("jo@example.com");
    expect(normalizeEmail("nope")).toBeNull();
  });
});

describe("host routing", () => {
  const env = { APP_HOST: "app.cincydegreeofcomfort.com", CLIENT_HOST: "go.cincydegreeofcomfort.com" };
  it("classifies hosts", () => {
    expect(classifySite(hostnameOf("go.cincydegreeofcomfort.com"), env)).toBe("client");
    expect(classifySite(hostnameOf("APP.cincydegreeofcomfort.com:443"), env)).toBe("app");
    expect(classifySite("degreecrm-git-main.vercel.app", env)).toBe("app");
    expect(classifySite("evil.example", env)).toBe("unknown");
  });
  it("limits the client host to client paths", () => {
    expect(isClientPath("/p/abc")).toBe(true);
    expect(isClientPath("/terms/v1")).toBe(true);
    expect(isClientPath("/pipeline")).toBe(false);
    expect(isClientPath("/api/auth/session")).toBe(false);
  });
});

describe("crypto", () => {
  it("round-trips encryption and rejects tampering", () => {
    const sealed = encrypt("refresh-token-123");
    expect(sealed).not.toContain("refresh-token");
    expect(decrypt(sealed)).toBe("refresh-token-123");
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(parts.join("."))).toThrow();
  });
  it("computes the RFC 7636 S256 challenge", () => {
    // Example from RFC 7636 Appendix B.
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("oauth redirect URIs", () => {
  it("allows https and loopback only", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:6274/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://evil.example/cb")).toBe(false);
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
  });
});

describe("intake mapping", () => {
  it("guesses the trade", () => {
    expect(guessTrade("Water heater leaking")).toBe("plumbing");
    expect(guessTrade("Need a panel upgrade")).toBe("electrical");
    expect(guessTrade("Furnace makes noise")).toBe("hvac");
  });
  it("maps Jotform answers by field name", () => {
    const mapped = mapJotform({
      q3_fullName: { first: "Ana", last: "Diaz" },
      q4_phoneNumber: { full: "(513) 555-0199" },
      q5_email: "ana@example.com",
      q6_address: { addr_line1: "12 Main St", addr_line2: "", city: "Cincinnati", state: "OH", postal: "45202" },
      q7_serviceNeeded: "Plumbing",
      q8_describeThe: "Kitchen sink clogged",
    });
    expect(mapped).toMatchObject({
      name: "Ana Diaz",
      phone: "(513) 555-0199",
      email: "ana@example.com",
      street: "12 Main St",
      city: "Cincinnati",
      zip: "45202",
      service: "Plumbing",
      message: "Kitchen sink clogged",
    });
  });
});

describe("pipeline + discord", () => {
  it("has 11 ordered stages plus lost", () => {
    expect(STAGES).toHaveLength(12);
    expect(STAGES.at(-1)!.id).toBe("lost");
  });
  it("builds a Discord embed with a CRM link and map link", () => {
    const msg = leadStageEmbed({
      id: "lead1",
      title: "No heat",
      trade: "hvac",
      stage: "estimate_scheduled",
      customer: { name: "Pat", phone: "+15135550123" },
      property: { street: "1 Vine St", unit: null, city: "Cincinnati", zip: "45202" },
      assignedTo: { name: "Mike" },
    });
    const embed = msg.embeds![0]!;
    expect(embed.title).toBe("Estimate scheduled: No heat");
    expect(embed.url).toBe("https://app.test/leads/lead1");
    expect(embed.fields!.find((f) => f.name === "Address")!.value).toContain("google.com/maps");
  });
});

describe("database url", () => {
  it("upgrades sslmode=require to verify-full and leaves other URLs alone", () => {
    expect(normalizeSslMode("postgresql://u:p@h/db?sslmode=require&channel_binding=require")).toBe(
      "postgresql://u:p@h/db?sslmode=verify-full&channel_binding=require",
    );
    expect(normalizeSslMode("postgresql://u:p@localhost:54329/db")).toBe("postgresql://u:p@localhost:54329/db");
  });
});

import { formatCents, marginPercent, optionTotals, parseDollars, parseRate } from "@/lib/money";
import { normalizeCounty } from "@/lib/services/tax";
import { renderKeyTerms } from "@/lib/services/terms";
import { depositPercentFor } from "@/lib/services/company";

describe("money", () => {
  it("parses and formats dollars and rates", () => {
    expect(parseDollars("$1,234.5")).toBe(123450);
    expect(parseDollars("abc")).toBeNull();
    expect(parseDollars("-5")).toBeNull();
    expect(formatCents(123450)).toBe("$1,234.50");
    expect(formatCents(500000)).toBe("$5,000");
    expect(parseRate("7.8%")).toBe(780);
  });
  it("totals exclude optional add-ons and tax every included line", () => {
    const t = optionTotals(
      [
        { qty: 1, unitCents: 100000, isOptional: false },
        { qty: 3.5, unitCents: 12500, isOptional: false },
        { qty: 1, unitCents: 99900, isOptional: true },
      ],
      780,
    );
    expect(t).toEqual({ subtotalCents: 143750, taxCents: 11213, totalCents: 154963 });
  });
  it("computes margin only when every line has a cost", () => {
    expect(marginPercent([{ qty: 1, unitCents: 1000, costCents: 600, isOptional: false }])).toBe(40);
    expect(marginPercent([{ qty: 1, unitCents: 1000, costCents: null, isOptional: false }])).toBeNull();
  });
});

describe("tax, terms, deposit", () => {
  it("normalizes county names", () => {
    expect(normalizeCounty("Hamilton County")).toBe("Hamilton");
    expect(normalizeCounty("  warren ")).toBe("Warren");
  });
  it("fills key-term placeholders", () => {
    expect(renderKeyTerms("A {deposit} deposit.\nValid until {expires}.", { depositPercent: 30, expires: "Nov 8, 2026" })).toEqual([
      "A 30% deposit.",
      "Valid until Nov 8, 2026.",
    ]);
  });
  it("uses 50% under the threshold, 30% at or above, unless overridden", () => {
    const c = { depositThresholdCents: 500000, depositBelowPercent: 50, depositAbovePercent: 30 } as never;
    expect(depositPercentFor(499999, c, null)).toBe(50);
    expect(depositPercentFor(500000, c, null)).toBe(30);
    expect(depositPercentFor(100, c, 25)).toBe(25);
  });
});
