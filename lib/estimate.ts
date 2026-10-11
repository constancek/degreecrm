// Client-safe choices for the customer's estimate page (no server imports).

/** Reasons a customer can give when declining (plus "Other" with a note). */
export const DECLINE_REASONS = ["Price is too high", "Getting other quotes", "Not doing the work right now", "Decided to do it myself", "Other"] as const;

/** Ways to pay the deposit after signing. */
export const DEPOSIT_CHOICES = ["card", "ach", "check", "financing"] as const;
export type DepositChoice = (typeof DEPOSIT_CHOICES)[number];

/** "#1001", or "#1001 · rev 2" for a revision. */
export function estimateNumber(p: { number: number; version: number }) {
  return `#${p.number}${p.version > 1 ? ` · rev ${p.version}` : ""}`;
}
