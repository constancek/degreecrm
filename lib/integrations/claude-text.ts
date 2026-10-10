// Small Claude tasks: personalizing a drip text, reading Acorn financing emails.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { DEFAULT_MODEL } from "./claude";

const model = () => process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

function textOf(content: Anthropic.Beta.BetaContentBlock[]) {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/** Lightly adapts a drip text to what we know about the job. Keeps links, names and dates exactly. */
export async function personalizeText(text: string, notes: string): Promise<string> {
  const client = new Anthropic();
  const res = await client.beta.messages.create({
    model: model(),
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    system:
      "You rewrite short SMS follow-ups from a home-services company so they sound personal. Keep it under 300 characters, keep every link, name, date, time and phone number exactly as given, add no new facts or promises, and reply with only the message text.",
    messages: [{ role: "user", content: `Job notes (context only):\n${notes.slice(0, 2000)}\n\nMessage to adapt:\n${text}` }],
  });
  if (res.stop_reason === "refusal") return text;
  const out = textOf(res.content);
  return out && out.length <= 600 ? out : text;
}

export const financingEmailSchema = z.object({
  isFinancingUpdate: z.boolean().describe("true if this email is about a customer's financing application"),
  customerName: z.string().nullable(),
  customerEmail: z.string().nullable(),
  status: z.enum(["offers", "approved", "funded", "declined", "other"]),
  amountDollars: z.number().nullable(),
  summary: z.string().describe("One sentence for the owner"),
});
export type FinancingEmail = z.infer<typeof financingEmailSchema>;

export async function extractFinancingEmail(subject: string, body: string): Promise<FinancingEmail> {
  const client = new Anthropic();
  const res = await client.beta.messages.parse({
    model: model(),
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(financingEmailSchema) },
    system: "Extract the financing status from a notification email sent to a contractor by Acorn Finance. Use null for anything the email doesn't state.",
    messages: [{ role: "user", content: `Subject: ${subject}\n\n${body.slice(0, 20_000)}` }],
  });
  if (!res.parsed_output) throw new Error("Couldn't read the financing email");
  return res.parsed_output;
}

export const slotRequestSchema = z.object({
  durationHours: z.number().describe("Job length in hours"),
  maxDriveMinutes: z.number().describe("Max drive time from the previous stop, minutes; 30 if not said"),
  fromDate: z.string().describe("Earliest date YYYY-MM-DD"),
  days: z.number().describe("How many days to search, 1-21; 10 if not said"),
});

/** "next 3 openings for a 4-hour HVAC install within 20 min, next week" → slot finder parameters. */
export async function parseSlotRequest(text: string, todayYmd: string) {
  const client = new Anthropic();
  const res = await client.beta.messages.parse({
    model: model(),
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(slotRequestSchema) },
    system: `Turn a dispatcher's request into search parameters for finding open appointment slots. Today is ${todayYmd} (America/New_York).`,
    messages: [{ role: "user", content: text.slice(0, 1000) }],
  });
  if (!res.parsed_output) throw new Error("Couldn't understand that request");
  return res.parsed_output;
}
