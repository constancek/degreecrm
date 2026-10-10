// Discord channel webhook (#degree-service-call). No bot, no OAuth — just a URL.
// https://discord.com/developers/docs/resources/webhook#execute-webhook

export type DiscordEmbed = {
  title: string;
  url?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  timestamp?: string;
};

export type DiscordMessage = {
  content?: string;
  embeds?: DiscordEmbed[];
};

export interface DiscordClient {
  send(message: DiscordMessage): Promise<void>;
}

export class DiscordError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export function createDiscordClient(webhookUrl: string): DiscordClient {
  return {
    async send(message) {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...message, allowed_mentions: { parse: [] } }),
      });
      if (!res.ok) {
        const retryAfter = Number(res.headers.get("retry-after"));
        throw new DiscordError(
          `Discord webhook failed: ${res.status} ${await res.text().catch(() => "")}`.trim(),
          res.status,
          Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
        );
      }
    },
  };
}

/** Records messages instead of sending them. Used in tests and when no webhook URL is set. */
export function createMockDiscordClient(): DiscordClient & { sent: DiscordMessage[] } {
  const sent: DiscordMessage[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}

let override: DiscordClient | null = null;

/** Swap the client in tests. */
export function setDiscordClient(client: DiscordClient | null) {
  override = client;
}

export function getDiscordClient(): DiscordClient {
  if (override) return override;
  const url = process.env.DISCORD_SERVICE_WEBHOOK_URL;
  if (!url) {
    return {
      async send(message) {
        console.info("[discord:disabled]", message.embeds?.[0]?.title ?? message.content);
      },
    };
  }
  return createDiscordClient(url);
}
