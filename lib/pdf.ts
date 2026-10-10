// Proposal PDFs: headless Chromium prints /print/proposal/[id] — the same components as the client page.
// Locally Playwright's downloaded Chromium is used; on Vercel, @sparticuz/chromium.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { getBlobStore } from "@/lib/integrations/blob";
import { getCompany } from "@/lib/services/company";

const PRINT_LINK_TTL_MS = 5 * 60 * 1000;

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return s;
}

function sign(proposalId: string, optionId: string, exp: number) {
  return createHmac("sha256", secret()).update(`print:${proposalId}:${optionId}:${exp}`).digest("base64url");
}

/** Short-lived signed URL the PDF renderer opens. */
export function printUrl(proposalId: string, optionId: string) {
  const exp = Date.now() + PRINT_LINK_TTL_MS;
  const qs = new URLSearchParams({ option: optionId, exp: String(exp), sig: sign(proposalId, optionId, exp) });
  return `${appUrl()}/print/proposal/${proposalId}?${qs}`;
}

export function verifyPrintSignature(proposalId: string, optionId: string, exp: string, sig: string): boolean {
  const expMs = Number(exp);
  if (!Number.isFinite(expMs) || expMs < Date.now()) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(proposalId, optionId, expMs));
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function renderUrlToPdf(url: string): Promise<Buffer> {
  const { chromium } = await import("playwright-core");
  let executablePath: string | undefined;
  let args: string[] | undefined;
  if (process.env.VERCEL) {
    const sparticuz = (await import("@sparticuz/chromium")).default;
    executablePath = await sparticuz.executablePath();
    args = sparticuz.args;
  }
  const browser = await chromium.launch({ executablePath, args, headless: true });
  try {
    const page = await browser.newPage();
    const res = await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    if (!res?.ok()) throw new Error(`Print page returned ${res?.status()}`);
    return await page.pdf({
      format: "Letter",
      printBackground: true,
      margin: { top: "0.5in", bottom: "0.6in", left: "0.5in", right: "0.5in" },
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate:
        '<div style="font-size:8px;width:100%;text-align:center;color:#6b7280">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
    });
  } finally {
    await browser.close();
  }
}

/**
 * The PDF for a proposal's option, cached in Blob. A sent proposal never changes (edits create a new
 * version), so the cache key only needs the option plus anything outside the proposal shown on it.
 */
export async function getProposalPdf(proposalId: string, optionId: string, opts: { cache: boolean }): Promise<Buffer> {
  const p = await db.proposal.findUniqueOrThrow({ where: { id: proposalId } });
  const company = await getCompany();
  const key = createHash("sha256")
    .update(JSON.stringify([optionId, p.version, p.termsVersionId, p.status === "draft" ? p.updatedAt : null, company]))
    .digest("hex")
    .slice(0, 24);
  const blob = getBlobStore();
  const path = `proposals/${p.id}/${key}.pdf`;

  if (opts.cache && p.pdfKey === key && p.pdfPath) {
    const cached = await blob.get(p.pdfPath);
    if (cached) return cached.body;
  }
  const pdf = await renderUrlToPdf(printUrl(p.id, optionId));
  if (opts.cache) {
    await blob.put(path, pdf, "application/pdf");
    await db.proposal.update({ where: { id: p.id }, data: { pdfPath: path, pdfKey: key } });
  }
  return pdf;
}
