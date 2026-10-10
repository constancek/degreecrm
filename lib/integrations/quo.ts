// Quo (formerly OpenPhone) — outbound texts from the company number.
// https://www.quo.com/docs/api-reference/messages/send-a-text-message

export type SentText = { id: string | null; status: string | null };

export interface QuoClient {
  sendText(input: { to: string; content: string }): Promise<SentText>;
}

export class QuoError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function createQuoClient(apiKey: string, from: string): QuoClient {
  return {
    async sendText({ to, content }) {
      const res = await fetch("https://api.openphone.com/v1/messages", {
        method: "POST",
        headers: { authorization: apiKey, "content-type": "application/json" },
        body: JSON.stringify({ content, from, to: [to] }),
      });
      if (!res.ok) {
        throw new QuoError(`Quo send failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`, res.status);
      }
      const data = (await res.json().catch(() => ({}))) as { data?: { id?: string; status?: string } };
      return { id: data.data?.id ?? null, status: data.data?.status ?? null };
    },
  };
}

export function createMockQuoClient(): QuoClient & { sent: { to: string; content: string }[] } {
  const sent: { to: string; content: string }[] = [];
  return {
    sent,
    async sendText(input) {
      sent.push(input);
      return { id: `mock_${sent.length}`, status: "queued" };
    },
  };
}

let override: QuoClient | null = null;
export function setQuoClient(client: QuoClient | null) {
  override = client;
}

/** Null when Quo isn't configured. */
export function getQuoClient(): QuoClient | null {
  if (override) return override;
  const key = process.env.QUO_API_KEY;
  const from = process.env.QUO_INBOX_ID;
  if (!key || !from) {
    if (process.env.E2E_AUTH === "1") return logOnly;
    return null;
  }
  return createQuoClient(key, from);
}

const logOnly: QuoClient = {
  async sendText({ to, content }) {
    console.info("[quo:disabled]", to, content);
    return { id: null, status: "logged" };
  },
};
