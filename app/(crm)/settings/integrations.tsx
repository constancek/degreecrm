import { appUrl } from "@/lib/env";
import { formatDateTime } from "@/lib/format";
import { disconnectCalendarAction, disconnectQuickBooksAction, setIncomeAccountAction } from "../ops-actions";

type Status = { label: string; ok: boolean; detail: string };

export function IntegrationsPanel(props: {
  quickbooks: { connected: boolean; env: string; connectedAt: string | null; refreshExpiresAt: string | null };
  incomeAccounts: { id: string; name: string }[] | null;
  incomeAccount: { id: string; name: string } | null;
  statuses: Status[];
  notice: string | null;
}) {
  const base = appUrl();
  return (
    <section className="card p-4" id="integrations">
      <h2 className="font-semibold">Integrations</h2>
      {props.notice && <p className="mt-2 rounded-md bg-blue-50 p-2 text-sm text-blue-800">{props.notice}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium">QuickBooks ({props.quickbooks.env})</span>
        {props.quickbooks.connected ? (
          <>
            <span className="text-green-700">Connected{props.quickbooks.connectedAt ? ` ${formatDateTime(props.quickbooks.connectedAt)}` : ""}</span>
            <form action={disconnectQuickBooksAction}>
              <button className="text-red-700 underline">Disconnect</button>
            </form>
          </>
        ) : (
          <a href="/api/quickbooks/connect" className="btn-primary">
            Connect QuickBooks
          </a>
        )}
      </div>
      <p className="mt-1 text-xs text-gray-500">Needed for card deposits, estimates and final invoices. Intuit redirect URI: {base}/api/quickbooks/callback</p>
      {props.quickbooks.connected && props.incomeAccounts && (
        <form action={setIncomeAccountAction} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
          <div>
            <label className="label" htmlFor="accountId">
              Income account for CRM sales (deposits, invoices)
            </label>
            <select id="accountId" name="accountId" className="input" defaultValue={props.incomeAccount?.id ?? ""}>
              <option value="" disabled>
                Choose an account…
              </option>
              {props.incomeAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <button className="btn-secondary">Save</button>
          {!props.incomeAccount && <p className="w-full text-xs text-amber-800">Not chosen yet: sales go to the first income account QuickBooks lists.</p>}
        </form>
      )}

      <ul className="mt-4 space-y-1 text-sm">
        {props.statuses.map((s) => (
          <li key={s.label}>
            <span className={s.ok ? "text-green-700" : "text-amber-800"}>{s.ok ? "✓" : "○"}</span> <span className="font-medium">{s.label}</span>{" "}
            <span className="text-gray-600">{s.detail}</span>
          </li>
        ))}
      </ul>

      <h3 className="mt-4 text-sm font-semibold">Webhook URLs to paste into each service</h3>
      <dl className="mt-1 grid gap-1 text-xs sm:grid-cols-[140px_1fr]">
        <dt className="text-gray-500">Documenso</dt>
        <dd className="break-all">{base}/api/webhooks/documenso (event: Document completed; secret: DOCUMENSO_WEBHOOK_SECRET)</dd>
        <dt className="text-gray-500">Quo</dt>
        <dd className="break-all">{base}/api/webhooks/quo (message received / delivered / failed)</dd>
        <dt className="text-gray-500">Financing email</dt>
        <dd className="break-all">{base}/api/webhooks/financing?secret=… (inbound email forwarder)</dd>
        <dt className="text-gray-500">Website form</dt>
        <dd className="break-all">{base}/api/intake/web</dd>
      </dl>
    </section>
  );
}

export function CalendarPanel(props: { connected: boolean; email: string | null; connectedAt: Date | null; notice: string | null }) {
  return (
    <section className="card p-4" id="calendar">
      <h2 className="font-semibold">Your Google Calendar</h2>
      <p className="mt-1 text-sm text-gray-600">Visits assigned to you appear on your own Google Calendar. Moving an event there updates the CRM.</p>
      {props.notice && <p className="mt-2 rounded-md bg-blue-50 p-2 text-sm text-blue-800">{props.notice}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        {props.connected ? (
          <>
            <span className="text-green-700">
              Connected{props.email ? ` as ${props.email}` : ""}
              {props.connectedAt ? ` · ${formatDateTime(props.connectedAt)}` : ""}
            </span>
            <form action={disconnectCalendarAction}>
              <button className="text-red-700 underline">Disconnect</button>
            </form>
          </>
        ) : (
          <a href="/api/google/connect" className="btn-primary">
            Connect Google Calendar
          </a>
        )}
      </div>
    </section>
  );
}
