import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { googleEnabled, signIn } from "@/lib/auth";
import { e2eAuthEnabled } from "@/lib/env";
import { getCurrentUser } from "@/lib/session";

export const metadata: Metadata = { title: "Sign in" };

/** Only allow same-site relative redirects. */
function safeCallback(raw: string | string[] | undefined): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v && v.startsWith("/") && !v.startsWith("//") ? v : "/pipeline";
}

const ERRORS: Record<string, string> = {
  AccessDenied: "That Google account isn't on the staff list. Ask the owner to add you.",
  CredentialsSignin: "That account isn't on the staff list.",
  Configuration: "Sign-in isn't configured correctly. Check the AUTH_* environment variables.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const callbackUrl = safeCallback(params.callbackUrl);
  if (await getCurrentUser()) redirect(callbackUrl);

  const errorKey = typeof params.error === "string" ? params.error : undefined;
  const error = errorKey ? (ERRORS[errorKey] ?? "Sign-in failed. Please try again.") : undefined;

  async function google() {
    "use server";
    await signIn("google", { redirectTo: callbackUrl });
  }

  async function testLogin(formData: FormData) {
    "use server";
    try {
      await signIn("e2e", { email: formData.get("email"), redirectTo: callbackUrl });
    } catch (e) {
      if (e instanceof AuthError) redirect(`/login?error=${e.type}&callbackUrl=${encodeURIComponent(callbackUrl)}`);
      throw e;
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="card w-full max-w-sm p-8">
        <h1 className="text-xl font-semibold text-brand">Degree of Comfort</h1>
        <p className="mt-1 text-sm text-gray-500">Staff sign-in</p>

        {error && <p className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}

        {googleEnabled ? (
          <form action={google} className="mt-6">
            <button className="btn-primary w-full" type="submit">
              Sign in with Google
            </button>
          </form>
        ) : (
          <p className="mt-6 rounded-md bg-amber-50 p-3 text-sm text-amber-800">
            Google sign-in isn&apos;t configured yet (AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET).
          </p>
        )}

        {e2eAuthEnabled() && (
          <form action={testLogin} className="mt-6 border-t pt-6">
            <label className="label" htmlFor="email">
              Test login (E2E_AUTH)
            </label>
            <input id="email" name="email" type="email" className="input" required />
            <button className="btn-secondary mt-3 w-full" type="submit">
              Sign in without Google
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
