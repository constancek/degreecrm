import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/markdown/markdown";
import { getCompany } from "@/lib/services/company";
import { getTermsVersion } from "@/lib/services/terms";

export const metadata: Metadata = {
  title: { absolute: "Terms & Conditions" },
  robots: { index: false, follow: false },
};

export default async function TermsPage({ params }: PageProps<"/terms/[version]">) {
  const { version } = await params;
  const n = Number(version.replace(/^v/, ""));
  const [terms, company] = await Promise.all([Number.isInteger(n) ? getTermsVersion(n) : null, getCompany()]);
  if (!terms) notFound();
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 bg-white px-4 py-8 sm:px-8">
      <p className="text-sm font-semibold text-brand">{company.name}</p>
      <p className="mb-6 text-xs text-gray-500">Version {terms.version}</p>
      <Markdown>{terms.body}</Markdown>
    </main>
  );
}
