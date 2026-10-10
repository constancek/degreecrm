import { db } from "@/lib/db";
import { allowedEmails, ownerEmail } from "@/lib/env";

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
