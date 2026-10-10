import NextAuth, { type NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { e2eAuthEnabled } from "@/lib/env";
import { isAllowedToSignIn, upsertStaffUser } from "@/lib/services/users";

declare module "next-auth" {
  interface Session {
    user: { id: string; email: string; name?: string | null; image?: string | null };
  }
}

const providers: NextAuthConfig["providers"] = [Google];

// Password-less sign-in for Playwright. Only when E2E_AUTH=1 and never on Vercel production.
if (e2eAuthEnabled()) {
  providers.push(
    Credentials({
      id: "e2e",
      name: "Test login",
      credentials: { email: { label: "Email" } },
      async authorize(credentials) {
        const email = String(credentials?.email ?? "").toLowerCase();
        if (!(await isAllowedToSignIn(email))) return null;
        return { email, name: email.split("@")[0] };
      },
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  trustHost: true,
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  pages: { signIn: "/login", error: "/login" },
  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider === "google" && profile?.email_verified === false) return false;
      return isAllowedToSignIn(user.email);
    },
    async jwt({ token, user }) {
      if (user?.email) {
        const staff = await upsertStaffUser({ email: user.email, name: user.name, image: user.image });
        token.uid = staff.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (token.uid) session.user.id = token.uid as string;
      return session;
    },
  },
});

export const googleEnabled = Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
