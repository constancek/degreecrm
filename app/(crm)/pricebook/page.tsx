import type { Metadata } from "next";
import { requireUser } from "@/lib/session";
import { listPriceBook } from "@/lib/services/pricebook";
import { PriceBookEditor } from "./pricebook-editor";

export const metadata: Metadata = { title: "Price book" };

export default async function PriceBookPage({ searchParams }: PageProps<"/pricebook">) {
  const user = await requireUser();
  const { inactive } = await searchParams;
  const items = await listPriceBook({ includeInactive: inactive === "1" });
  return (
    <div className="mx-auto w-full max-w-6xl p-4">
      <h1 className="text-lg font-semibold">Price book</h1>
      <p className="mt-1 text-sm text-gray-600">
        Claude builds proposals only from these items and never invents prices. Anything missing is flagged &ldquo;needs
        price&rdquo; in the draft.
      </p>
      <PriceBookEditor
        canEdit={user.role === "owner"}
        showInactive={inactive === "1"}
        items={items.map((i) => ({
          id: i.id,
          trade: i.trade,
          category: i.category,
          name: i.name,
          description: i.description ?? "",
          sku: i.sku ?? "",
          unit: i.unit,
          costCents: i.costCents,
          priceCents: i.priceCents,
          active: i.active,
        }))}
      />
    </div>
  );
}
