import { db } from "@/lib/db";
import type { StaffActor } from "@/lib/session";

export async function resetDb() {
  await db.$executeRawUnsafe(
    `TRUNCATE "LineItem", "ProposalOption", "Proposal", "LeadPhoto", "Setting", "Activity", "OutboxEvent", "OAuthToken", "OAuthCode", "OAuthClient", "Lead", "Property", "Customer", "User" CASCADE`,
  );
}

export async function makeUser(role: "owner" | "tech", email: string): Promise<StaffActor> {
  const u = await db.user.create({ data: { name: email.split("@")[0]!, email, role } });
  return { kind: "user", id: u.id, role: u.role, name: u.name, email: u.email, via: "web" };
}
