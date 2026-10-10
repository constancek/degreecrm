import type { Metadata } from "next";

// Client proposal page (go. host). Built in Phase 2; for now every link shows the expired message.
export const metadata: Metadata = {
  title: "Your proposal from Degree of Comfort",
  openGraph: { title: "Your proposal from Degree of Comfort" },
};

export default function ProposalPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="card max-w-md p-8 text-center">
        <p className="font-semibold text-brand">Degree of Comfort</p>
        <h1 className="mt-4 text-lg font-semibold">This proposal link isn&apos;t active</h1>
        <p className="mt-2 text-sm text-gray-600">Please call us and we&apos;ll send you an updated proposal.</p>
      </div>
    </main>
  );
}
