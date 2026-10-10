// QuickBooks Online (accounting, the ledger of record) + QuickBooks Payments (card charges).
// OAuth tokens live encrypted in the Setting table (lib/services/quickbooks-auth.ts).

export type QboEnv = "sandbox" | "production";

export function qboEnv(): QboEnv {
  return process.env.QBO_ENV === "production" ? "production" : "sandbox";
}

export const QBO_URLS = {
  authorize: "https://appcenter.intuit.com/connect/oauth2",
  token: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
  revoke: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
  accounting: (env: QboEnv) => (env === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com"),
  payments: (env: QboEnv) => (env === "production" ? "https://api.intuit.com" : "https://sandbox.api.intuit.com"),
};

/** Browser posts card data here directly (never to our server). */
export function tokenizeUrl(): string {
  if (process.env.MOCK_INTEGRATIONS === "1" && process.env.VERCEL_ENV !== "production") return "/api/dev/qbo-token";
  return `${QBO_URLS.payments(qboEnv())}/quickbooks/v4/payments/tokens`;
}

export type QboLine = { description: string; qty: number; unitCents: number };
export type QboCustomerInput = {
  name: string;
  email: string | null;
  phone: string | null;
  address: { street: string; city: string; state: string; zip: string | null } | null;
};

export interface QuickBooksClient {
  listIncomeAccounts(): Promise<{ id: string; name: string }[]>;
  findOrCreateCustomer(c: QboCustomerInput): Promise<string>;
  createEstimate(input: { customerId: string; lines: QboLine[]; memo: string; email: string | null }): Promise<string>;
  /** Charge a card token. `requestId` makes retries safe (Intuit idempotency). */
  charge(input: { token: string; amountCents: number; requestId: string; description: string }): Promise<{ id: string; status: string; last4: string | null }>;
  /** Books a received payment in QBO: an invoice for `lines` plus a payment applied to it. */
  recordPayment(input: {
    customerId: string;
    lines: QboLine[];
    memo: string;
    chargeId: string | null;
    method: "card" | "check" | "cash" | "other";
    estimateId?: string | null;
  }): Promise<{ invoiceId: string; paymentId: string }>;
  createInvoice(input: { customerId: string; lines: QboLine[]; memo: string; email: string | null; estimateId?: string | null }): Promise<{ id: string; link: string | null }>;
  sendInvoice(id: string, email: string): Promise<void>;
  invoiceBalanceCents(id: string): Promise<number>;
}

export class QuickBooksError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
  }
}

const dollars = (cents: number) => Math.round(cents) / 100;
const escapeQuery = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export function createQuickBooksClient(opts: {
  realmId: string;
  getAccessToken: () => Promise<string>;
  env?: QboEnv;
  /** Income account all CRM sales post to (Settings → Integrations). */
  incomeAccountId?: string | null;
}): QuickBooksClient {
  const env = opts.env ?? qboEnv();
  const base = `${QBO_URLS.accounting(env)}/v3/company/${opts.realmId}`;

  async function qbo<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await opts.getAccessToken();
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${base}${path}${sep}minorversion=75`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json", ...init.headers },
    });
    const text = await res.text();
    if (!res.ok) throw new QuickBooksError(`QuickBooks ${init.method ?? "GET"} ${path.split("?")[0]}: ${res.status}`, res.status, text.slice(0, 500));
    return (text ? JSON.parse(text) : {}) as T;
  }
  const query = <T>(q: string) => qbo<{ QueryResponse: T }>(`/query?query=${encodeURIComponent(q)}`).then((r) => r.QueryResponse);

  let serviceItemId: string | null = null;
  /** The "CRM Services" item every line uses; its income account decides where sales land in the books. */
  async function serviceItem(): Promise<string> {
    if (serviceItemId) return serviceItemId;
    let accountId = opts.incomeAccountId ?? null;
    if (!accountId) {
      const income = await query<{ Account?: { Id: string }[] }>("select Id from Account where AccountType = 'Income' and Active = true maxresults 1");
      accountId = income.Account?.[0]?.Id ?? null;
    }
    if (!accountId) throw new QuickBooksError("No income account in QuickBooks to post services to", 400);
    const found = await query<{ Item?: { Id: string; SyncToken: string; IncomeAccountRef?: { value: string } }[] }>(
      "select * from Item where Name = 'CRM Services' and Active = true",
    );
    const item = found.Item?.[0];
    if (item) {
      if (item.IncomeAccountRef?.value !== accountId) {
        await qbo("/item", {
          method: "POST",
          body: JSON.stringify({ Id: item.Id, SyncToken: item.SyncToken, sparse: true, IncomeAccountRef: { value: accountId } }),
        });
      }
      return (serviceItemId = item.Id);
    }
    const created = await qbo<{ Item: { Id: string } }>("/item", {
      method: "POST",
      body: JSON.stringify({ Name: "CRM Services", Type: "Service", IncomeAccountRef: { value: accountId } }),
    });
    return (serviceItemId = created.Item.Id);
  }

  async function salesLines(lines: QboLine[]) {
    const item = await serviceItem();
    return lines.map((l) => ({
      DetailType: "SalesItemLineDetail",
      Amount: dollars(Math.round(l.qty * l.unitCents)),
      Description: l.description.slice(0, 4000),
      SalesItemLineDetail: { ItemRef: { value: item }, Qty: l.qty, UnitPrice: dollars(l.unitCents) },
    }));
  }

  return {
    async listIncomeAccounts() {
      const res = await query<{ Account?: { Id: string; Name: string; FullyQualifiedName?: string }[] }>(
        "select Id, Name, FullyQualifiedName from Account where AccountType = 'Income' and Active = true",
      );
      return (res.Account ?? []).map((a) => ({ id: a.Id, name: a.FullyQualifiedName ?? a.Name }));
    },
    async findOrCreateCustomer(c) {
      const name = c.name.slice(0, 100);
      const existing = await query<{ Customer?: { Id: string; PrimaryEmailAddr?: { Address?: string } }[] }>(
        `select Id, PrimaryEmailAddr from Customer where DisplayName = '${escapeQuery(name)}'`,
      );
      const match = existing.Customer?.find((x) => !c.email || !x.PrimaryEmailAddr?.Address || x.PrimaryEmailAddr.Address.toLowerCase() === c.email.toLowerCase());
      if (match) return match.Id;
      // DisplayName must be unique in QBO: disambiguate a different person with the same name.
      const displayName = existing.Customer?.length ? `${name} (${c.phone?.slice(-4) ?? c.email ?? "2"})` : name;
      const created = await qbo<{ Customer: { Id: string } }>("/customer", {
        method: "POST",
        body: JSON.stringify({
          DisplayName: displayName,
          PrimaryEmailAddr: c.email ? { Address: c.email } : undefined,
          PrimaryPhone: c.phone ? { FreeFormNumber: c.phone } : undefined,
          BillAddr: c.address
            ? { Line1: c.address.street, City: c.address.city, CountrySubDivisionCode: c.address.state, PostalCode: c.address.zip ?? undefined }
            : undefined,
        }),
      });
      return created.Customer.Id;
    },

    async createEstimate({ customerId, lines, memo, email }) {
      const res = await qbo<{ Estimate: { Id: string } }>("/estimate", {
        method: "POST",
        body: JSON.stringify({
          CustomerRef: { value: customerId },
          Line: await salesLines(lines),
          CustomerMemo: { value: memo.slice(0, 1000) },
          BillEmail: email ? { Address: email } : undefined,
          TxnStatus: "Accepted",
        }),
      });
      return res.Estimate.Id;
    },

    async charge({ token, amountCents, requestId, description }) {
      const accessToken = await opts.getAccessToken();
      const res = await fetch(`${QBO_URLS.payments(env)}/quickbooks/v4/payments/charges`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          accept: "application/json",
          "request-id": requestId.slice(0, 50),
        },
        body: JSON.stringify({
          amount: dollars(amountCents).toFixed(2),
          currency: "USD",
          token,
          capture: true,
          description: description.slice(0, 4000),
          context: { mobile: false, isEcommerce: true },
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        id?: string;
        status?: string;
        card?: { number?: string };
        errors?: { message?: string; detail?: string }[];
      };
      if (!res.ok || !body.id) {
        const msg = body.errors?.[0]?.detail || body.errors?.[0]?.message || `status ${res.status}`;
        throw new QuickBooksError(`Card charge failed: ${msg}`, res.status, JSON.stringify(body).slice(0, 500));
      }
      if (body.status && !["CAPTURED", "SETTLED", "AUTHORIZED"].includes(body.status)) {
        throw new QuickBooksError(`Card was ${body.status.toLowerCase()}`, 402);
      }
      return { id: body.id, status: body.status ?? "CAPTURED", last4: body.card?.number?.slice(-4) ?? null };
    },

    async recordPayment({ customerId, lines, memo, chargeId, method, estimateId }) {
      const invoice = await qbo<{ Invoice: { Id: string; TotalAmt: number } }>("/invoice", {
        method: "POST",
        body: JSON.stringify({
          CustomerRef: { value: customerId },
          Line: await salesLines(lines),
          PrivateNote: memo.slice(0, 4000),
          LinkedTxn: estimateId ? [{ TxnId: estimateId, TxnType: "Estimate" }] : undefined,
        }),
      });
      const payment = await qbo<{ Payment: { Id: string } }>("/payment", {
        method: "POST",
        body: JSON.stringify({
          CustomerRef: { value: customerId },
          TotalAmt: invoice.Invoice.TotalAmt,
          PrivateNote: memo.slice(0, 4000),
          PaymentRefNum: (chargeId ?? method).slice(0, 21),
          CreditCardPayment: chargeId ? { CreditChargeResponse: { CCTransId: chargeId, Status: "Completed" } } : undefined,
          TxnSource: chargeId ? "IntuitPayment" : undefined,
          Line: [{ Amount: invoice.Invoice.TotalAmt, LinkedTxn: [{ TxnId: invoice.Invoice.Id, TxnType: "Invoice" }] }],
        }),
      });
      return { invoiceId: invoice.Invoice.Id, paymentId: payment.Payment.Id };
    },

    async createInvoice({ customerId, lines, memo, email, estimateId }) {
      const res = await qbo<{ Invoice: { Id: string; InvoiceLink?: string } }>("/invoice?include=invoiceLink", {
        method: "POST",
        body: JSON.stringify({
          CustomerRef: { value: customerId },
          Line: await salesLines(lines),
          CustomerMemo: { value: memo.slice(0, 1000) },
          BillEmail: email ? { Address: email } : undefined,
          AllowOnlineCreditCardPayment: true,
          AllowOnlineACHPayment: true,
          LinkedTxn: estimateId ? [{ TxnId: estimateId, TxnType: "Estimate" }] : undefined,
        }),
      });
      return { id: res.Invoice.Id, link: res.Invoice.InvoiceLink ?? null };
    },

    async sendInvoice(id, email) {
      await qbo(`/invoice/${id}/send?sendTo=${encodeURIComponent(email)}`, { method: "POST", headers: { "content-type": "application/octet-stream" } });
    },

    async invoiceBalanceCents(id) {
      const res = await qbo<{ Invoice: { Balance: number } }>(`/invoice/${id}`);
      return Math.round(res.Invoice.Balance * 100);
    },
  };
}

// ---- Mock -----------------------------------------------------------------------

type MockState = { seq: number; charges: { amountCents: number; token: string; requestId: string }[]; invoices: Map<string, number>; sent: string[] };
const mockState: MockState = ((globalThis as Record<string, unknown>).__mockQbo ??= {
  seq: 0,
  charges: [],
  invoices: new Map(),
  sent: [],
}) as MockState;

export function createMockQuickBooksClient(): QuickBooksClient & { state: MockState } {
  const next = (p: string) => `${p}${++mockState.seq}`;
  return {
    state: mockState,
    async listIncomeAccounts() {
      return [
        { id: "1", name: "Services" },
        { id: "2", name: "Installation Income" },
      ];
    },
    async findOrCreateCustomer() {
      return next("cust");
    },
    async createEstimate() {
      return next("est");
    },
    async charge({ token, amountCents, requestId }) {
      if (token === "tok_declined") throw new QuickBooksError("Card charge failed: card declined", 402);
      const existing = mockState.charges.findIndex((c) => c.requestId === requestId);
      if (existing === -1) mockState.charges.push({ amountCents, token, requestId });
      return { id: `ch_${requestId}`, status: "CAPTURED", last4: "1111" };
    },
    async recordPayment() {
      return { invoiceId: next("inv"), paymentId: next("pay") };
    },
    async createInvoice({ lines }) {
      const id = next("inv");
      mockState.invoices.set(id, lines.reduce((s, l) => s + Math.round(l.qty * l.unitCents), 0));
      return { id, link: `https://example.com/invoice/${id}` };
    },
    async sendInvoice(id) {
      mockState.sent.push(id);
    },
    async invoiceBalanceCents(id) {
      return mockState.invoices.get(id) ?? 0;
    },
  };
}
