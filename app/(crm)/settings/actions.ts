"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { parseDollars, parseRate } from "@/lib/money";
import { ForbiddenError, ValidationError } from "@/lib/services/actor";
import { removeLogo, saveCompanyDetails, saveLogo } from "@/lib/services/company";
import { saveTerms } from "@/lib/services/terms";
import { saveTaxRates } from "@/lib/services/tax";

export type SettingsState = { error?: string; ok?: string } | undefined;

function fail(err: unknown): SettingsState {
  if (err instanceof z.ZodError) return { error: err.issues[0]?.message ?? "Please check the form" };
  if (err instanceof ValidationError || err instanceof ForbiddenError) return { error: err.message };
  console.error(err);
  return { error: "Something went wrong. Please try again." };
}

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");

export async function saveCompanyAction(_prev: SettingsState, fd: FormData): Promise<SettingsState> {
  const user = await requireUser();
  try {
    const threshold = parseDollars(s(fd, "depositThreshold"));
    if (threshold == null) throw new ValidationError("Deposit threshold must be a dollar amount");
    await saveCompanyDetails(user, {
      name: s(fd, "name"),
      street: s(fd, "street"),
      city: s(fd, "city"),
      state: s(fd, "state"),
      zip: s(fd, "zip"),
      phone: s(fd, "phone"),
      email: s(fd, "email"),
      licenseNumber: s(fd, "licenseNumber"),
      website: s(fd, "website"),
      depositThresholdCents: threshold,
      depositBelowPercent: Number(s(fd, "depositBelow")),
      depositAbovePercent: Number(s(fd, "depositAbove")),
    });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/settings");
  return { ok: "Saved" };
}

export async function uploadLogoAction(_prev: SettingsState, fd: FormData): Promise<SettingsState> {
  const user = await requireUser();
  const file = fd.get("logo");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose an image first" };
  try {
    await saveLogo(user, { body: Buffer.from(await file.arrayBuffer()), contentType: file.type });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/settings");
  return { ok: "Logo updated" };
}

export async function removeLogoAction(): Promise<void> {
  const user = await requireUser();
  await removeLogo(user);
  revalidatePath("/settings");
}

export async function saveTermsAction(_prev: SettingsState, fd: FormData): Promise<SettingsState> {
  const user = await requireUser();
  let version: number;
  try {
    version = (await saveTerms(user, { body: s(fd, "body"), keyTerms: s(fd, "keyTerms") })).version;
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/settings");
  return { ok: `Saved as version ${version}` };
}

export async function saveTaxRatesAction(_prev: SettingsState, fd: FormData): Promise<SettingsState> {
  const user = await requireUser();
  try {
    const states = fd.getAll("state").map(String);
    const counties = fd.getAll("county").map(String);
    const rates = fd.getAll("rate").map(String);
    const rows = states
      .map((state, i) => ({ state, county: counties[i] ?? "", rate: rates[i] ?? "" }))
      .filter((r) => r.state.trim() || r.county.trim() || r.rate.trim())
      .map((r) => {
        const rateBps = parseRate(r.rate);
        if (rateBps == null) throw new ValidationError(`"${r.rate}" isn't a valid rate for ${r.county || r.state}`);
        return { state: r.state, county: r.county, rateBps };
      });
    await saveTaxRates(user, rows);
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/settings");
  return { ok: "Tax rates saved" };
}
