import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import type { Actor } from "@/lib/services/actor";

export type StaffActor = Extract<Actor, { kind: "user" }>;

/**
 * The signed-in staff member, loaded fresh from the database each request so a role change or
 * deactivation applies immediately (the JWT only carries the user id).
 */
export const getCurrentUser = cache(async (): Promise<StaffActor | null> => {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  const user = await db.user.findUnique({ where: { id } });
  if (!user || !user.active) return null;
  return { kind: "user", id: user.id, role: user.role, name: user.name, email: user.email, via: "web" };
});

export async function requireUser(): Promise<StaffActor> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireOwner(): Promise<StaffActor> {
  const user = await requireUser();
  if (user.role !== "owner") redirect("/my-day");
  return user;
}

/** Office pages (pipeline, jobs, price book): techs work from Today instead. */
export async function requireOffice(): Promise<StaffActor> {
  const user = await requireUser();
  if (user.role === "tech") redirect("/my-day");
  return user;
}
