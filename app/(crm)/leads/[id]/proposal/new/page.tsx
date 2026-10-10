import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getLead } from "@/lib/services/leads";
import { NotFoundError } from "@/lib/services/actor";
import { listPriceBook } from "@/lib/services/pricebook";
import { GenerateForm } from "./generate-form";

export const metadata: Metadata = { title: "New proposal" };
// Claude can take a minute or two to draft three options.
export const maxDuration = 300;

export default async function NewProposalPage({ params }: PageProps<"/leads/[id]/proposal/new">) {
  const user = await requireUser();
  const { id } = await params;
  const lead = await getLead(user, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const bookSize = (await listPriceBook({ trade: lead.trade })).length;

  return (
    <div className="mx-auto w-full max-w-3xl p-4">
      <Link href={`/leads/${lead.id}`} className="text-sm text-brand hover:underline">
        ← {lead.customer.name}
      </Link>
      <h1 className="mt-1 text-xl font-semibold">New proposal: {lead.title}</h1>
      {bookSize === 0 && (
        <p className="mt-3 rounded-md bg-amber-50 p-3 text-sm text-amber-800">
          Your price book has no items for this trade yet, so every line Claude drafts will need a price.{" "}
          <Link href="/pricebook" className="underline">
            Add items
          </Link>{" "}
          first for better drafts.
        </p>
      )}
      <GenerateForm leadId={lead.id} trade={lead.trade} />
    </div>
  );
}
