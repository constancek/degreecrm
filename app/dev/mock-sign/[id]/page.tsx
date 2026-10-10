import { notFound, redirect } from "next/navigation";
import { createMockDocumensoClient, mockIntegrations } from "@/lib/integrations/documenso";

// Stands in for Documenso's signing page when MOCK_INTEGRATIONS=1 (tests).
export default async function MockSign({ params }: PageProps<"/dev/mock-sign/[id]">) {
  if (!mockIntegrations()) notFound();
  const { id } = await params;
  const client = createMockDocumensoClient();
  const doc = client.docs.get(Number(id));
  if (!doc) notFound();

  async function sign() {
    "use server";
    const c = createMockDocumensoClient();
    c.complete(Number(id));
    redirect(c.docs.get(Number(id))!.redirectUrl);
  }

  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="text-lg font-semibold">Mock Documenso</h1>
      <p className="text-sm text-gray-600">Signing as {doc.recipients[0]?.name}</p>
      <form action={sign}>
        <button className="btn-primary mt-4">Complete signing</button>
      </form>
    </main>
  );
}
