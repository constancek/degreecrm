import type { Role } from "@/generated/prisma/enums";

/** Who is performing an action. `system` covers the worker, website intake and client pages. */
export type Actor =
  | { kind: "user"; id: string; role: Role; name: string; email: string; via?: "web" | "mcp" }
  | { kind: "system"; label: string };

export const SYSTEM = (label: string): Actor => ({ kind: "system", label });

export function actorUserId(actor: Actor): string | null {
  return actor.kind === "user" ? actor.id : null;
}

export function isOwner(actor: Actor): boolean {
  return actor.kind === "system" || actor.role === "owner";
}

export class NotFoundError extends Error {
  constructor(what = "Not found") {
    super(what);
  }
}

export class ForbiddenError extends Error {
  constructor(what = "You don't have permission to do that") {
    super(what);
  }
}

export class ValidationError extends Error {}
