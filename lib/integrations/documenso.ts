// Documenso e-signature (hosted at app.documenso.com, or self-hosted) via its v1 REST API.
// https://app.documenso.com/api/v1/openapi.json

import { appUrl } from "@/lib/env";

export type SignField = {
  type: "SIGNATURE" | "DATE" | "NAME";
  pageNumber: number;
  /** Percent of the page (0–100). */
  pageX: number;
  pageY: number;
  pageWidth: number;
  pageHeight: number;
};

export type CreateSigningInput = {
  title: string;
  externalId: string;
  pdf: Buffer;
  signer: { name: string; email: string };
  redirectUrl: string;
  fields: SignField[];
};

export type DocumensoDocument = {
  id: number;
  status: string; // DRAFT | PENDING | COMPLETED | REJECTED
  completedAt: string | null;
  recipients: { email: string; name: string; signedAt?: string | null }[];
};

export interface DocumensoClient {
  createAndSend(input: CreateSigningInput): Promise<{ documentId: number; signingUrl: string }>;
  getDocument(id: number): Promise<DocumensoDocument>;
  downloadSigned(id: number): Promise<Buffer>;
}

export class DocumensoError extends Error {}

export function createDocumensoClient(baseUrl: string, apiKey: string): DocumensoClient {
  const base = baseUrl.replace(/\/$/, "");
  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${base}/api/v1${path}`, {
      ...init,
      headers: { authorization: apiKey, "content-type": "application/json", ...init.headers },
    });
    if (!res.ok) throw new DocumensoError(`Documenso ${init.method ?? "GET"} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  return {
    async createAndSend(input) {
      const created = await api<{
        uploadUrl: string;
        documentId: number;
        recipients: { recipientId: number; signingUrl: string }[];
      }>("/documents", {
        method: "POST",
        body: JSON.stringify({
          title: input.title,
          externalId: input.externalId,
          recipients: [{ name: input.signer.name, email: input.signer.email, role: "SIGNER" }],
          meta: {
            subject: input.title,
            message: "Please review and sign your proposal.",
            redirectUrl: input.redirectUrl,
            timezone: "America/New_York",
          },
        }),
      });
      const upload = await fetch(created.uploadUrl, {
        method: "PUT",
        headers: { "content-type": "application/pdf" },
        body: new Uint8Array(input.pdf),
      });
      if (!upload.ok) throw new DocumensoError(`Documenso upload failed: ${upload.status}`);
      const recipient = created.recipients[0];
      if (!recipient) throw new DocumensoError("Documenso returned no recipient");
      for (const f of input.fields) {
        await api(`/documents/${created.documentId}/fields`, {
          method: "POST",
          body: JSON.stringify({ recipientId: recipient.recipientId, ...f }),
        });
      }
      // We hand the customer the signing link ourselves; Documenso emails the signed copy when done.
      await api(`/documents/${created.documentId}/send`, {
        method: "POST",
        body: JSON.stringify({ sendEmail: false, sendCompletionEmails: true }),
      });
      return { documentId: created.documentId, signingUrl: recipient.signingUrl };
    },
    async getDocument(id) {
      return api<DocumensoDocument>(`/documents/${id}`);
    },
    async downloadSigned(id) {
      const { downloadUrl } = await api<{ downloadUrl: string }>(`/documents/${id}/download`);
      const res = await fetch(downloadUrl);
      if (!res.ok) throw new DocumensoError(`Signed PDF download failed: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

// ---- Mock (tests / MOCK_INTEGRATIONS=1) ---------------------------------------

type MockDoc = DocumensoDocument & { pdf: Buffer; redirectUrl: string };
const mockDocs: Map<number, MockDoc> = ((globalThis as Record<string, unknown>).__mockDocumenso ??= new Map()) as Map<number, MockDoc>;

export function createMockDocumensoClient(): DocumensoClient & { docs: Map<number, MockDoc>; complete(id: number): void } {
  return {
    docs: mockDocs,
    async createAndSend(input) {
      const id = 1000 + mockDocs.size + 1;
      mockDocs.set(id, {
        id,
        status: "PENDING",
        completedAt: null,
        recipients: [{ email: input.signer.email, name: input.signer.name, signedAt: null }],
        pdf: input.pdf,
        redirectUrl: input.redirectUrl,
      });
      return { documentId: id, signingUrl: `${appUrl()}/dev/mock-sign/${id}` };
    },
    async getDocument(id) {
      const d = mockDocs.get(id);
      if (!d) throw new DocumensoError("Not found");
      return { id: d.id, status: d.status, completedAt: d.completedAt, recipients: d.recipients };
    },
    async downloadSigned(id) {
      return mockDocs.get(id)?.pdf ?? Buffer.from("%PDF-1.4 mock");
    },
    complete(id) {
      const d = mockDocs.get(id);
      if (!d) return;
      const now = new Date().toISOString();
      d.status = "COMPLETED";
      d.completedAt = now;
      d.recipients = d.recipients.map((r) => ({ ...r, signedAt: now }));
    },
  };
}

export function mockIntegrations() {
  return process.env.MOCK_INTEGRATIONS === "1" && process.env.VERCEL_ENV !== "production";
}

let override: DocumensoClient | null = null;
export function setDocumensoClient(c: DocumensoClient | null) {
  override = c;
}

/** Null when Documenso isn't configured. */
export function getDocumensoClient(): DocumensoClient | null {
  if (override) return override;
  if (mockIntegrations()) return createMockDocumensoClient();
  const key = process.env.DOCUMENSO_API_KEY;
  if (!key) return null;
  return createDocumensoClient(process.env.DOCUMENSO_BASE_URL || "https://app.documenso.com", key);
}
