"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/services/actor";
import { assignLead, changeStage, createLead, logNote, updateLead } from "@/lib/services/leads";
import type { LeadStage } from "@/generated/prisma/enums";

export type FormState = { error?: string } | undefined;

function message(err: unknown): string {
  if (err instanceof z.ZodError) return err.issues[0]?.message ?? "Please check the form";
  if (err instanceof ValidationError || err instanceof ForbiddenError || err instanceof NotFoundError) return err.message;
  console.error(err);
  return "Something went wrong. Please try again.";
}

const str = (fd: FormData, key: string) => {
  const v = fd.get(key);
  return typeof v === "string" ? v : undefined;
};

export async function createLeadAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  let leadId: string;
  try {
    const customerId = str(fd, "customerId") || undefined;
    const lead = await createLead(user, {
      customerId,
      customer: customerId
        ? undefined
        : {
            name: str(fd, "customerName") ?? "",
            phone: str(fd, "phone"),
            email: str(fd, "email"),
            type: str(fd, "customerType") === "commercial" ? "commercial" : "residential",
          },
      property: str(fd, "street")
        ? {
            street: str(fd, "street")!,
            unit: str(fd, "unit"),
            city: str(fd, "city"),
            state: str(fd, "state"),
            county: str(fd, "county"),
            zip: str(fd, "zip"),
            notes: str(fd, "propertyNotes"),
            lat: str(fd, "lat") || undefined,
            lng: str(fd, "lng") || undefined,
          }
        : undefined,
      title: str(fd, "title") ?? "",
      trade: str(fd, "trade") as never,
      source: (str(fd, "source") || "phone") as never,
      notes: str(fd, "notes"),
      assignedToId: str(fd, "assignedToId"),
    });
    leadId = lead.id;
  } catch (err) {
    return { error: message(err) };
  }
  revalidatePath("/pipeline");
  redirect(`/leads/${leadId}`);
}

export async function changeStageAction(
  leadId: string,
  stage: LeadStage,
  lostReason?: string,
): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await changeStage(user, leadId, stage, { lostReason });
  } catch (err) {
    return { error: message(err) };
  }
  revalidatePath("/pipeline");
  revalidatePath(`/leads/${leadId}`);
  return {};
}

export async function stageFormAction(leadId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return changeStageAction(leadId, str(fd, "stage") as LeadStage, str(fd, "lostReason"));
}

export async function assignAction(leadId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await assignLead(user, leadId, str(fd, "assignedToId") || null);
  } catch (err) {
    return { error: message(err) };
  }
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/pipeline");
  return {};
}

export async function noteAction(leadId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await logNote(user, leadId, str(fd, "body") ?? "");
  } catch (err) {
    return { error: message(err) };
  }
  revalidatePath(`/leads/${leadId}`);
  return {};
}

export async function updateLeadAction(leadId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await updateLead(user, leadId, {
      title: str(fd, "title"),
      trade: str(fd, "trade"),
      source: str(fd, "source"),
      notes: str(fd, "notes"),
    });
  } catch (err) {
    return { error: message(err) };
  }
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/pipeline");
  return {};
}

// ---- Pipeline drag: do the stage's real work -------------------------------------------

export async function planStageMoveAction(leadId: string, stage: LeadStage) {
  const user = await requireUser();
  const { planStageMove } = await import("@/lib/services/stage-moves");
  try {
    return { plan: await planStageMove(user, leadId, stage) };
  } catch (err) {
    return { error: message(err) };
  }
}

export async function performStageMoveAction(
  leadId: string,
  stage: LeadStage,
  payload: import("@/lib/services/stage-moves").StageMovePayload,
): Promise<{ error?: string }> {
  const user = await requireUser();
  const { performStageMove } = await import("@/lib/services/stage-moves");
  try {
    await performStageMove(user, leadId, stage, payload);
  } catch (err) {
    return { error: message(err) };
  }
  revalidatePath("/pipeline");
  revalidatePath(`/leads/${leadId}`);
  return {};
}
