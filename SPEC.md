# Degree of Comfort CRM — Build Spec

Oct 9, 2026 · @Constance K

## Overview

A single Next.js app on Railway that takes a lead from first call to paid, scheduled job: Claude drafts a Good/Better/Best proposal, the client signs and pays on a branded page, and the job lands on the assigned worker's Google Calendar.

Decisions already made:

| Area | Decision |
| --- | --- |
| Business | Degree of Comfort, Cincinnati: residential + commercial HVAC, plumbing, electrical |
| Users | 1–3 people (owner + techs); simple roles: `owner`, `tech` |
| Stack | Next.js (App Router) + TypeScript + Postgres + Prisma, hosted on Vercel (Postgres via Neon; Documenso on Railway) |
| Domains | `app.cincydegreeofcomfort.com` (CRM, login) · `go.cincydegreeofcomfort.com` (client proposal pages, no login) · `sign.cincydegreeofcomfort.com` (Documenso) |
| Proposals | Claude API drafts Good/Better/Best; client picks one; selected option is downloadable as PDF |
| E-signature | Documenso, self-hosted on Railway (one-click template), called via its REST API |
| Payments | QuickBooks Payments API (v4) with client-side tokenization; QuickBooks Online stays the ledger of record |
| Scheduling | Jobs assigned to a tech are written to that tech's own Google Calendar via OAuth |
| SMS | Quo API for drip follow-ups, confirmations, on-my-way and review texts |
| V1 scope | Lead → proposal → sign → pay → schedule, plus Quo drips and a multi-tech dispatch board with map |
| Out of V1 | Housecall Pro import, inventory, payroll, customer portal login |

## Architecture

> **Hosting decision (2026-10-09):** the `web` app runs on Vercel instead of Railway; the `worker` becomes Vercel Cron hitting `/api/cron/tick` every minute (`npm run worker` still exists for local use or a Railway worker). Postgres comes from Neon via the Vercel Marketplace. Documenso still runs from its Railway template. The Railway table below describes the original plan.

System architecture: 1 app, 5 outside services (Claude API, Documenso API, QuickBooks, Google Calendar/Maps, Quo, plus a Discord webhook).

Everything the business owns runs in one Railway project; the five outside services are called over their APIs and never hold the CRM's data.

| Service on Railway | What it is | Domain |
| --- | --- | --- |
| `web` | Next.js app, serves both the CRM and the client pages (host-based routing) | `app.` and `go.cincydegreeofcomfort.com` |
| `postgres` | Railway Postgres, Prisma migrations | internal |
| `worker` | Same codebase, `npm run worker`: runs every minute for due SMS steps, calendar sync, PDF rendering | internal |
| `documenso` | Official Railway template (app + its own Postgres) | `sign.cincydegreeofcomfort.com` |

Auth: NextAuth with Google sign-in for the 1–3 staff users; client pages use signed tokens, no accounts. Secrets live in Railway variables. Files (proposal PDFs, signed PDFs, photos) go to a Railway bucket or S3-compatible store, never in Postgres.

## Data model

Twelve Prisma models cover V1; every money field is an integer in cents, every timestamp is UTC, and every table has `createdAt`, `updatedAt`.

| Model | Key fields | Notes |
| --- | --- | --- |
| `User` | name, email, role (`owner` / `tech`), googleRefreshToken, phone | Staff only; techs link their own Google account |
| `Customer` | name, email, phone, type (`residential` / `commercial`), quickbooksId | One record per household or business |
| `Property` | customerId, address, lat, lng, notes (access, equipment on site) | Jobs attach to a property, not a customer |
| `Lead` | customerId, propertyId, source, trade (`hvac` / `plumbing` / `electrical`), stage, notes, assignedTo | Stage enum drives the pipeline board and drips |
| `Proposal` | leadId, token (random 24+ chars), status, selectedOptionId, expiresAt, viewedAt, signedAt, pdfUrl, documensoDocumentId | One proposal per version; a revision creates a new row |
| `ProposalOption` | proposalId, tier (`good` / `better` / `best`), title, summary, totalCents, warrantyText, sortOrder | Exactly three per proposal |
| `LineItem` | optionId, description, qty, unitCents, isOptional | What the PDF and page list |
| `Signature` | proposalId, signerName, signerEmail, ip, userAgent, signedAt, certificateUrl, termsVersion, termsAcceptedAt | Mirrors Documenso's audit trail locally |
| `Payment` | proposalId, kind (`deposit` / `progress` / `final`), amountCents, status, quickbooksChargeId, quickbooksPaymentId, cardLast4 | Written from the Payments API response |
| `Job` | leadId, proposalId, propertyId, status, scheduledStart, scheduledEnd, assignedTo, googleEventId | Created when the deposit clears |
| `Visit` | jobId, techId, start, end, status, googleEventId, startedAt, completedAt | Multi-day jobs have several visits; each syncs to the tech's calendar |
| `Sequence` / `SequenceStep` / `Enrollment` / `Message` | step: delayHours, template; enrollment: leadId, nextSendAt, stoppedReason; message: direction, body, quoMessageId | Drips and the full SMS log per lead |

**Job pipeline** (`Lead.stage`, in order; every change writes an `Activity` row and can fire a text and a Discord post):

| # | Stage | Enters when | Automations |
| --- | --- | --- | --- |
| 1 | `new` | Lead created (call, web form, MCP) | Owner notified; Discord post |
| 2 | `follow_up` | No estimate booked within 24 h | "Book an estimate" drip starts |
| 3 | `estimate_scheduled` | Estimate visit booked | Confirmation text; 24 h reminder; Google Calendar event; Discord post |
| 4 | `estimate_sent` | Proposal link sent | Proposal follow-up drip starts |
| 5 | `estimate_approved` | Client signs | Drip stops; owner texted; deposit step unlocked |
| 6 | `job_scheduled` | Deposit paid and visit(s) booked | Confirmation text; tech calendar events; Discord post |
| 7 | `job_in_progress` | Tech taps Start | "On my way" text option |
| 8 | `job_completed` | Tech taps Complete on last visit | Final invoice created in QuickBooks |
| 9 | `invoiced` | Invoice sent | Payment link text; reminder at 7 and 14 days |
| 10 | `payment_complete` | Final payment recorded | Receipt text; Discord post |
| 11 | `review_requested` | Next morning after payment | Review link text; maintenance drip enrolled (HVAC) |
| – | `lost` | Owner marks lost, or 60 days idle | Drips stop; reason recorded |

Terms: store the full T&C as a versioned markdown file in the repo (`terms/v1.md`); `Signature.termsVersion` records which one the client accepted.

> **Decision (2026-10-10):** T&C, key terms, company details and logo are edited in Settings instead of repo files. T&C are stored as immutable versions (`TermsVersion`); a sent proposal records the version it was sent with. The price book starts empty and is entered in the app. Sales tax applies to every line at the job address's county rate (Settings → Sales tax rates).

## Proposals: Good / Better / Best

The owner dictates or types the job notes, Claude returns three priced options as JSON, the owner edits and sends, and the client picks one on their phone.

**Generation (owner side, `/leads/[id]/proposal/new`)**

1. Input form: trade, scope notes (free text or pasted Plaud transcript), photos, optional equipment list, target margin.
2. Server action calls the Claude API with a system prompt per trade and `tools` / structured output so the reply is strict JSON matching `ProposalDraft` (3 options × line items, summary, warranty, assumptions, exclusions). No prose, no markdown.
3. Pricing comes from a `PriceBook` table (materials, labor rates, equipment SKUs) the prompt receives as context; Claude assembles, it does not invent prices. Anything not in the price book is flagged `needsPrice: true` for the owner.
4. Owner reviews in an editor (drag line items between tiers, adjust prices, pick which tier is "Recommended"), then **Send** creates the `Proposal` row, token, and expiry (default 30 days) and texts the link via Quo.

**Trade prompt guidance (keep as files in `prompts/`)**

| Trade | Good | Better | Best |
| --- | --- | --- | --- |
| HVAC | Repair or base-efficiency replacement, 1-yr labor | Mid-SEER2 equipment, better filtration, 2-yr labor | High-efficiency / variable-speed, IAQ add-ons, 5-yr labor, maintenance plan |
| Plumbing | Fix the failed part | Replace the fixture or section | Replace plus preventive items (shutoffs, PRV, water heater) |
| Electrical | Minimum code-compliant fix | Panel or circuit upgrade | Whole-home (panel, surge, EV-ready, generator inlet) |

**Client page (`go.cincydegreeofcomfort.com/p/[token]`)**

- Mobile-first, DripJobs-style: company header, client name, one-paragraph summary, three option cards side by side (stacked on phone) with price, 4–6 bullet highlights, and "Recommended" badge; expand for the full line-item list.
- Selecting a card updates `selectedOptionId` and reveals: key terms box (6–8 plain-English lines), checkbox "I've read and agree to the full Terms & Conditions" (link opens `/terms/v1`), then the **Sign** button.
- First open records `viewedAt` and the viewer's IP; the owner sees "Viewed 2× · last Thu 4:12 pm" on the lead.
- Expired or already-signed links show a friendly message with "Request an updated proposal."

**PDF download**

- `GET /p/[token]/pdf` renders the proposal with the **selected option only** (plus a one-line mention that other options were offered), key terms, full T&C appendix, and the signature block.
- Render with Playwright/Chromium from the same React component used on the page (one source of truth); cache to the file bucket and store `pdfUrl`.
- The same PDF is what gets uploaded to Documenso for signing, so the signed file and the downloaded file match. After signing, the download button serves the Documenso-sealed PDF plus the certificate.

## MCP server for workers

The CRM exposes a remote MCP server so each worker can draft proposals and manage their day from their own Claude account, with the same rules as the web app.

- Endpoint `https://app.cincydegreeofcomfort.com/mcp` (Streamable HTTP) built with the official TypeScript MCP SDK inside the Next.js app; it calls the same service layer the UI uses, so there is one set of business rules.
- Auth: OAuth 2.1 with PKCE issued by the CRM (NextAuth acts as the provider). A worker adds the connector once in Claude (org-level on a Team plan) and signs in with their CRM login; every tool call runs as that user with their role.
- Tools (role-scoped): `search_leads`, `get_lead`, `get_price_book`, `create_proposal_draft` (owner + tech), `update_proposal_option`, `send_proposal` (owner only), `list_my_visits`, `update_visit_status`, `log_note`, `create_lead`.
- Resources: `crm://lead/{id}` and `crm://pricebook/{trade}` so Claude can read context without a tool round-trip.
- Shared skill `skills/proposal/SKILL.md` in the repo, uploaded to the Claude org: trade prompts, Good/Better/Best rules, tone, and the step order (pull lead → draft in chat → confirm → `create_proposal_draft`). Techs get `skills/my-day/SKILL.md` for status updates and notes.
- Drafts created over MCP land as `status: draft` on the lead; sending still happens from the app or by the owner's `send_proposal` call, so nothing reaches a client unreviewed.
- Audit: every MCP call is logged in `Activity` with the user and tool name.

## E-signature with Documenso

> **Decision (2026-10-10):** use Documenso's hosted service (app.documenso.com, the existing API key) instead of self-hosting on Railway. Customers sign on Documenso's page and are redirected back (no iframe embed, which needs a paid embedding plan); completion is confirmed both on return and by webhook.

Documenso runs as its own Railway service at `sign.cincydegreeofcomfort.com`; the app talks to it only through its REST API and a webhook.

1. Deploy the official Documenso Railway template. Set `NEXT_PUBLIC_WEBAPP_URL` to the sign subdomain, point SMTP at Resend (or Postmark), keep the auto-generated self-signed certificate, and create one API token for the CRM (`DOCUMENSO_API_KEY`).
2. When the client clicks **Sign**: the app uploads the selected-option PDF, creates a document with one recipient (name + email from the lead), adds a signature field and a date field on the signature page, and sends it.
3. Show the signing in-page via Documenso's embedded signing (iframe) so the client never leaves `go.`; fall back to the emailed link if embedding fails.
4. Webhook `POST /api/webhooks/documenso` on `DOCUMENT_COMPLETED`: verify the secret, download the sealed PDF and the audit certificate, store both in the bucket, write the `Signature` row (IP, user agent, timestamps, terms version), set lead stage to `estimate_approved`, stop any running drip, text the owner.
5. Signed PDFs are immutable: any change after signing creates a new proposal version that goes through the same flow.

Local audit log: even though Documenso keeps its own trail, the app also records view, option selection, terms checkbox, and sign events with IP and timestamp in `Activity`, so the evidence survives even if Documenso is ever replaced.

## Payments with the QuickBooks Payments API

The deposit is charged in-page with the QuickBooks Payments API, and every charge is also recorded in QuickBooks Online so the books stay the ledger of record.

**Setup**

- One Intuit developer app with both scopes: `com.intuit.quickbooks.accounting` and `com.intuit.quickbooks.payment` (US only). OAuth 2 once as the owner; store refresh tokens encrypted; refresh on a schedule in the worker (Intuit refresh tokens rotate).
- Store `QBO_REALM_ID`, client id/secret, and the Payments base URL (`sandbox.api.intuit.com` vs `api.intuit.com`) in Railway variables; build against the sandbox first.

**Flow after signing**

1. `Customer` is created or matched in QuickBooks Online (search by email, then phone) and `quickbooksId` saved.
2. An `Estimate` is created in QBO from the selected option's line items (for the paper trail); the deposit amount is read from the proposal's key terms (default 50% for jobs under $5k, 30% above, configurable).
3. Client page shows the **Pay deposit** step: the card form uses Intuit's hosted tokenization (card data goes browser → Intuit, returns a token), so the app only ever handles a token. This keeps PCI scope at SAQ-A.
4. Server posts a `charge` with the token and amount, idempotency key = `proposalId:deposit`. On success write `Payment`, then create a QBO `Payment` (or `SalesReceipt`) against the customer so it reconciles; link the estimate.
5. Lead stage stays `estimate_approved` with a "Deposit paid" badge; job created, confirmation text sent via Quo, owner notified. The lead moves to `job_scheduled` once a visit is booked.

**Later payments**: progress and final payments reuse the same flow with a stored card (`cards` endpoint, with the client's consent checkbox) or a fresh token; ACH (`echeck`) for commercial customers who prefer bank transfer.

**Financing (Acorn Finance)**

Acorn has no public API, Zapier app, or webhook for individual contractors, so V1 uses the contractor link plus email-based status capture; nothing else in the build depends on Acorn.

- Proposal page shows a **Pay monthly** button under the selected option's total that opens the Acorn contractor link. The CRM logs the click as an `Activity` and texts the owner so they can create the tracked, amount-specific application in the Acorn portal (phone + email) while the customer is warm.
- Open test at build time: append `?amount=`, `loan_amount=`, or `project_amount=` to the contractor link; if any prefills, build the link per proposal with the selected total. Also ask Acorn support whether a prefilled link or a status webhook/API is available to contractor-built software; if yes, replace the email capture below with it.
- Status capture: Acorn's notification email on the account is set to `financing@cincydegreeofcomfort.com`, which forwards to an inbound-email webhook (Resend or Postmark inbound) at `POST /api/webhooks/financing`. The handler asks Claude to extract customer name/email, status (`offers`, `approved`, `funded`) and amount from the body, matches the lead, writes a `Financing` activity with the raw email attached, posts to Discord, and on `funded` prompts the owner to record the deposit as paid by financing.
- Fallback: Zapier Gmail trigger → webhook to the same endpoint, if the mailbox is Gmail.
- Affirm stays an option only if the BNPL toggle appears in the QuickBooks Payments account; it is not assumed.

## Scheduling, dispatch, and Google Calendar

A ticket assigned to a tech becomes an event on that tech's own Google Calendar within a minute, and edits in either place stay in sync.

**Google Calendar (per worker)**

- Google Cloud project with the Calendar API enabled; OAuth consent screen in *internal/testing* mode is fine for 1–3 users. Scope: `calendar.events` only.
- Each tech clicks **Connect Google Calendar** once in their profile; store the refresh token encrypted on `User`. Owner can see who is connected.
- On `Visit` create/update/delete: upsert a Google event on the tech's primary calendar (title `DoC – {trade} – {customer}`, location = property address, description = job summary + link to the job in the CRM, reminders 60 min). Save `googleEventId`.
- Inbound: subscribe to push notifications (watch channel per tech, renewed by the worker every 6 days) so a tech dragging the event in Google updates the `Visit`. Simpler V1 fallback: poll each connected calendar every 5 minutes for changed events with the CRM's tag.
- Conflicts: the CRM is the source of truth for assignment; Google is the source of truth for the tech's other busy time, which the dispatch board shows as grey blocks via `freebusy`.

**Dispatch board (`/dispatch`)**

- Day and week views, one column (or row) per tech, 15-minute grid; unassigned jobs sit in a side list and drag onto a tech and time. Use FullCalendar's resource timeline, or a hand-built grid with `@dnd-kit`.
- Map pane (Google Maps JS or Mapbox) with a pin per scheduled visit for the day, colored by tech; click a pin to open the job. Properties are geocoded once on creation.
- Claude-assisted slot finder: "next 3 openings for a 4-hour HVAC install within 20 min of this address" uses techs' free/busy plus drive-time estimates from the Maps Distance Matrix API.
- Tech mobile view (`/my-day`): today's visits, **On my way** / **Start** / **Complete** buttons; each tap updates the visit and can send the matching Quo text to the customer.

**Statuses**: `Visit.status` = `scheduled` → `en_route` → `in_progress` → `done`, or `rescheduled` / `cancelled`. A reschedule moves the Google event rather than deleting it, so the tech's notification reads as a change.

## SMS follow-ups via Quo

Every text, automated or manual, goes out through the Quo API from the company number and is logged on the lead, so the owner sees one thread per customer.

**Integration**

- `QUO_API_KEY` and the company inbox id in Railway variables. Use Quo's send-message endpoint for outbound; register a Quo webhook for inbound messages and delivery status at `POST /api/webhooks/quo`.
- On inbound: match the phone to a `Customer`, store the `Message`, mark the lead "replied", stop any active drip, and notify the owner (push via the app, or a Discord post).
- Compliance: first automated text includes the business name and "Reply STOP to opt out"; honor STOP by setting `Customer.smsOptOut` and never enrolling again. Send only 9 am–8 pm local, skip Sundays unless urgent.

**Sequences (editable in the CRM, seeded with these)**

| Sequence | Trigger | Steps |
| --- | --- | --- |
| Proposal follow-up | Proposal sent, not signed | Day 1 "Did the link come through?" · Day 3 "Any questions on the options?" · Day 7 "Happy to walk through it by phone" · Day 14 "Pricing holds until {expiry}" · Day 30 "Still here when you're ready" |
| Estimate booked | Estimate scheduled | Confirmation at booking · reminder 24 h before · "on my way" when the tech taps it |
| Job scheduled | Deposit paid | Confirmation with date · reminder 48 h before · completion thank-you with review link next morning |
| Maintenance | Job complete, HVAC | 6-month tune-up reminder, then yearly |

**Mechanics**

- `Enrollment.nextSendAt` is set from the step's `delayHours`; the worker runs each minute, picks due enrollments, renders the template (`{firstName}`, `{proposalLink}`, `{techName}`, `{expiry}`), optionally asks Claude to personalize the wording from the lead notes, sends, logs the `Message`, and advances the step.
- Stop rules: reply, stage change past the trigger stage, manual pause, opt-out, or 3 failed deliveries.
- Owner can also send a one-off text from the lead page, and templates are editable without a deploy.

## Discord notifications

A Discord channel `#degree-service-call` receives a post for every new or changed service call, plus a few other pipeline events, through a plain webhook.

- In Discord: create the channel, then *Edit channel → Integrations → Webhooks → New webhook*, copy the URL into Railway as `DISCORD_SERVICE_WEBHOOK_URL`. No bot or OAuth needed.
- `lib/integrations/discord.ts` posts an embed (title, customer, address, trade, tech, time window, link to the job) from a small queue in the worker so a Discord outage never blocks the app.
- Events in V1: `estimate_scheduled`, `job_scheduled`, visit rescheduled or cancelled, `job_completed`, `payment_complete`, inbound "urgent" keyword in SMS, financing status changes from Acorn. Each event type can be toggled in Settings.
- One more channel later if useful: `#degree-leads` for new leads and signed proposals, kept separate so the service channel stays a clean dispatch feed.

## Security and privacy for client pages

Client pages are private by link, invisible to search engines, and expire; staff pages require login.

- `go.` responses send `X-Robots-Tag: noindex, nofollow, noarchive`; `go.cincydegreeofcomfort.com/robots.txt` is `Disallow: /`.
- Tokens: 24+ characters from `crypto.randomBytes`, never sequential ids, never the client's name in the URL or `<title>`. OG tags say only "Your proposal from Degree of Comfort".
- Light gate before showing the proposal: the client enters the last 4 digits of their phone (or email) once; store a signed cookie for 30 days. Wrong answer 5× → lock the link and alert the owner.
- Links expire at `expiresAt` (30 days) or when signed; expired pages offer "Request a fresh link", which texts the owner.
- Rate-limit `/p/*`, `/api/webhooks/*`, and the card tokenization route; verify every webhook signature (Documenso, Quo, Intuit).
- Secrets in Railway variables only; refresh tokens encrypted at rest with a `DATA_ENCRYPTION_KEY`; no card numbers ever reach the server.
- Staff auth via NextAuth + Google, restricted to allowed emails; techs see only their own visits and assigned jobs.

## Domains and staff login setup

Three subdomains point at Railway, and staff sign in with Google; nothing else needs a password.

**Subdomains (one-time, ~15 minutes)**

1. In Railway, open the `web` service → Settings → Networking → Custom Domain, add `app.cincydegreeofcomfort.com`; Railway shows a CNAME target. Repeat on the same service for `go.cincydegreeofcomfort.com`, and on the `documenso` service for `sign.cincydegreeofcomfort.com`.
2. At the registrar or DNS host for cincydegreeofcomfort.com, add three CNAME records (`app`, `go`, `sign`) pointing at the targets Railway showed. TTL 300. If the DNS host proxies traffic (Cloudflare), set these records to DNS-only.
3. Wait for Railway to show the certificate as issued (usually under 10 minutes). The main website stays where it is.
4. In the app, `middleware.ts` routes by host: `app.` → CRM routes, `go.` → `/p/*` and `/terms/*` only, anything else → 404.

**Staff login**

- NextAuth with the Google provider only; `ALLOWED_EMAILS` (comma-separated) in Railway variables decides who can sign in. Add a tech by adding their Gmail/Workspace address and a `User` row with role `tech`.
- Google Cloud: one OAuth client (Web), authorized redirect `https://app.cincydegreeofcomfort.com/api/auth/callback/google`; the same client is reused for the tech **Connect Google Calendar** button with the extra `calendar.events` scope.
- No client logins: proposal pages use the token link plus the phone-last-4 gate.
- Owner account is seeded from `OWNER_EMAIL`; the first sign-in with that address gets role `owner`.

## Build phases

Build in six phases, each shippable on its own; stop and test with one real customer after phase 3.

1. **Foundation**: repo, Next.js + Prisma + Postgres on Railway, NextAuth with Google, `User`/`Customer`/`Property`/`Lead` models, pipeline board with the 11 stages, lead page with activity timeline, Discord webhook on stage changes, MCP server with the first tools (`get_lead`, `create_lead`, `log_note`). Custom domains wired.
2. **Proposals**: price book, Claude generation to strict JSON, owner editor, MCP `create_proposal_draft` + the shared proposal skill, client page at `go.` with three option cards, select, key terms + checkbox, PDF render of the selected option, view tracking.
3. **Sign + pay**: Documenso service on Railway and its webhook; QuickBooks OAuth, customer/estimate creation, tokenized deposit charge, QBO payment record, `Job` created on success.
4. **Scheduling**: `Visit` model, per-tech Google Calendar connect and two-way sync, simple calendar view, tech `/my-day` with status buttons.
5. **Dispatch board + map**: multi-tech drag-and-drop timeline, map pane, geocoding, slot finder.
6. **SMS automation**: Quo send + inbound webhook, message log on the lead, sequence editor, the four seeded sequences, worker scheduler, STOP handling.

Each phase ends with: Playwright e2e test of the happy path, seed data refreshed, a short `CHANGELOG.md` entry, and a Railway deploy to production.

## Manual setup checklist

- [ ] Railway: new project, Postgres, `web` and `worker` services from the repo, bucket for files, Documenso template as a separate service.
- [ ] DNS: CNAME `app`, `go`, `sign` → Railway domains.
- [ ] Anthropic API key for proposal generation.
- [ ] Intuit developer app with Accounting + Payments scopes; sandbox company; later production keys.
- [ ] Google Cloud project: Calendar API, Maps JavaScript + Geocoding + Distance Matrix, OAuth client for NextAuth and for tech calendar connect.
- [ ] Quo API key, inbox id, webhook URL.
- [ ] Resend (or Postmark) account for Documenso and app email.
- [ ] Terms & Conditions reviewed by a lawyer and saved as `terms/v1.md`.
- [ ] Acorn Finance contractor account; copy the contractor link into Settings; set its notification email to `financing@cincydegreeofcomfort.com`.
- [ ] Inbound email route for `financing@` (Resend/Postmark inbound, or Zapier Gmail trigger) → `/api/webhooks/financing`.
- [ ] Discord: create `#degree-service-call`, add a webhook, copy its URL into Railway.
