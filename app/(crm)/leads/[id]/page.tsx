import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getLead } from "@/lib/services/leads";
import { NotFoundError } from "@/lib/services/actor";
import { listActiveStaff } from "@/lib/services/users";
import { SOURCES, stageInfo, tradeLabel } from "@/lib/stages";
import { formatPhone } from "@/lib/phone";
import { formatDateTime, timeAgo } from "@/lib/format";
import { formatAddress } from "@/lib/notifications/discord-embeds";
import { AssignForm, LeadDetailsForm, NoteForm, StageForm } from "./lead-forms";

export const metadata: Metadata = { title: "Lead" };

export default async function LeadPage({ params }: PageProps<"/leads/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  const lead = await getLead(user, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const staff = user.role === "owner" ? await listActiveStaff() : [];
  const address = formatAddress(lead.property);

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4 p-4 lg:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        <div>
          <Link href="/pipeline" className="text-sm text-brand hover:underline">
            ← Pipeline
          </Link>
          <h1 className="mt-1 text-xl font-semibold">{lead.title}</h1>
          <p className="text-sm text-gray-500">
            {tradeLabel(lead.trade)} · {SOURCES.find((s) => s.id === lead.source)?.label} · created{" "}
            {formatDateTime(lead.createdAt)}
          </p>
        </div>

        <section className="card grid gap-4 p-4 sm:grid-cols-2">
          <div>
            <h2 className="text-xs font-semibold tracking-wide text-gray-500 uppercase">Customer</h2>
            <p className="mt-1 font-medium">{lead.customer.name}</p>
            <p className="text-sm text-gray-600 capitalize">{lead.customer.type}</p>
            {lead.customer.phone && (
              <a href={`tel:${lead.customer.phone}`} className="block text-sm text-brand hover:underline">
                {formatPhone(lead.customer.phone)}
              </a>
            )}
            {lead.customer.email && (
              <a href={`mailto:${lead.customer.email}`} className="block text-sm text-brand hover:underline">
                {lead.customer.email}
              </a>
            )}
          </div>
          <div>
            <h2 className="text-xs font-semibold tracking-wide text-gray-500 uppercase">Property</h2>
            {lead.property ? (
              <>
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 block text-sm text-brand hover:underline"
                >
                  {address}
                </a>
                {lead.property.notes && <p className="mt-1 text-sm text-gray-600">{lead.property.notes}</p>}
              </>
            ) : (
              <p className="mt-1 text-sm text-gray-500">No address yet</p>
            )}
          </div>
        </section>

        <LeadDetailsForm
          leadId={lead.id}
          title={lead.title}
          trade={lead.trade}
          source={lead.source}
          notes={lead.notes ?? ""}
        />

        <section className="card p-4">
          <h2 className="mb-3 font-semibold">Activity</h2>
          <NoteForm leadId={lead.id} />
          <ol className="mt-4 space-y-3" aria-label="Activity timeline">
            {lead.activities.map((a) => (
              <li key={a.id} className="border-l-2 border-gray-200 pl-3 text-sm">
                <p className="text-gray-800">
                  <span className="font-medium">{a.user?.name ?? systemLabel(a.data)}</span>{" "}
                  {describeActivity(a.type, a.data)}
                  {(a.data as { via?: string } | null)?.via === "mcp" && (
                    <span className="ml-1 rounded bg-violet-100 px-1 text-xs text-violet-800">via Claude</span>
                  )}
                </p>
                {a.body && <p className="mt-0.5 whitespace-pre-wrap text-gray-600">{a.body}</p>}
                <p className="text-xs text-gray-400" title={formatDateTime(a.createdAt)}>
                  {timeAgo(a.createdAt)}
                </p>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <aside className="space-y-4">
        <section className="card p-4">
          <h2 className="text-xs font-semibold tracking-wide text-gray-500 uppercase">Stage</h2>
          <p className="mt-1 text-lg font-semibold">{stageInfo(lead.stage).label}</p>
          {lead.lostReason && <p className="text-sm text-gray-600">Reason: {lead.lostReason}</p>}
          <p className="text-xs text-gray-500">since {formatDateTime(lead.stageChangedAt)}</p>
          <StageForm key={lead.stage} leadId={lead.id} stage={lead.stage} />
        </section>
        <section className="card p-4">
          <h2 className="text-xs font-semibold tracking-wide text-gray-500 uppercase">Assigned to</h2>
          {user.role === "owner" ? (
            <AssignForm
              leadId={lead.id}
              assignedToId={lead.assignedToId}
              staff={staff.map((s) => ({ id: s.id, name: s.name }))}
            />
          ) : (
            <p className="mt-1">{lead.assignedTo?.name ?? "Unassigned"}</p>
          )}
        </section>
      </aside>
    </div>
  );
}

function systemLabel(data: unknown): string {
  const label = (data as { system?: string } | null)?.system;
  return label ? label : "System";
}

function describeActivity(type: string, data: unknown): string {
  const d = (data ?? {}) as Record<string, string>;
  switch (type) {
    case "lead_created":
      return "created the lead";
    case "customer_created":
      return "created the customer";
    case "stage_changed":
      return `moved it from ${stageInfo(d.from as never)?.label ?? d.from} to ${stageInfo(d.to as never)?.label ?? d.to}`;
    case "assigned":
      return "changed the assignment";
    case "note":
      return "added a note";
    case "lead_updated":
      return `updated ${(d.fields as unknown as string[] | undefined)?.join(", ") ?? "details"}`;
    case "web_form":
      return "submitted the website form";
    default:
      return type.replace(/_/g, " ");
  }
}
