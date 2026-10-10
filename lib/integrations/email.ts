// Outbound email through Resend (RESEND_API_KEY, EMAIL_FROM). https://resend.com/docs/api-reference/emails/send-email

export type EmailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  attachments?: { filename: string; content: Buffer }[];
};

export interface EmailClient {
  send(input: EmailInput): Promise<{ id: string | null }>;
}

export function createResendClient(apiKey: string, from: string): EmailClient {
  return {
    async send(input) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from,
          to: [input.to],
          subject: input.subject,
          text: input.text,
          html: input.html,
          reply_to: input.replyTo,
          attachments: input.attachments?.map((a) => ({ filename: a.filename, content: a.content.toString("base64") })),
        }),
      });
      if (!res.ok) throw new Error(`Email send failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json().catch(() => ({}))) as { id?: string };
      return { id: data.id ?? null };
    },
  };
}

export function createMockEmailClient(): EmailClient & { sent: EmailInput[] } {
  const sent: EmailInput[] = ((globalThis as Record<string, unknown>).__mockEmails ??= []) as EmailInput[];
  return {
    sent,
    async send(input) {
      sent.push(input);
      return { id: `mock_email_${sent.length}` };
    },
  };
}

let override: EmailClient | null = null;
export function setEmailClient(c: EmailClient | null) {
  override = c;
}

/** Null when email isn't configured. */
export function getEmailClient(): EmailClient | null {
  if (override) return override;
  if (process.env.MOCK_INTEGRATIONS === "1" && process.env.VERCEL_ENV !== "production") return createMockEmailClient();
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  return key && from ? createResendClient(key, from) : null;
}
