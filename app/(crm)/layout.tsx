import Link from "next/link";
import { signOut } from "@/lib/auth";
import { requireUser } from "@/lib/session";
import { Plus } from "@/components/ui/icons";

export default async function CrmLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  const isTech = user.role === "tech";

  async function logout() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="bg-brand text-white">
        <div className="flex items-center gap-4 px-4 py-3 sm:gap-6">
          <Link href={isTech ? "/my-day" : "/pipeline"} className="font-semibold tracking-tight whitespace-nowrap">
            <span className="sm:hidden">DoC</span>
            <span className="hidden sm:inline">Degree of Comfort</span>
          </Link>
          {isTech ? (
            // Techs: their day and their calendar, nothing else to wander into.
            <nav className="flex gap-4 text-sm whitespace-nowrap text-white/80">
              <Link href="/my-day" className="hover:text-white">
                Today
              </Link>
              <Link href="/calendar" className="hover:text-white">
                Calendar
              </Link>
            </nav>
          ) : (
            <nav className="flex gap-3 overflow-x-auto text-sm whitespace-nowrap text-white/80 sm:gap-4">
              <Link href="/pipeline" className="hover:text-white">
                Pipeline
              </Link>
              <Link href="/calendar" className="hover:text-white">
                Calendar
              </Link>
              <Link href="/dispatch" className="hover:text-white">
                Dispatch
              </Link>
              <Link href="/jobs" className="hover:text-white">
                Jobs
              </Link>
              <Link href="/my-day" className="hover:text-white">
                My day
              </Link>
              <Link href="/pricebook" className="hover:text-white">
                Price book
              </Link>
              <Link href="/settings" className="hover:text-white">
                Settings
              </Link>
            </nav>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-3 text-sm">
            {isTech ? (
              <Link href="/settings" className="rounded px-2 py-1 whitespace-nowrap text-white/80 hover:bg-white/10 hover:text-white">
                Account
              </Link>
            ) : (
              <Link
                href="/leads/new"
                className="inline-flex min-h-9 items-center gap-1 rounded-md bg-white/15 px-2.5 font-medium whitespace-nowrap text-white hover:bg-white/25 md:px-3"
                aria-label="New lead"
              >
                <Plus />
                <span className="hidden md:inline">New lead</span>
              </Link>
            )}
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
