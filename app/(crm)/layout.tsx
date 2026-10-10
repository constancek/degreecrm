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
          <nav className="flex gap-3 overflow-x-auto text-sm whitespace-nowrap text-white/80 sm:gap-4">
            <Link href="/pipeline" className="hover:text-white">
              Pipeline
            </Link>
            {user.role === "owner" && (
              <Link href="/dispatch" className="hover:text-white">
                Dispatch
              </Link>
            )}
            <Link href="/jobs" className="hover:text-white">
              Jobs
            </Link>
            <Link href="/my-day" className="hover:text-white">
              My day
            </Link>
            <Link href="/pricebook" className="hidden hover:text-white lg:inline">
              Price book
            </Link>
            <Link href="/settings" className="hover:text-white">
              Settings
            </Link>
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-3 text-sm">
            <Link href="/leads/new" className="hidden rounded-md bg-white/15 px-3 py-1.5 font-medium whitespace-nowrap text-white hover:bg-white/25 md:inline-block">
              + New lead
            </Link>
            <span className="hidden whitespace-nowrap text-white/80 xl:inline">
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
