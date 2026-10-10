// Built-in e-signature (ESIGN Act / Ohio UETA, ORC ch. 1306): the customer signs on the proposal page.
// Evidence kept: consent to sign electronically, T&C acceptance, phone check, signature (drawn or typed),
// name/email, IP, device, timestamps, a fingerprint of what was agreed, and a signed PDF with an audit page.

import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { normalizeEmail } from "@/lib/phone";
import { formatCents } from "@/lib/money";
import { getBlobStore } from "@/lib/integrations/blob";
import { getEmailClient } from "@/lib/integrations/email";
import { renderUrlToPdf, printUrl } from "@/lib/pdf";
import { leadStageEmbed } from "@/lib/notifications/discord-embeds";
import { ForbiddenError, SYSTEM, ValidationError, isOwner, type Actor } from "./actor";
import { recordActivity } from "./activity";
import { changeStage } from "./leads";
import { enqueueDiscord, flushOutboxSoon } from "./outbox";
import { alertOwner, sendCustomerText } from "./messages";
import { stopEnrollments } from "./sequences";
import { proposalLink } from "./proposals";
import { getCompany } from "./company";
import type { ClientProposal } from "./client-proposals";

const MAX_SIGNATURE_BYTES = 300_000;

export const signInput = z
  .object({
    optionId: z.string().min(1),
    name: z.string().trim().min(2, "Enter your full name").max(200),
    email: z.string().trim().min(3, "Enter your email so we can send you the signed copy").max(200),
    termsAccepted: z.literal(true, { message: "Please agree to the Terms & Conditions" }),
    esignConsent: z.literal(true, { message: "Please agree to sign electronically" }),
    signature: z.discriminatedUnion("type", [
      z.object({ type: z.literal("drawn"), dataUrl: z.string().startsWith("data:image/png;base64,") }),
      z.object({ type: z.literal("typed"), text: z.string().trim().min(2, "Type your signature").max(100) }),
    ]),
  });
export type SignInput = z.input<typeof signInput>;

/** Fingerprint of exactly what was agreed: option, lines, totals, deposit, terms version + text. */
export function agreementHash(input: {
  proposalId: string;
  version: number;
  option: { id: string; title: string; totalCents: number; taxCents: number; lineItems: { description: string; qty: number; unit: string; unitCents: number; isOptional: boolean }[] };
  terms: { version: number; body: string; keyTerms: string } | null;
}): string {
  const canonical = JSON.stringify({
    proposal: input.proposalId,
    version: input.version,
    option: {
      id: input.option.id,
      title: input.option.title,
      totalCents: input.option.totalCents,
      taxCents: input.option.taxCents,
      lines: input.option.lineItems.map((l) => [l.description, l.qty, l.unit, l.unitCents, l.isOptional]),
    },
    terms: input.terms ? { version: input.terms.version, body: input.terms.body, keyTerms: input.terms.keyTerms } : null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function decodeSignatureImage(dataUrl: string): Buffer {
  const buf = Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
  if (buf.length < 100 || buf.length > MAX_SIGNATURE_BYTES) throw new ValidationError("Please draw your signature again");
  if (buf.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new ValidationError("Please draw your signature again");
  return buf;
}

/** The customer signs on the proposal page. Returns once the signature is recorded; the PDF follows. */
export async function signProposal(p: ClientProposal, raw: SignInput, meta: { ip: string | null; userAgent: string | null; phoneVerified: boolean }) {
  const input = signInput.parse(raw);
  const email = normalizeEmail(input.email);
  if (!email) throw new ValidationError("That email address doesn't look right");
  if (p.status === "signed") throw new ValidationError("This proposal is already signed");
  const option = p.options.find((o) => o.id === input.optionId);
  if (!option) throw new ValidationError("Choose an option first");
  if (!p.terms) throw new ValidationError("This proposal has no Terms & Conditions attached");

  let signatureImagePath: string | null = null;
  if (input.signature.type === "drawn") {
    const png = decodeSignatureImage(input.signature.dataUrl);
    signatureImagePath = `proposals/${p.id}/signature.png`;
    await getBlobStore().put(signatureImagePath, png, "image/png");
  }
  if (!p.lead.customer.email) await db.customer.update({ where: { id: p.lead.customerId }, data: { email } });

  const termsChecked = await db.activity.findFirst({
    where: { type: "terms_checked", leadId: p.leadId, data: { path: ["proposalId"], equals: p.id } },
    orderBy: { createdAt: "desc" },
  });
  const now = new Date();
  const signed = await finalizeSignature({
    proposalId: p.id,
    optionId: option.id,
    actor: SYSTEM("Customer"),
    signature: {
      method: input.signature.type,
      typedSignature: input.signature.type === "typed" ? input.signature.text : null,
      signatureImagePath,
      signerName: input.name,
      signerEmail: email,
      ip: meta.ip,
      userAgent: meta.userAgent,
      phoneVerified: meta.phoneVerified,
      consentAt: now,
      signedAt: now,
      termsAcceptedAt: termsChecked?.createdAt ?? now,
      recordedById: null,
    },
  });
  // Someone else (or another tab) signed first.
  if (!signed) throw new ValidationError("This proposal is already signed");
  await deliverSignedCopySoon(p.id);
  return signed;
}

/** Owner records that the customer signed a paper copy (or approved another way). */
export async function recordPaperApproval(actor: Actor, proposalId: string, input: { optionId: string; signerName: string; note?: string }) {
  if (!isOwner(actor)) throw new ForbiddenError("Only the owner can record an approval");
  const p = await db.proposal.findUnique({ where: { id: proposalId }, include: { lead: { include: { customer: true } } } });
  if (!p) throw new ValidationError("Proposal not found");
  if (p.status === "signed") throw new ValidationError("This proposal is already signed");
  if (p.status === "draft") throw new ValidationError("Send the proposal first");
  if (!input.signerName.trim()) throw new ValidationError("Enter who signed");
  const now = new Date();
  const ok = await finalizeSignature({
    proposalId,
    optionId: input.optionId,
    actor,
    signature: {
      method: "paper",
      typedSignature: null,
      signatureImagePath: null,
      signerName: input.signerName.trim(),
      signerEmail: p.lead.customer.email ?? "",
      ip: null,
      userAgent: input.note ? `Recorded by owner: ${input.note}` : "Recorded by owner",
      phoneVerified: false,
      consentAt: null,
      signedAt: now,
      termsAcceptedAt: now,
      recordedById: actor.kind === "user" ? actor.id : null,
    },
  });
  if (ok) await deliverSignedCopySoon(proposalId);
  return ok;
}

type SignatureFields = {
  method: string;
  typedSignature: string | null;
  signatureImagePath: string | null;
  signerName: string;
  signerEmail: string;
  ip: string | null;
  userAgent: string | null;
  phoneVerified: boolean;
  consentAt: Date | null;
  signedAt: Date;
  termsAcceptedAt: Date;
  recordedById: string | null;
};

/** Records the signature once (idempotent) and runs everything that follows a signed proposal. */
async function finalizeSignature(args: { proposalId: string; optionId: string; actor: Actor; signature: SignatureFields }): Promise<boolean> {
  const p = await db.proposal.findUniqueOrThrow({
    where: { id: args.proposalId },
    include: {
      options: { include: { lineItems: { orderBy: { sortOrder: "asc" } } } },
      lead: { include: { customer: true, property: true, assignedTo: { select: { name: true } } } },
      terms: true,
    },
  });
  const option = p.options.find((o) => o.id === args.optionId);
  if (!option) throw new ValidationError("Choose an option first");
  const contentHash = agreementHash({ proposalId: p.id, version: p.version, option, terms: p.terms });

  const claimed = await db.$transaction(async (tx) => {
    const res = await tx.proposal.updateMany({
      where: { id: p.id, status: { in: ["sent", "viewed"] } },
      data: { status: "signed", signedAt: args.signature.signedAt, selectedOptionId: option.id, signedOptionId: option.id },
    });
    if (res.count === 0) return false;
    await tx.signature.create({
      data: { proposalId: p.id, optionId: option.id, termsVersion: p.terms?.version ?? 0, contentHash, ...args.signature },
    });
    // Older live versions can't be signed any more.
    await tx.proposal.updateMany({ where: { leadId: p.leadId, id: { not: p.id }, status: { in: ["sent", "viewed", "draft"] } }, data: { status: "superseded" } });
    await recordActivity(tx, args.actor, {
      type: "proposal_signed",
      leadId: p.leadId,
      body: `Signed "${option.title}" (${formatCents(option.totalCents)})${args.signature.method === "paper" ? " on paper" : ""}`,
      data: { proposalId: p.id, optionId: option.id, method: args.signature.method, ip: args.signature.ip, contentHash },
    });
    const embed = leadStageEmbed({ ...p.lead, stage: "estimate_approved" });
    embed.embeds![0]!.title = `Signed: ${p.lead.title} — ${option.title} ${formatCents(option.totalCents)}`;
    await enqueueDiscord(tx, embed);
    return true;
  });
  if (!claimed) return false;

  await changeStage(SYSTEM("E-signature"), p.leadId, "estimate_approved");
  await stopEnrollments({ leadId: p.leadId }, "proposal signed");
  await flushOutboxSoon();
  await alertOwner(`${p.lead.customer.name} signed "${option.title}" (${formatCents(option.totalCents)}). ${appUrl()}/leads/${p.leadId}`);
  // Paper trail in QuickBooks (customer + estimate); failures are logged for the owner, not shown to the customer.
  const { ensureQuickBooksEstimate } = await import("./payments");
  await ensureQuickBooksEstimate(p.id).catch((e) => console.error("[qbo estimate]", e));
  return true;
}

// ---- Signed copy ------------------------------------------------------------------------

async function deliverSignedCopySoon(proposalId: string) {
  const run = () => deliverSignedCopy(proposalId).catch((e) => console.error("[signed copy]", e));
  try {
    const { after } = await import("next/server");
    after(run);
  } catch {
    await run();
  }
}

/** Renders the signed PDF (signature + audit page), stores it with its hash, and sends the customer a copy. */
export async function deliverSignedCopy(proposalId: string) {
  const sig = await db.signature.findUnique({ where: { proposalId } });
  if (!sig) return;
  const p = await db.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { lead: { include: { customer: true } } } });

  let pdf: Buffer | null = null;
  if (!sig.signedPdfPath) {
    pdf = await renderUrlToPdf(printUrl(p.id, sig.optionId));
    const path = `proposals/${p.id}/signed-v${p.version}.pdf`;
    await getBlobStore().put(path, pdf, "application/pdf");
    await db.signature.update({
      where: { id: sig.id },
      data: { signedPdfPath: path, signedPdfHash: createHash("sha256").update(pdf).digest("hex") },
    });
  }
  if (sig.copySentAt || sig.method === "paper") return;

  pdf ??= (await getBlobStore().get(sig.signedPdfPath!))?.body ?? null;
  const company = await getCompany();
  const link = p.token ? proposalLink(p.token) : null;
  const first = p.lead.customer.name.split(/\s+/)[0];
  const email = getEmailClient();
  if (email && sig.signerEmail && pdf) {
    await email.send({
      to: sig.signerEmail,
      subject: `Your signed proposal from ${company.name}`,
      text: `Hi ${first},\n\nThank you for choosing ${company.name}! Your signed proposal is attached.${link ? `\n\nYou can also view it and pay your deposit here: ${link}` : ""}\n\n${company.name}${company.phone ? `\n${company.phone}` : ""}`,
      replyTo: company.email || undefined,
      attachments: [{ filename: `${company.name.replace(/\W+/g, "-")}-signed-proposal-v${p.version}.pdf`, content: pdf }],
    });
  }
  if (link) {
    await sendCustomerText(SYSTEM("E-signature"), {
      customerId: p.lead.customerId,
      leadId: p.leadId,
      body: `Thanks ${first}! Your proposal is signed. Your copy${email ? " is in your email and" : " is"} here, along with the deposit step: ${link}`,
    });
  }
  await db.signature.update({ where: { id: sig.id }, data: { copySentAt: new Date() } });
}

/** Scheduler: retry signed copies that failed to render or send. */
export async function retrySignedCopies(limit = 5) {
  const pending = await db.signature.findMany({
    where: { OR: [{ signedPdfPath: null }, { copySentAt: null, method: { not: "paper" } }], signedAt: { lt: new Date(Date.now() - 2 * 60_000) } },
    select: { proposalId: true },
    take: limit,
  });
  for (const s of pending) await deliverSignedCopy(s.proposalId).catch((e) => console.error("[signed copy retry]", e));
  return pending.length;
}
