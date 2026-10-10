// E-signature with Documenso (SPEC.md "E-signature with Documenso").
// The PDF the customer signs is the same one they can download: the selected option + key terms + T&C.

import { z } from "zod";
import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { normalizeEmail } from "@/lib/phone";
import { getBlobStore } from "@/lib/integrations/blob";
import { getDocumensoClient } from "@/lib/integrations/documenso";
import { getProposalPdf, pdfPageCount, SIGNATURE_FIELDS } from "@/lib/pdf";
import { leadStageEmbed } from "@/lib/notifications/discord-embeds";
import { formatCents } from "@/lib/money";
import { SYSTEM, ValidationError } from "./actor";
import { recordActivity } from "./activity";
import { changeStage } from "./leads";
import { enqueueDiscord, flushOutboxSoon } from "./outbox";
import { alertOwner } from "./messages";
import { stopEnrollments } from "./sequences";
import { proposalLink } from "./proposals";
import type { ClientProposal } from "./client-proposals";

const customer = SYSTEM("Customer");

export const signInput = z.object({
  optionId: z.string().min(1),
  name: z.string().trim().min(2, "Enter your full name").max(200),
  email: z.string().trim().min(3, "Enter your email so we can send you the signed copy").max(200),
  termsAccepted: z.literal(true, { message: "Please agree to the Terms & Conditions" }),
});

/** Starts (or resumes) signing and returns the URL to send the customer to. */
export async function startSigning(
  p: ClientProposal,
  raw: z.input<typeof signInput>,
  meta: { ip: string | null; userAgent: string | null },
): Promise<string> {
  const input = signInput.parse(raw);
  const email = normalizeEmail(input.email);
  if (!email) throw new ValidationError("That email address doesn't look right");
  if (p.status === "signed") throw new ValidationError("This proposal is already signed");
  const option = p.options.find((o) => o.id === input.optionId);
  if (!option) throw new ValidationError("Choose an option first");
  if (!p.terms) throw new ValidationError("This proposal has no Terms & Conditions attached");

  const documenso = getDocumensoClient();
  if (!documenso) throw new ValidationError("Online signing isn't available yet. Please call us to approve.");

  // Same option, same signer, already started: send them back to the same document.
  if (p.documensoDocumentId && p.signingUrl && p.signedOptionId === option.id) {
    const doc = await documenso.getDocument(p.documensoDocumentId).catch(() => null);
    if (doc && doc.status !== "REJECTED" && doc.recipients[0]?.email.toLowerCase() === email) return p.signingUrl;
  }

  if (!p.lead.customer.email) await db.customer.update({ where: { id: p.lead.customerId }, data: { email } });
  await db.proposal.update({ where: { id: p.id }, data: { selectedOptionId: option.id } });

  const pdf = await getProposalPdf(p.id, option.id, { cache: true });
  const lastPage = pdfPageCount(pdf);
  const { documentId, signingUrl } = await documenso.createAndSend({
    title: `Degree of Comfort proposal v${p.version}: ${p.lead.title}`.slice(0, 200),
    externalId: p.id,
    pdf,
    signer: { name: input.name, email },
    redirectUrl: `${proposalLink(p.token!)}?signed=1`,
    fields: [
      { type: "SIGNATURE", pageNumber: lastPage, ...SIGNATURE_FIELDS.signature },
      { type: "DATE", pageNumber: lastPage, ...SIGNATURE_FIELDS.date },
      { type: "NAME", pageNumber: lastPage, ...SIGNATURE_FIELDS.name },
    ],
  });

  await db.$transaction(async (tx) => {
    await tx.proposal.update({
      where: { id: p.id },
      data: { documensoDocumentId: documentId, signingUrl, signedOptionId: option.id },
    });
    await recordActivity(tx, customer, {
      type: "sign_started",
      leadId: p.leadId,
      body: `Started signing "${option.title}"`,
      data: {
        proposalId: p.id,
        optionId: option.id,
        signerName: input.name,
        signerEmail: email,
        termsVersion: p.terms!.version,
        termsAcceptedAt: new Date().toISOString(),
        documensoDocumentId: documentId,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    });
  });
  return signingUrl;
}

/**
 * Called by the Documenso webhook and when the customer returns from signing. Idempotent: checks with
 * Documenso, stores the sealed PDF, writes the Signature row and moves the lead to estimate_approved.
 */
export async function completeSigning(proposalId: string): Promise<boolean> {
  const p = await db.proposal.findUnique({
    where: { id: proposalId },
    include: { lead: { include: { customer: true, property: true, assignedTo: { select: { name: true } } } }, terms: true, options: true },
  });
  if (!p || !p.documensoDocumentId) return false;
  if (p.status === "signed") return true;
  const documenso = getDocumensoClient();
  if (!documenso) return false;
  const doc = await documenso.getDocument(p.documensoDocumentId);
  if (doc.status !== "COMPLETED") return false;

  const started = await db.activity.findFirst({
    where: { type: "sign_started", data: { path: ["documensoDocumentId"], equals: p.documensoDocumentId } },
    orderBy: { createdAt: "desc" },
  });
  const s = (started?.data ?? {}) as Record<string, string | number | null>;
  const recipient = doc.recipients[0];
  const signedAt = recipient?.signedAt ? new Date(recipient.signedAt) : doc.completedAt ? new Date(doc.completedAt) : new Date();

  let signedPdfPath: string | null = null;
  try {
    const sealed = await documenso.downloadSigned(p.documensoDocumentId);
    signedPdfPath = `proposals/${p.id}/signed-${p.documensoDocumentId}.pdf`;
    await getBlobStore().put(signedPdfPath, sealed, "application/pdf");
  } catch (err) {
    console.error("[documenso download]", err);
  }

  const optionId = p.signedOptionId ?? p.selectedOptionId!;
  const option = p.options.find((o) => o.id === optionId);
  const claimed = await db.$transaction(async (tx) => {
    const res = await tx.proposal.updateMany({
      where: { id: p.id, status: { not: "signed" } },
      data: { status: "signed", signedAt, selectedOptionId: optionId, signedOptionId: optionId },
    });
    if (res.count === 0) return false;
    await tx.signature.create({
      data: {
        proposalId: p.id,
        optionId,
        signerName: String(s.signerName ?? recipient?.name ?? p.lead.customer.name),
        signerEmail: String(s.signerEmail ?? recipient?.email ?? ""),
        ip: (s.ip as string | null) ?? null,
        userAgent: (s.userAgent as string | null) ?? null,
        signedAt,
        termsVersion: Number(s.termsVersion ?? p.terms?.version ?? 0),
        termsAcceptedAt: s.termsAcceptedAt ? new Date(String(s.termsAcceptedAt)) : signedAt,
        signedPdfPath,
      },
    });
    // Older live versions can't be signed any more.
    await tx.proposal.updateMany({ where: { leadId: p.leadId, id: { not: p.id }, status: { in: ["sent", "viewed", "draft"] } }, data: { status: "superseded" } });
    await recordActivity(tx, customer, {
      type: "proposal_signed",
      leadId: p.leadId,
      body: `Signed "${option?.title}" (${formatCents(option?.totalCents ?? 0)})`,
      data: { proposalId: p.id, optionId, documensoDocumentId: p.documensoDocumentId },
    });
    const embed = leadStageEmbed({ ...p.lead, stage: "estimate_approved" });
    embed.embeds![0]!.title = `Signed: ${p.lead.title} — ${option?.title} ${formatCents(option?.totalCents ?? 0)}`;
    await enqueueDiscord(tx, embed);
    return true;
  });
  if (!claimed) return true;

  await changeStage(SYSTEM("E-signature"), p.leadId, "estimate_approved");
  await stopEnrollments({ leadId: p.leadId }, "proposal signed");
  await flushOutboxSoon();
  await alertOwner(`${p.lead.customer.name} signed "${option?.title}" (${formatCents(option?.totalCents ?? 0)}). ${appUrl()}/leads/${p.leadId}`);

  // Paper trail in QuickBooks (customer + estimate); failures are logged for the owner, not shown to the customer.
  const { ensureQuickBooksEstimate } = await import("./payments");
  await ensureQuickBooksEstimate(p.id).catch((e) => console.error("[qbo estimate]", e));
  return true;
}

/** Documenso webhook: shared-secret header. */
export function documensoSecretValid(header: string | null) {
  const secret = process.env.DOCUMENSO_WEBHOOK_SECRET;
  return Boolean(secret && header && header === secret);
}
