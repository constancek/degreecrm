import Link from "next/link";
import { signOut } from "@/lib/auth";
import { requireUser } from "@/lib/session";

export default async function CrmLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();

  async function logout() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="bg-brand text-white">
        <div className="flex items-center gap-4 px-4 py-3 sm:gap-6">
          <Link href="/pipeline" className="font-semibold tracking-tight whitespace-nowrap">
            <span className="sm:hidden">DoC</span>
            <span className="hidden sm:inline">Degree of Comfort</span>
          </Link>
          <nav className="flex gap-3 text-sm whitespace-nowrap text-white/80 sm:gap-4">
            <Link href="/pipeline" className="hover:text-white">
              Pipeline
            </Link>
            <Link href="/leads/new" className="hover:text-white">
              New lead
            </Link>
            <Link href="/pricebook" className="hover:text-white">
              Price book
            </Link>
            <Link href="/settings" className="hover:text-white">
              Settings
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden text-white/80 sm:inline">
              {user.name} · {user.role}
            </span>
            <form action={logout}>
              <button className="rounded px-2 py-1 whitespace-nowrap text-white/80 hover:bg-white/10 hover:text-white">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
