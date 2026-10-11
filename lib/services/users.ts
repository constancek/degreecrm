import { z } from "zod";
import { db } from "@/lib/db";
import { allowedEmails, ownerEmail } from "@/lib/env";
import { ForbiddenError, ValidationError, isOwner, type Actor } from "./actor";

/**
 * Who may sign in: OWNER_EMAIL, anyone in ALLOWED_EMAILS, or an active User row the owner added.
 * A deactivated User row blocks sign-in even if the email is in ALLOWED_EMAILS.
 */
export async function isAllowedToSignIn(rawEmail: string | null | undefined): Promise<boolean> {
  const email = rawEmail?.trim().toLowerCase();
  if (!email) return false;
  const user = await db.user.findUnique({ where: { email } });
  if (user) return user.active;
  return email === ownerEmail() || allowedEmails().includes(email);
}

/** Creates or refreshes the staff row on sign-in. OWNER_EMAIL always gets role owner. */
export async function upsertStaffUser(input: { email: string; name?: string | null; image?: string | null }) {
  const email = input.email.trim().toLowerCase();
  const isOwnerEmail = email === ownerEmail();
  return db.user.upsert({
    where: { email },
    create: {
      email,
      name: input.name || email.split("@")[0],
      image: input.image ?? null,
      role: isOwnerEmail ? "owner" : "tech",
      lastLoginAt: new Date(),
    },
    update: {
      image: input.image ?? undefined,
      lastLoginAt: new Date(),
      ...(isOwnerEmail ? { role: "owner" as const } : {}),
    },
  });
}

export async function listActiveStaff() {
  return db.user.findMany({ where: { active: true }, orderBy: [{ role: "asc" }, { name: "asc" }] });
}

/**
 * Owner adds a tech by Google address: an active User row lets them sign in (no ALLOWED_EMAILS change).
 * Re-adding a deactivated tech turns them back on.
 */
export async function addTech(actor: Actor, input: { name: string; email: string }) {
  if (!isOwner(actor)) throw new ForbiddenError("Only the owner can add a tech");
  const parsed = z
    .object({ name: z.string().trim().min(1, "Enter their name").max(100), email: z.string().trim().toLowerCase().email("Enter a valid email address") })
    .parse(input);
  if (parsed.email === ownerEmail()) throw new ValidationError("That's the owner's address");
  const existing = await db.user.findUnique({ where: { email: parsed.email } });
  if (existing?.role === "owner") throw new ValidationError("That address is already the owner");
  return existing
    ? db.user.update({ where: { id: existing.id }, data: { name: parsed.name, active: true } })
    : db.user.create({ data: { email: parsed.email, name: parsed.name, role: "tech" } });
}
