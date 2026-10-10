import { db } from "@/lib/db";
import { ForbiddenError, ValidationError, actorUserId, isOwner, type Actor } from "./actor";

export async function currentTerms() {
  return db.termsVersion.findFirst({ orderBy: { version: "desc" } });
}

export async function getTermsVersion(version: number) {
  return db.termsVersion.findUnique({ where: { version } });
}

/**
 * Saves the T&C as a new version when anything changed. Versions are never edited in place, so a
 * signed proposal always points at exactly the text the client agreed to.
 */
export async function saveTerms(actor: Actor, input: { body: string; keyTerms: string }) {
  if (!isOwner(actor)) throw new ForbiddenError("Only the owner can change the Terms & Conditions");
  const body = input.body.trim();
  const keyTerms = input.keyTerms
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
  if (body.length < 50) throw new ValidationError("The Terms & Conditions look too short");
  if (!keyTerms) throw new ValidationError("Add at least one key term line");
  if (keyTerms.split("\n").length > 10) throw new ValidationError("Keep key terms to 10 lines or fewer");

  const current = await currentTerms();
  if (current && current.body === body && current.keyTerms === keyTerms) return current;
  return db.termsVersion.create({
    data: { version: (current?.version ?? 0) + 1, body, keyTerms, createdById: actorUserId(actor) },
  });
}

/** Key-term lines with {deposit} and {expires} filled in. */
export function renderKeyTerms(keyTerms: string, vars: { depositPercent: number; expires: string | null }): string[] {
  return keyTerms
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replaceAll("{deposit}", `${vars.depositPercent}%`).replaceAll("{expires}", vars.expires ?? "30 days after it's sent"));
}

export const PLACEHOLDER_KEY_TERMS = [
  "A {deposit} deposit is due when you approve; the balance is due when the work is complete.",
  "Pricing is valid until {expires}.",
  "We'll schedule your job within a few days of receiving the deposit.",
  "Labor warranty is as listed in the option you choose; equipment carries the manufacturer's warranty.",
  "Permits and inspections listed in your option are included.",
  "Changes to the scope after approval are quoted separately before any extra work.",
].join("\n");

export const PLACEHOLDER_TERMS = `# Terms & Conditions

> **DRAFT: needs review by an attorney before use with customers.**

## 1. Scope of work
Degree of Comfort ("we") will perform the work described in the option you select. Work not listed is not included.

## 2. Payment
A deposit is due on approval. The remaining balance is due on completion. Late balances may incur a fee as permitted by Ohio law.

## 3. Pricing
Prices are valid until the expiration date on your proposal. Sales tax is calculated for the job address.

## 4. Changes
Any change to the scope must be agreed in writing (including electronically) before the extra work begins.

## 5. Site access and conditions
You agree to provide safe access to the work areas. Prices assume the conditions listed under "Assumptions"; hidden conditions found during the work (for example, damaged framing or code violations) may require a change order.

## 6. Warranty
Labor is warranted for the period stated in your selected option. Equipment and parts carry the manufacturer's warranty. Warranties do not cover misuse, lack of maintenance or damage by others.

## 7. Permits
Where required, we obtain permits and schedule inspections. Permit fees are included only when listed.

## 8. Cancellation
You may cancel within three business days of approval for a full refund of your deposit, as provided by Ohio's Home Solicitation Sales Act where it applies.

## 9. Limitation of liability
Our liability is limited to the amount paid for the work, except where the law does not allow this limitation.
`;
