"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { requireUser } from "@/lib/session";
import { DraftError } from "@/lib/integrations/claude";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/services/actor";
import {
  createProposalDraft,
  createRevision,
  generateProposal,
  saveProposal,
  sendProposal,
  type ProposalContentInput,
} from "@/lib/services/proposals";
import { savePriceBookItem } from "@/lib/services/pricebook";

function message(err: unknown): string {
  if (err instanceof z.ZodError) return err.issues.map((i) => i.message).join(" ");
  if (err instanceof ValidationError || err instanceof ForbiddenError || err instanceof NotFoundError || err instanceof DraftError) {
    return err.message;
  }
  if (err instanceof Anthropic.RateLimitError) return "Claude is busy right now. Wait a minute and try again.";
  if (err instanceof Anthropic.AuthenticationError) return "The Anthropic API key isn't valid (ANTHROPIC_API_KEY).";
  if (err instanceof Anthropic.APIError) return `Claude couldn't draft this (${err.status}). Try again.`;
  console.error(err);
  return "Something went wrong. Please try again.";
}

export type GenerateState = { error?: string } | undefined;

export async function generateAction(leadId: string, _prev: GenerateState, fd: FormData): Promise<GenerateState> {
  const user = await requireUser();
  let id: string;
  try {
    const photos = await Promise.all(
      fd
        .getAll("photos")
        .filter((f): f is File => f instanceof File && f.size > 0)
        .map(async (f) => ({ body: Buffer.from(await f.arrayBuffer()), contentType: f.type })),
    );
    const margin = String(fd.get("targetMargin") ?? "").trim();
    const p = await generateProposal(
      user,
      leadId,
      {
        trade: String(fd.get("trade")) as never,
        notes: String(fd.get("notes") ?? ""),
        equipment: String(fd.get("equipment") ?? ""),
        targetMarginPercent: margin ? Number(margin) : null,
      },
      photos,
    );
    id = p.id;
  } catch (err) {
    return { error: message(err) };
  }
  revalidatePath(`/leads/${leadId}`);
  redirect(`/proposals/${id}`);
}

export async function blankProposalAction(leadId: string): Promise<GenerateState> {
  const user = await requireUser();
  let id: string;
  try {
    const empty = (tier: "good" | "better" | "best", title: string) => ({ tier, title, lineItems: [] });
    const content: ProposalContentInput = {
      summary: "",
      options: [empty("good", "Good"), empty("better", "Better"), empty("best", "Best")],
    };
    id = (await createProposalDraft(user, leadId, content)).id;
  } catch (err) {
    return { error: message(err) };
  }
  redirect(`/proposals/${id}`);
}

export async function saveProposalAction(id: string, payload: unknown): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await saveProposal(user, id, payload as never);
  } catch (err) {
    return { error: message(err) };
  }
  revalidatePath(`/proposals/${id}`);
  return {};
}

export async function sendProposalAction(
  id: string,
  textCustomer: boolean,
): Promise<{ error?: string; link?: string; texted?: boolean; textError?: string | null }> {
  const user = await requireUser();
  try {
    const res = await sendProposal(user, id, { textCustomer });
    revalidatePath(`/proposals/${id}`);
    return res;
  } catch (err) {
    return { error: message(err) };
  }
}

export async function reviseAction(id: string): Promise<{ error?: string }> {
  const user = await requireUser();
  let next: string;
  try {
    next = (await createRevision(user, id)).id;
  } catch (err) {
    return { error: message(err) };
  }
  redirect(`/proposals/${next}`);
}

/** From the editor: save a priced custom line to the price book so Claude can use it next time. */
export async function addToPriceBookAction(input: {
  trade: string;
  name: string;
  unit: string;
  priceCents: number;
}): Promise<{ error?: string; id?: string }> {
  const user = await requireUser();
  try {
    const item = await savePriceBookItem(user, {
      trade: input.trade as never,
      category: "material",
      name: input.name,
      unit: input.unit || "ea",
      costCents: null,
      priceCents: input.priceCents,
    });
    revalidatePath("/pricebook");
    return { id: item.id };
  } catch (err) {
    return { error: message(err) };
  }
}
