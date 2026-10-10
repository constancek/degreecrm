import { z } from "zod";
import { db } from "@/lib/db";
import { TRADE_IDS } from "@/lib/stages";
import type { Trade } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { ForbiddenError, NotFoundError, isOwner, type Actor } from "./actor";

export const PRICE_CATEGORIES = ["equipment", "material", "labor", "fee"] as const;

export async function listPriceBook(opts: { trade?: Trade | null; query?: string; includeInactive?: boolean } = {}) {
  const where: Prisma.PriceBookItemWhereInput = {
    ...(opts.includeInactive ? {} : { active: true }),
    // A trade's price book includes the items shared by every trade.
    ...(opts.trade ? { OR: [{ trade: opts.trade }, { trade: null }] } : {}),
    ...(opts.query?.trim()
      ? {
          AND: [
            {
              OR: [
                { name: { contains: opts.query.trim(), mode: "insensitive" } },
                { description: { contains: opts.query.trim(), mode: "insensitive" } },
                { sku: { contains: opts.query.trim(), mode: "insensitive" } },
              ],
            },
          ],
        }
      : {}),
  };
  return db.priceBookItem.findMany({
    where,
    orderBy: [{ trade: "asc" }, { category: "asc" }, { name: "asc" }],
    take: 1000,
  });
}

export const priceBookItemInput = z.object({
  id: z.string().optional(),
  trade: z.enum(TRADE_IDS).nullable(),
  category: z.enum(PRICE_CATEGORIES),
  name: z.string().trim().min(1, "Name is required").max(200),
  description: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((v) => v || null),
  sku: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => v || null),
  unit: z.string().trim().min(1).max(20).default("ea"),
  costCents: z.number().int().min(0).nullable(),
  priceCents: z.number().int().min(1, "Price must be more than $0"),
});

export async function savePriceBookItem(actor: Actor, raw: z.input<typeof priceBookItemInput>) {
  if (!isOwner(actor)) throw new ForbiddenError("Only the owner can edit the price book");
  const { id, ...data } = priceBookItemInput.parse(raw);
  if (id) {
    const found = await db.priceBookItem.findUnique({ where: { id } });
    if (!found) throw new NotFoundError("Price book item not found");
    return db.priceBookItem.update({ where: { id }, data });
  }
  return db.priceBookItem.create({ data });
}

export async function setPriceBookItemActive(actor: Actor, id: string, active: boolean) {
  if (!isOwner(actor)) throw new ForbiddenError("Only the owner can edit the price book");
  return db.priceBookItem.update({ where: { id }, data: { active } });
}
