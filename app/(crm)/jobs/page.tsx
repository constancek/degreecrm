import type { Metadata } from "next";
import Link from "next/link";
import { requireOffice } from "@/lib/session";
import { listJobs } from "@/lib/services/jobs";
import { formatCents } from "@/lib/money";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Jobs" };

const ORDER = ["unscheduled", "scheduled", "in_progress", "completed", "invoiced", "paid", "cancelled"];

export default async function JobsPage() {
  const user = await requireOffice();
  const jobs = await listJobs(user);
  const groups = ORDER.map((status) => ({ status, jobs: jobs.filter((j) => j.status === status) })).filter((g) => g.jobs.length);
  return (
    <div className="mx-auto w-full max-w-5xl p-4">
      <h1 className="text-lg font-semibold">Jobs</h1>
      {jobs.length === 0 && <p className="mt-4 text-sm text-gray-500">No jobs yet. A job is created when a deposit is paid.</p>}
      {groups.map((g) => (
        <section key={g.status} className="mt-4">
          <h2 className="text-sm font-semibold tracking-wide text-gray-500 uppercase">
            {g.status.replace("_", " ")} ({g.jobs.length})
          </h2>
          <ul className="card mt-2 divide-y">
            {g.jobs.map((j) => {
              const next = j.visits.find((v) => v.end > new Date());
              return (
                <li key={j.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-sm">
                  <Link href={`/jobs/${j.id}`} className="font-medium text-brand hover:underline">
                    {j.lead.customer.name}
                  </Link>
                  <span className="text-gray-700">{j.title}</span>
                  <span className="text-gray-500">{j.lead.property?.street}</span>
                  <span className="ml-auto">{formatCents(j.totalCents)}</span>
                  <span className="w-40 text-right text-gray-500">{next ? formatDateTime(next.start) : j.status === "unscheduled" ? "Needs scheduling" : ""}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
