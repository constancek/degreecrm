import { z } from "zod";
import { db } from "@/lib/db";
import { getBlobStore } from "@/lib/integrations/blob";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import type { Prisma } from "@/generated/prisma/client";
import { ForbiddenError, ValidationError, isOwner, type Actor } from "./actor";

const KEY = "company";

export type CompanyProfile = {
  name: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  email: string;
  licenseNumber: string;
  website: string;
  /** Private blob path of the uploaded logo; bump `logoVersion` to bust caches. */
  logoPath: string | null;
  logoVersion: number;
  /** Deposit rule: `depositBelowPercent` for jobs under the threshold, `depositAbovePercent` at or above. */
  depositThresholdCents: number;
  depositBelowPercent: number;
  depositAbovePercent: number;
  /** Owner's mobile (E.164) for "proposal signed" / urgent texts. */
  ownerAlertPhone: string;
  /** Acorn Finance contractor link for "Pay monthly". */
  acornLink: string;
  /** Google review link sent after payment. */
  googleReviewUrl: string;
  /** Default service call fee the tech can charge when an estimate is declined. */
  serviceCallFeeCents: number;
};

const DEFAULTS: CompanyProfile = {
  name: "Degree of Comfort",
  street: "",
  city: "Cincinnati",
  state: "OH",
  zip: "",
  phone: "",
  email: "",
  licenseNumber: "",
  website: "https://cincydegreeofcomfort.com",
  logoPath: null,
  logoVersion: 0,
  depositThresholdCents: 500_000,
  depositBelowPercent: 50,
  depositAbovePercent: 30,
  ownerAlertPhone: "",
  acornLink: "",
  googleReviewUrl: "",
  serviceCallFeeCents: 8900,
};

export async function getCompany(): Promise<CompanyProfile> {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  return { ...DEFAULTS, ...((row?.value as Partial<CompanyProfile> | undefined) ?? {}) };
}

async function write(profile: CompanyProfile) {
  const value = profile as unknown as Prisma.InputJsonValue;
  await db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
}

const detailsInput = z.object({
  name: z.string().trim().min(1, "Company name is required").max(120),
  street: z.string().trim().max(200),
  city: z.string().trim().max(100),
  state: z.string().trim().max(2),
  zip: z.string().trim().max(10),
  phone: z.string().trim().max(40),
  email: z.string().trim().max(200),
  licenseNumber: z.string().trim().max(100),
  website: z.string().trim().max(200),
  depositThresholdCents: z.number().int().min(0),
  depositBelowPercent: z.number().int().min(0).max(100),
  depositAbovePercent: z.number().int().min(0).max(100),
  ownerAlertPhone: z.string().trim().max(40).default(""),
  acornLink: z.string().trim().max(500).default(""),
  googleReviewUrl: z.string().trim().max(500).default(""),
  serviceCallFeeCents: z.number().int().min(0).max(100_000).optional(),
});

export async function saveCompanyDetails(actor: Actor, raw: unknown) {
  if (!isOwner(actor)) throw new ForbiddenError("Only the owner can change company settings");
  const input = detailsInput.parse(raw);
  if (input.phone && !normalizePhone(input.phone)) throw new ValidationError("Phone number doesn't look like a US number");
  if (input.email && !normalizeEmail(input.email)) throw new ValidationError("Support email doesn't look right");
  if (input.ownerAlertPhone && !normalizePhone(input.ownerAlertPhone)) throw new ValidationError("Alert phone doesn't look like a US number");
  for (const [label, url] of [["Acorn link", input.acornLink], ["Review link", input.googleReviewUrl]] as const) {
    if (url && !/^https:\/\/\S+$/.test(url)) throw new ValidationError(`${label} must start with https://`);
  }
  const current = await getCompany();
  await write({
    ...current,
    ...input,
    state: input.state.toUpperCase(),
    phone: normalizePhone(input.phone) ?? "",
    email: normalizeEmail(input.email) ?? "",
    ownerAlertPhone: normalizePhone(input.ownerAlertPhone) ?? "",
  });
}

const LOGO_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);

/** PNG/JPEG/WebP up to 2 MB. (SVG is refused: it can carry scripts.) */
export async function saveLogo(actor: Actor, file: { body: Buffer; contentType: string }) {
  if (!isOwner(actor)) throw new ForbiddenError("Only the owner can change company settings");
  const ext = LOGO_TYPES.get(file.contentType);
  if (!ext) throw new ValidationError("Logo must be a PNG, JPEG or WebP image");
  if (file.body.length > 2 * 1024 * 1024) throw new ValidationError("Logo must be 2 MB or smaller");
  const current = await getCompany();
  const logoPath = `brand/logo-${current.logoVersion + 1}.${ext}`;
  await getBlobStore().put(logoPath, file.body, file.contentType);
  await write({ ...current, logoPath, logoVersion: current.logoVersion + 1 });
  if (current.logoPath) await getBlobStore().del(current.logoPath);
}

export async function removeLogo(actor: Actor) {
  if (!isOwner(actor)) throw new ForbiddenError("Only the owner can change company settings");
  const current = await getCompany();
  if (current.logoPath) await getBlobStore().del(current.logoPath);
  await write({ ...current, logoPath: null, logoVersion: current.logoVersion + 1 });
}

export function companyAddressLine(c: CompanyProfile): string {
  return [c.street, [c.city, [c.state, c.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean).join(", ");
}

/** Deposit % for an option total: the proposal's override, else the company rule. */
export function depositPercentFor(totalCents: number, c: CompanyProfile, override: number | null): number {
  if (override != null) return override;
  return totalCents < c.depositThresholdCents ? c.depositBelowPercent : c.depositAbovePercent;
}
