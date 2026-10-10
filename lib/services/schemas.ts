import { z } from "zod";
import { SOURCE_IDS, STAGE_IDS, TRADE_IDS } from "@/lib/stages";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const customerInput = z.object({
  name: z.string().trim().min(1, "Customer name is required").max(200),
  phone: optionalText(40),
  email: optionalText(200),
  type: z.enum(["residential", "commercial"]).default("residential"),
});

export const propertyInput = z.object({
  street: z.string().trim().min(1, "Street address is required").max(200),
  unit: optionalText(50),
  city: optionalText(100),
  state: optionalText(2),
  zip: optionalText(10),
  county: optionalText(100),
  notes: optionalText(2000),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
});

export const createLeadInput = z
  .object({
    customerId: z.string().optional(),
    customer: customerInput.optional(),
    propertyId: z.string().optional(),
    property: propertyInput.optional(),
    title: z.string().trim().min(1, "Describe the job in a few words").max(200),
    trade: z.enum(TRADE_IDS),
    source: z.enum(SOURCE_IDS).default("phone"),
    notes: optionalText(10_000),
    assignedToId: optionalText(50),
  })
  .refine((v) => v.customerId || v.customer, { message: "Customer is required", path: ["customer"] });

export type CreateLeadInput = z.input<typeof createLeadInput>;

export const updateLeadInput = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  trade: z.enum(TRADE_IDS).optional(),
  source: z.enum(SOURCE_IDS).optional(),
  notes: z.string().max(10_000).optional(),
});

export const stageInput = z.enum(STAGE_IDS);

export const noteInput = z.string().trim().min(1, "Note can't be empty").max(10_000);
