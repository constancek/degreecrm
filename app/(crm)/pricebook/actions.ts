"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { parseDollars } from "@/lib/money";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/services/actor";
import { savePriceBookItem, setPriceBookItemActive } from "@/lib/services/pricebook";

export type PriceBookState = { error?: string; savedId?: string; at?: number } | undefined;

export async function savePriceBookItemAction(_prev: PriceBookState, fd: FormData): Promise<PriceBookState> {
  const user = await requireUser();
  const s = (k: string) => String(fd.get(k) ?? "");
  try {
    const priceCents = parseDollars(s("price"));
    if (priceCents == null) throw new ValidationError("Price must be a dollar amount, e.g. 125 or 89.50");
    const costCents = s("cost").trim() ? parseDollars(s("cost")) : null;
    if (s("cost").trim() && costCents == null) throw new ValidationError("Cost must be a dollar amount");
    const item = await savePriceBookItem(user, {
      id: s("id") || undefined,
      trade: (s("trade") || null) as never,
      category: s("category") as never,
      name: s("name"),
      description: s("description"),
      sku: s("sku"),
      unit: s("unit") || "ea",
      costCents,
      priceCents,
    });
    revalidatePath("/pricebook");
    return { savedId: item.id, at: Date.now() };
  } catch (err) {
    if (err instanceof z.ZodError) return { error: err.issues[0]?.message };
    if (err instanceof ValidationError || err instanceof ForbiddenError || err instanceof NotFoundError) return { error: err.message };
    console.error(err);
    return { error: "Something went wrong." };
  }
}

export async function setActiveAction(id: string, active: boolean) {
  const user = await requireUser();
  await setPriceBookItemActive(user, id, active);
  revalidatePath("/pricebook");
}
