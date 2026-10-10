@AGENTS.md

# Degree of Comfort CRM

CRM for Degree of Comfort (Cincinnati HVAC / plumbing / electrical). **SPEC.md is the source of truth** for
scope, data model, integrations and build order. Build one phase at a time; don't start the next phase until
the user says so. Before each phase: post a short plan (files, models, routes, env vars) and ask design questions.

## Status

- All six phases are built (see CHANGELOG.md). Now in "test with real accounts and fix" mode.
- Open items to raise with the owner when everything else is done:
  - **Review requests**: the owner hasn't decided how reviews should work yet (today: next-morning text with the
    Google review link from Settings, then stage review_requested). Remind them to revisit this at the end.

## Stack

- Next.js 16 (App Router, Turbopack, `proxy.ts` instead of middleware), React 19, TypeScript, Tailwind v4.
  Cache Components is **off**: every CRM page is per-user and request-time.
- Prisma 7 with `prisma-client` generator → `generated/prisma` (gitignored; `postinstall` regenerates) and the
  `@prisma/adapter-pg` driver adapter. Config in `prisma.config.ts`.
- Auth.js v5 (`next-auth@beta`), Google provider, JWT sessions. `lib/session.ts` re-reads the User row on every request.
- MCP: `@modelcontextprotocol/sdk`, stateless Streamable HTTP at `/mcp`, OAuth 2.1 server in `lib/oauth/server.ts`.
- Hosting: **Vercel** (web + Vercel Cron) with Postgres from Neon via the Vercel Marketplace. Documenso (Phase 3)
  will still need its own host (Railway template).

## Layout

```
proxy.ts                  host routing: APP_HOST → CRM, CLIENT_HOST (go.) → /p/*, /terms/* only, else 404; noindex everywhere
app/(crm)/                signed-in staff pages (pipeline, leads, settings) + actions.ts (server actions)
app/login                 Google sign-in (+ test login when E2E_AUTH=1)
app/oauth/*, app/.well-known/*   OAuth 2.1 for the Claude connector (DCR, PKCE S256, rotating refresh tokens)
app/mcp/route.ts          MCP endpoint; tools in lib/mcp/server.ts
app/api/intake/web        public website lead form (JSON or HTML form post; CORS allow-list; honeypot; optional Turnstile)
app/api/intake/jotform    Jotform webhook (?secret=INTAKE_WEBHOOK_SECRET)
app/api/cron/tick         Vercel Cron, every minute (Bearer CRON_SECRET) → lib/jobs/tick.ts
app/p/[token]             client proposal page: gate, options, key terms, PDF (pdf/route.ts); actions.ts
app/terms/[version]       public T&C version (markdown from the DB)
app/print/proposal/[id]   print-only page the PDF renderer opens via a short-lived HMAC link (lib/pdf.ts)
app/brand/logo            company logo from private Blob, served on both hosts
app/(crm)/proposals/[id]  editor, send panel, preview, staff PDF
app/(crm)/pricebook       price book
components/proposal       presentational parts shared by client page, preview and PDF (lib/proposal-view.ts builds the data)
prompts/                  Claude system prompt + one file per trade (read at runtime; traced into the Vercel bundle)
skills/                   Claude skills to upload to the org (proposal, my-day)
worker/index.ts           `npm run worker`: same tick on a 60 s loop (local / non-Vercel hosts)
lib/services/*            business rules. UI, MCP and intake all call these; never put rules in routes/components
lib/integrations/<svc>.ts typed client + mock per external service: discord, google-maps (geocode, routes), claude,
                          claude-text, quo, blob, email (Resend), quickbooks, google-calendar
lib/services/signing.ts   built-in e-signature + signed copy; booking.ts requests/confirm; stage-moves.ts pipeline
                          drag actions; payments.ts deposits + QBO; jobs.ts completion/invoice/review;
                          visits.ts scheduling + calendar sync; dispatch.ts board + slot finder; messages.ts +
                          sequences.ts texting; financing.ts Acorn emails; quickbooks-auth.ts OAuth tokens
lib/jobs/tick.ts          every-minute scheduler (Vercel Cron / npm run worker); each step fails independently
app/(crm)/ops-actions.ts  server actions for visits, payments, invoices, texts, sequences, slot finder
app/api/webhooks/*        quo (openphone-signature HMAC), financing (?secret=)
app/book                  public booking request form (go. host, embeddable: only /book may be framed)
lib/notifications/*       message builders (Discord embeds)
prisma/schema.prisma      models; prisma/seed.ts demo data
tests/                    Vitest (unit + service tests against degreecrm_test)
e2e/                      Playwright happy paths (production build on :3100 against degreecrm_test)
```

## Conventions

- Money is integer cents. Timestamps are UTC (Prisma `timestamp(3)` without zone; in raw SQL compare with
  `now() AT TIME ZONE 'UTC'`, not `now()`).
- Every external call lives in `lib/integrations/<service>.ts` with a typed client and a mock; tests swap via a setter.
- Services take an `Actor` (`lib/services/actor.ts`): staff user (role owner/tech, via web or mcp) or system.
  Techs only see leads assigned to them (`scope()` in leads.ts). Throw `NotFoundError` / `ForbiddenError` / `ValidationError`.
- Every lead mutation writes an `Activity` row (`recordActivity`), which also bumps `Lead.lastActivityAt`.
- Notifications go through `OutboxEvent` (`enqueueDiscord` inside the transaction, `flushOutboxSoon()` after);
  the tick retries with backoff. Never call Discord inline.
- Stage → Discord posts are configured in `lib/stages.ts` (`discord: true`).
- Agreed stage mapping for later phases: Documenso signing → `estimate_approved`; deposit paid does **not** change the
  stage (show a "Deposit paid" badge, create the Job); `job_scheduled` once a visit is booked.
- Next 16 specifics: `params`/`searchParams` are Promises; use `PageProps<"/route">` / `LayoutProps`; run
  `npx next typegen` if route types are stale. Read `node_modules/next/dist/docs/` before using unfamiliar APIs.
- Client components must not import modules that (transitively) import `@/lib/db`: Turbopack dev then silently
  fails to build the page (500 with a missing build-manifest). Keep client-safe helpers in pure modules
  (`lib/money.ts`, `lib/tiers.ts`, `lib/stages.ts`, `lib/format.ts`) and use `import type` for server types.
- Proposals: prices come only from the price book when drafting (`resolveLines(…, false)`); owner edits may set any
  price (`trustPrices`). Totals are recomputed on every write and stored on `ProposalOption`. Only drafts change; a
  sent proposal gets a revision. T&C are versioned rows (`TermsVersion`), never edited in place.
- Sales tax: `taxForProperty` = county row, else statewide row; geocodes the property if the county is unknown.
- Files go through `getBlobStore()` (private Vercel Blob, or `.blobdata/` locally). Never public URLs.
- `MOCK_INTEGRATIONS=1` swaps QuickBooks, Google Calendar and email for in-process mocks (e2e uses it; the Intuit
  tokenizer stand-in at /api/dev/qbo-token 404s otherwise). Never set it in production. `setPdfRenderer` stubs Chromium in tests.
- Signing is built in (no third party): consent + T&C + phone gate + drawn/typed signature → `Signature` row with
  `contentHash`; the signed PDF (print page + certificate page) is rendered after the response, hashed, emailed and texted.
- Pipeline drags call `planStageMove` (what the stage needs) then `performStageMove` (does it). Backward moves are plain.
- Booking requests: customer picks a day + 3-hour window (lib/booking.ts); any estimate `scheduleVisit` confirms the
  pending request. Texts from numbers not in the CRM are ignored. Deleting an event in Google cancels the visit + texts.
- Stage moves after signing: signed → estimate_approved; deposit doesn't move the stage (creates the Job); a job visit
  → job_scheduled; Start → job_in_progress; last visit done → job_completed → invoiced → payment_complete →
  review_requested. Drips start/stop in `onLeadStageChanged` (sequences.ts), called from `changeStage`.
- Times: store UTC, show/compute in America/New_York (`easternMidnight`, `easternYmd` in dispatch.ts).
- Tailwind v4: borders default to gray-200 via a base rule in globals.css (v4's default is currentColor). Shared classes are `@utility` blocks in `app/globals.css` (`input`, `label`, `btn-primary`, `btn-secondary`, `card`).

## Commands

```bash
npm run db:local      # local Postgres on :54329 (embedded-postgres, data in .pgdata/). Keep it running.
npm run db:migrate    # prisma migrate dev (create + apply a migration)
npm run seed          # reset + demo data (owner = OWNER_EMAIL, techs tech1@/tech2@example.com)
npm run dev           # http://localhost:3000 (client host: http://go.localhost:3000)
npm run worker        # scheduler loop (follow-up after 24 h, lost after 60 d idle, outbox)
npm run lint && npm run typecheck && npm test && npm run test:e2e
```

`.env.local` (from `vercel link` / `vercel env pull`) overrides `.env` in Next.js. Never keep Neon `DATABASE_URL`/`PG*`/`POSTGRES_*` in it: the Vercel development env points at the production database.

Local sign-in without Google: set `E2E_AUTH=1` in `.env`, then use the test login on /login with an allowed email.
`npm test` and `npm run test:e2e` use the `degreecrm_test` database and wipe it.

## Environment variables

See `.env.example` for all of them with comments. Required in production: `DATABASE_URL`, `DATABASE_URL_UNPOOLED`,
`APP_HOST`, `CLIENT_HOST`, `APP_URL`, `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `OWNER_EMAIL`,
`ALLOWED_EMAILS`, `DATA_ENCRYPTION_KEY`, `CRON_SECRET`, `DISCORD_SERVICE_WEBHOOK_URL`, `INTAKE_ALLOWED_ORIGINS`.
Phase 2: `ANTHROPIC_API_KEY` (+ optional `ANTHROPIC_MODEL`), `BLOB_READ_WRITE_TOKEN`, `QUO_API_KEY`, `QUO_INBOX_ID`,
`GOOGLE_MAPS_API_KEY` (server, Geocoding) and `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` (browser, Places).
Optional: `TURNSTILE_SECRET_KEY`, `INTAKE_WEBHOOK_SECRET`. Never set `E2E_AUTH` or `AI_MOCK` in production.
