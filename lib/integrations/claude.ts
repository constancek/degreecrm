// Claude drafts Good/Better/Best proposals as strict JSON (SPEC.md "Proposals").
// Claude assembles from the price book; it never sets prices. The service fills prices from price-book ids.

import { readFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Trade } from "@/generated/prisma/enums";

export const DEFAULT_MODEL = "claude-opus-5";

const draftLineItem = z.object({
  description: z.string().describe("Customer-facing line description"),
  qty: z.number().describe("Quantity in the item's unit, e.g. 1, 2, 3.5 hours"),
  unit: z.string().describe("Unit, e.g. ea, hr, ft"),
  priceBookItemId: z
    .string()
    .nullable()
    .describe("id of the matching price book item, or null if nothing in the price book fits"),
  isOptional: z.boolean().describe("true for optional add-ons that are not included in the option total"),
});

const draftOption = z.object({
  tier: z.enum(["good", "better", "best"]),
  title: z.string(),
  summary: z.string().describe("One or two sentences, plain English"),
  highlights: z.array(z.string()).describe("4 to 6 short bullet highlights for the option card"),
  warrantyText: z.string(),
  lineItems: z.array(draftLineItem),
});

export const proposalDraftSchema = z.object({
  summary: z.string().describe("One paragraph for the customer describing the problem and the choices"),
  recommendedTier: z.enum(["good", "better", "best"]),
  assumptions: z.array(z.string()),
  exclusions: z.array(z.string()),
  options: z.array(draftOption).describe("Exactly three options: good, better, best"),
});

export type ProposalDraft = z.infer<typeof proposalDraftSchema>;

export type DraftInput = {
  trade: Trade;
  customerName: string;
  customerType: "residential" | "commercial";
  address: string | null;
  jobTitle: string;
  notes: string;
  equipment: string | null;
  targetMarginPercent: number | null;
  priceBook: { id: string; category: string; name: string; description: string | null; unit: string; priceCents: number }[];
  photos: { mediaType: "image/jpeg" | "image/png" | "image/webp"; base64: string }[];
};

export interface ProposalDrafter {
  draft(input: DraftInput): Promise<{ draft: ProposalDraft; model: string }>;
}

export class DraftError extends Error {}

async function loadPrompt(name: string): Promise<string> {
  return readFile(path.join(process.cwd(), "prompts", `${name}.md`), "utf8");
}

function userText(input: DraftInput): string {
  const book = input.priceBook.length
    ? input.priceBook
        .map((i) => `- id=${i.id} | ${i.category} | ${i.name}${i.description ? ` — ${i.description}` : ""} | per ${i.unit} | $${(i.priceCents / 100).toFixed(2)}`)
        .join("\n")
    : "(empty: flag every line with priceBookItemId = null)";
  return [
    `Customer: ${input.customerName} (${input.customerType})`,
    `Job site: ${input.address ?? "not given"}`,
    `Job: ${input.jobTitle}`,
    input.targetMarginPercent != null ? `Target gross margin: ${input.targetMarginPercent}%` : null,
    input.equipment ? `Equipment on site:\n${input.equipment}` : null,
    `Technician notes / transcript:\n${input.notes}`,
    `Price book (${input.trade}):\n${book}`,
    input.photos.length ? `${input.photos.length} photo(s) from the site are attached above.` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function createClaudeDrafter(model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL): ProposalDrafter {
  const client = new Anthropic();
  return {
    async draft(input) {
      const system = `${await loadPrompt("system")}\n\n${await loadPrompt(input.trade)}`;
      const content: Anthropic.Beta.BetaContentBlockParam[] = [
        ...input.photos.map(
          (p): Anthropic.Beta.BetaContentBlockParam => ({
            type: "image",
            source: { type: "base64", media_type: p.mediaType, data: p.base64 },
          }),
        ),
        { type: "text", text: userText(input) },
      ];

      const response = await client.beta.messages.parse({
        model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        system,
        messages: [{ role: "user", content }],
        output_config: { format: betaZodOutputFormat(proposalDraftSchema) },
      });

      if (response.stop_reason === "refusal") throw new DraftError("Claude declined to draft this proposal.");
      if (response.stop_reason === "max_tokens") throw new DraftError("The draft was too long. Try shorter notes.");
      const draft = response.parsed_output;
      if (!draft) throw new DraftError("Claude returned a draft that didn't match the format. Please try again.");
      return { draft, model: response.model };
    },
  };
}

/** Deterministic drafter for tests / E2E (AI_MOCK=1). Uses the first price book items it's given. */
export function createMockDrafter(): ProposalDrafter & { calls: DraftInput[] } {
  const calls: DraftInput[] = [];
  return {
    calls,
    async draft(input) {
      calls.push(input);
      const pick = (i: number) => input.priceBook[i % Math.max(1, input.priceBook.length)]?.id ?? null;
      const option = (tier: "good" | "better" | "best", n: number) => ({
        tier,
        title: `${tier[0]!.toUpperCase()}${tier.slice(1)} option`,
        summary: `The ${tier} way to fix: ${input.jobTitle}.`,
        highlights: ["Licensed and insured techs", "Clean-up included", "Permit handled", `${n}-year labor warranty`],
        warrantyText: `${n}-year labor warranty`,
        lineItems: [
          { description: "Main repair / equipment", qty: 1, unit: "ea", priceBookItemId: pick(n - 1), isOptional: false },
          { description: "Labor", qty: n * 2, unit: "hr", priceBookItemId: pick(n), isOptional: false },
          ...(tier === "best"
            ? [{ description: "Specialty part not in price book", qty: 1, unit: "ea", priceBookItemId: null, isOptional: false }]
            : []),
        ],
      });
      return {
        model: "mock",
        draft: {
          summary: `Here are three ways to handle "${input.jobTitle}".`,
          recommendedTier: "better",
          assumptions: ["Existing wiring and venting are reusable"],
          exclusions: ["Drywall repair beyond access holes"],
          options: [option("good", 1), option("better", 2), option("best", 5)],
        },
      };
    },
  };
}

let override: ProposalDrafter | null = null;
export function setDrafter(d: ProposalDrafter | null) {
  override = d;
}

export function getDrafter(): ProposalDrafter {
  if (override) return override;
  if (process.env.AI_MOCK === "1") return (override = createMockDrafter());
  return createClaudeDrafter();
}
