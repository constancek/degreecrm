import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { formatDateTime } from "@/lib/format";
import { requireUser } from "@/lib/session";
import { listActiveStaff } from "@/lib/services/users";
import { getDiscordStages, setDiscordStages } from "@/lib/services/settings";
import { STAGES } from "@/lib/stages";
import { formatPhone } from "@/lib/phone";
import { getCompany } from "@/lib/services/company";
import { PLACEHOLDER_KEY_TERMS, PLACEHOLDER_TERMS, currentTerms } from "@/lib/services/terms";
import { listTaxRates } from "@/lib/services/tax";
import { CompanySettings, TaxSettings, TermsSettings } from "./owner-settings";
import { CalendarPanel, IntegrationsPanel } from "./integrations";
import { connectionStatus, getIncomeAccountSetting, getQuickBooksClient } from "@/lib/services/quickbooks-auth";
import Link from "next/link";

export const metadata: Metadata = { title: "Settings" };

const isOwnerUser = (u: { role: string }) => u.role === "owner";

const NOTICES: Record<string, string> = {
  connected: "Connected.",
  cancelled: "Connection cancelled.",
  invalid: "That connection link expired. Try again.",
  failed: "The connection failed. Try again, and check the app credentials.",
  forbidden: "Only the owner can connect QuickBooks.",
};

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const user = await requireUser();
  const sp = await searchParams;
  const me = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  const qbo = await connectionStatus();
  const incomeAccount = await getIncomeAccountSetting();
  const incomeAccounts =
    isOwnerUser(user) && qbo.connected
      ? await getQuickBooksClient()
          .then((c) => c?.listIncomeAccounts() ?? null)
          .catch(() => null)
      : null;
  const isOwner = user.role === "owner";
  const [staff, discordStages, connections, company, terms, taxRates] = await Promise.all([
    isOwner ? listActiveStaff() : Promise.resolve([]),
    getDiscordStages(),
    db.oAuthToken.findMany({
      where: { userId: user.id, revokedAt: null, refreshExpiresAt: { gt: new Date() } },
      include: { client: true },
      orderBy: { createdAt: "desc" },
    }),
    getCompany(),
    currentTerms(),
    isOwner ? listTaxRates() : Promise.resolve([]),
  ]);

  async function disconnect(formData: FormData) {
    "use server";
    const me = await requireUser();
    await db.oAuthToken.updateMany({
      where: { userId: me.id, clientId: String(formData.get("clientId")), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    revalidatePath("/settings");
  }

  async function saveDiscord(formData: FormData) {
    "use server";
    const me = await requireUser();
    await setDiscordStages(me, formData.getAll("stage").map(String));
    revalidatePath("/settings");
  }

  // One row per connected client (refreshes create new token rows).
  const clients = [...new Map(connections.map((c) => [c.clientId, c])).values()];

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
      <h1 className="text-lg font-semibold">Settings</h1>

      <CalendarPanel
        connected={Boolean(me.googleRefreshToken)}
        email={me.googleCalendarEmail}
        connectedAt={me.googleCalendarConnectedAt}
        notice={typeof sp.calendar === "string" ? (NOTICES[sp.calendar] ?? null) : null}
      />

      {isOwner && (
        <IntegrationsPanel
          notice={typeof sp.quickbooks === "string" ? `QuickBooks: ${NOTICES[sp.quickbooks] ?? sp.quickbooks}` : null}
          incomeAccounts={incomeAccounts}
          incomeAccount={incomeAccount}
          quickbooks={{
            connected: qbo.connected,
            env: qbo.env,
            connectedAt: qbo.connected ? qbo.connectedAt : null,
            refreshExpiresAt: qbo.connected ? qbo.refreshExpiresAt : null,
          }}
          statuses={[
            { label: "Claude", ok: Boolean(process.env.ANTHROPIC_API_KEY), detail: "proposal drafting" },
            { label: "Email (Resend)", ok: Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM), detail: process.env.EMAIL_FROM ? `signed copies from ${process.env.EMAIL_FROM}` : "signed copies to customers" },
            { label: "Quo texting", ok: Boolean(process.env.QUO_API_KEY && process.env.QUO_INBOX_ID), detail: "" },
            { label: "Quo webhook secret", ok: Boolean(process.env.QUO_WEBHOOK_SECRET), detail: "for incoming texts" },
            { label: "Discord", ok: Boolean(process.env.DISCORD_SERVICE_WEBHOOK_URL), detail: "#degree-service-call" },
            { label: "Google Maps", ok: Boolean(process.env.GOOGLE_MAPS_API_KEY && process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY), detail: "geocoding, address search, dispatch map" },
            { label: "File storage", ok: Boolean(process.env.BLOB_READ_WRITE_TOKEN), detail: "Vercel Blob" },
          ]}
        />
      )}

      {isOwner && (
        <section className="card flex items-center justify-between p-4">
          <div>
            <h2 className="font-semibold">Automatic texts</h2>
            <p className="text-sm text-gray-600">Follow-ups, reminders and maintenance texts.</p>
          </div>
          <Link href="/settings/texts" className="btn-secondary">
            Edit texts
          </Link>
        </section>
      )}

      {isOwner && (
        <>
          <CompanySettings company={company} phoneDisplay={formatPhone(company.phone)} alertPhoneDisplay={formatPhone(company.ownerAlertPhone)} />
          <TermsSettings
            version={terms?.version ?? null}
            body={terms?.body ?? PLACEHOLDER_TERMS}
            keyTerms={terms?.keyTerms ?? PLACEHOLDER_KEY_TERMS}
          />
          <TaxSettings rates={taxRates.map((r) => ({ state: r.state, county: r.county, rateBps: r.rateBps }))} />
        </>
      )}

      <section className="card p-4">
        <h2 className="font-semibold">Connect Claude</h2>
        <p className="mt-1 text-sm text-gray-600">
          In Claude, open <em>Settings → Connectors → Add custom connector</em> and paste this URL. When Claude asks
          you to sign in, use the same Google account you use for the CRM.
        </p>
        <code className="mt-3 block rounded bg-gray-100 p-2 text-sm break-all">{appUrl()}/mcp</code>
        <h3 className="mt-4 text-sm font-semibold">Your connections</h3>
        {clients.length === 0 ? (
          <p className="mt-1 text-sm text-gray-500">None yet.</p>
        ) : (
          <ul className="mt-2 divide-y text-sm">
            {clients.map((c) => (
              <li key={c.clientId} className="flex items-center justify-between py-2">
                <span>
                  {c.client.name ?? c.clientId}
                  <span className="ml-2 text-gray-500">since {formatDateTime(c.createdAt)}</span>
                </span>
                <form action={disconnect}>
                  <input type="hidden" name="clientId" value={c.clientId} />
                  <button className="btn-secondary py-1 text-xs">Disconnect</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      {user.role === "owner" && (
        <section className="card p-4">
          <h2 className="font-semibold">Discord: #degree-service-call</h2>
          <p className="mt-1 text-sm text-gray-600">Post to the channel when a lead enters these stages.</p>
          <form action={saveDiscord} className="mt-3">
            <div className="grid gap-2 sm:grid-cols-2">
              {STAGES.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="stage" value={s.id} defaultChecked={discordStages.has(s.id)} />
                  {s.label}
                </label>
              ))}
            </div>
            <button className="btn-secondary mt-3">Save</button>
          </form>
        </section>
      )}

      {user.role === "owner" && (
        <section className="card p-4">
          <h2 className="font-semibold">Team</h2>
          <p className="mt-1 text-sm text-gray-600">
            To add a tech, add their Google address to <code>ALLOWED_EMAILS</code>. They appear here after their first
            sign-in.
          </p>
          <ul className="mt-2 divide-y text-sm">
            {staff.map((s) => (
              <li key={s.id} className="flex justify-between py-2">
                <span>
                  {s.name} <span className="text-gray-500">{s.email}</span>
                </span>
                <span className="text-gray-500">
                  {s.role}
                  {s.googleRefreshToken ? " · calendar connected" : " · calendar not connected"}
                  {s.lastLoginAt ? ` · last seen ${formatDateTime(s.lastLoginAt)}` : " · never signed in"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
