import { getBlobStore } from "@/lib/integrations/blob";
import { getCompany } from "@/lib/services/company";

// The company logo, served on both hosts (client pages and PDFs use it). Versioned URLs (?v=) cache forever.
export async function GET() {
  const company = await getCompany();
  const file = company.logoPath ? await getBlobStore().get(company.logoPath) : null;
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(file.body), {
    headers: { "content-type": file.contentType, "cache-control": "public, max-age=31536000, immutable" },
  });
}
