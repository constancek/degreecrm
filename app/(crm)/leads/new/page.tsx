import type { Metadata } from "next";
import { requireUser } from "@/lib/session";
import { listActiveStaff } from "@/lib/services/users";
import { NewLeadForm } from "./new-lead-form";

export const metadata: Metadata = { title: "New lead" };

export default async function NewLeadPage() {
  const user = await requireUser();
  const staff = user.role === "owner" ? await listActiveStaff() : [];
  return (
    <div className="mx-auto w-full max-w-3xl p-4">
      <h1 className="mb-4 text-lg font-semibold">New lead</h1>
      <NewLeadForm staff={staff.map((s) => ({ id: s.id, name: s.name }))} canAssign={user.role === "owner"} />
    </div>
  );
}
