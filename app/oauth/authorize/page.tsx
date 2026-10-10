import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { issueAuthorizationCode, validateAuthorizeRequest } from "@/lib/oauth/server";

export const metadata: Metadata = { title: "Connect Claude" };

function flatten(sp: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
}

export default async function AuthorizePage({ searchParams }: PageProps<"/oauth/authorize">) {
  const query = flatten(await searchParams);
  const qs = new URLSearchParams(query as Record<string, string>).toString();

  // Staff sign in with Google first; the connector then acts as that CRM user.
  const user = await getCurrentUser();
  if (!user) redirect(`/login?callbackUrl=${encodeURIComponent(`/oauth/authorize?${qs}`)}`);

  const result = await validateAuthorizeRequest(query);
  if ("redirect" in result) redirect(result.redirect);
  if ("fatal" in result) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">Can&apos;t connect</h1>
        <p className="mt-2 text-sm text-gray-600">{result.fatal}</p>
      </Shell>
    );
  }
  const params = result.ok;

  async function approve() {
    "use server";
    // Re-validate on submit; the page could have been open for a while.
    const me = await getCurrentUser();
    if (!me) redirect(`/login?callbackUrl=${encodeURIComponent(`/oauth/authorize?${qs}`)}`);
    const again = await validateAuthorizeRequest(query);
    if (!("ok" in again)) redirect(`/oauth/authorize?${qs}`);
    redirect(await issueAuthorizationCode(me, again.ok));
  }

  async function deny() {
    "use server";
    const u = new URL(params.redirectUri);
    u.searchParams.set("error", "access_denied");
    if (params.state) u.searchParams.set("state", params.state);
    redirect(u.toString());
  }

  return (
    <Shell>
      <h1 className="text-lg font-semibold">Connect {params.clientName ?? "Claude"} to the CRM?</h1>
      <p className="mt-2 text-sm text-gray-600">
        It will act as <strong>{user.name}</strong> ({user.email}, {user.role}) and can do what you can do in the CRM:
        look up leads, create leads and add notes. Every action is logged on the lead.
      </p>
      <p className="mt-2 text-xs text-gray-500">Redirects to {new URL(params.redirectUri).host}</p>
      <div className="mt-6 flex gap-3">
        <form action={approve}>
          <button className="btn-primary">Allow</button>
        </form>
        <form action={deny}>
          <button className="btn-secondary">Cancel</button>
        </form>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="card w-full max-w-md p-8">
        <p className="mb-4 text-sm font-semibold text-brand">Degree of Comfort</p>
        {children}
      </div>
    </main>
  );
}
