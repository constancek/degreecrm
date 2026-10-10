import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { formatDateTime } from "@/lib/format";
import { requireUser } from "@/lib/session";
import { listActiveStaff } from "@/lib/services/users";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await requireUser();
  const [staff, connections] = await Promise.all([
    user.role === "owner" ? listActiveStaff() : Promise.resolve([]),
    db.oAuthToken.findMany({
      where: { userId: user.id, revokedAt: null, refreshExpiresAt: { gt: new Date() } },
      include: { client: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  async function disconnect(formData: FormData) {
    "use server";
    const me = await requireUser();
    await db.oAuthToken.updateMany({
      where: { userId: me.id, clientId: String(formData.get("clientId")), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    revalidatePath("/settings");
  }

  // One row per connected client (refreshes create new token rows).
  const clients = [...new Map(connections.map((c) => [c.clientId, c])).values()];

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
      <h1 className="text-lg font-semibold">Settings</h1>

      <section className="card p-4">
        <h2 className="font-semibold">Connect Claude</h2>
        <p className="mt-1 text-sm text-gray-600">
          In Claude, open <em>Settings → Connectors → Add custom connector</em> and paste this URL. When Claude asks
          you to sign in, use the same Google account you use for the CRM.
        </p>
        <code className="mt-3 block rounded bg-gray-100 p-2 text-sm break-all">{appUrl()}/mcp</code>
        <h3 className="mt-4 text-sm font-semibold">Your connections</h3>
        {clients.length === 0 ? (
          <p className="mt-1 text-sm text-gray-500">None yet.</p>
        ) : (
          <ul className="mt-2 divide-y text-sm">
            {clients.map((c) => (
              <li key={c.clientId} className="flex items-center justify-between py-2">
                <span>
                  {c.client.name ?? c.clientId}
                  <span className="ml-2 text-gray-500">since {formatDateTime(c.createdAt)}</span>
                </span>
                <form action={disconnect}>
                  <input type="hidden" name="clientId" value={c.clientId} />
                  <button className="btn-secondary py-1 text-xs">Disconnect</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      {user.role === "owner" && (
        <section className="card p-4">
          <h2 className="font-semibold">Team</h2>
          <p className="mt-1 text-sm text-gray-600">
            To add a tech, add their Google address to <code>ALLOWED_EMAILS</code>. They appear here after their first
            sign-in.
          </p>
          <ul className="mt-2 divide-y text-sm">
            {staff.map((s) => (
              <li key={s.id} className="flex justify-between py-2">
                <span>
                  {s.name} <span className="text-gray-500">{s.email}</span>
                </span>
                <span className="text-gray-500">
                  {s.role}
                  {s.lastLoginAt ? ` · last seen ${formatDateTime(s.lastLoginAt)}` : " · never signed in"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
