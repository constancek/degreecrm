# Changelog

## Phase 2: Proposals (2026-10-10)

- Price book (`/pricebook`): equipment, materials, labor and fees per trade (or shared), with cost for margins.
- Claude drafts Good/Better/Best proposals as strict JSON (Claude Opus 5 with server-side fallback) from notes or a
  Plaud transcript, photos (resized in the browser, stored in private Blob), equipment and a target margin. Prices come
  only from the price book; anything else is flagged "needs price". Trade prompts live in `prompts/`.
- Proposal editor: edit text and lines, drag lines between options, set the recommended option and deposit, live
  totals, tax and margin, add custom priced lines to the price book. Sent proposals are frozen; "Create revision"
  makes the next version, and sending it supersedes the old link.
- Send: private 32-character link valid 30 days, lead → Estimate sent, optional text via Quo (with STOP wording).
- Client page on `go.`: last-4-of-phone (or email) gate with a 30-day signed cookie, lock + Discord alert after 5
  misses; three option cards, Recommended badge, line-item details, key terms with the deposit, T&C checkbox;
  expired/replaced links offer "Request an updated proposal". Views, selections and the checkbox are logged.
- PDF of the selected option (key terms, full T&C, signature block) rendered by headless Chromium from the same
  components, cached in Blob. Owner can download any option.
- Settings: company details, logo upload, deposit rule (50% under $5k / 30% otherwise), versioned Terms &
  Conditions with key terms, and sales tax by county (Cincinnati-area defaults seeded by migration).
- Sales tax on every line, by the job address's county (Google Geocoding / Places), snapshotted on the proposal.
- MCP: `get_price_book`, `create_proposal_draft`, `update_proposal_option`, `send_proposal` (owner only), resources
  `crm://lead/{id}` and `crm://pricebook/{trade}`; Claude skills in `skills/proposal` and `skills/my-day`.
- Seed: sample price book, T&C v1 and one full sent proposal. Tests: proposal services, gate, tax; Playwright happy
  path from drafting to the customer's PDF, plus a tech drafting over MCP.

## Phase 1 follow-ups (2026-10-09)

- Deployed to Vercel (`degreecrm`) with Neon Postgres (iad1), a private Vercel Blob store, and app./go. domains.
- New-lead form: Google Places (New) address suggestions fill street/unit/city/state/ZIP and coordinates;
  properties without coordinates are geocoded once on the server (`GOOGLE_MAPS_API_KEY`).
- Settings: the owner chooses which stages post to Discord (`Setting` model).
- `DATA_ENCRYPTION_KEY` accepts hex or base64; database URLs use `sslmode=verify-full`.

## Phase 1: Foundation (2026-10-09)

- Next.js 16 + Prisma 7 + Postgres app, set up for Vercel (Vercel Cron every minute) with a portable `npm run worker`.
- Staff sign-in with Google (Auth.js v5). Access: `OWNER_EMAIL`, `ALLOWED_EMAILS`, or an active User row; the owner
  email always gets the `owner` role.
- Models: User, Customer, Property, Lead, Activity, OutboxEvent, OAuthClient/Code/Token.
- Pipeline board with the 11 stages (+ Lost), drag-and-drop between columns; techs see only their assigned leads.
- New-lead form (matches existing customers by phone, then email), lead page with details, stage, assignment,
  notes and the activity timeline.
- Discord posts for New, Estimate scheduled, Job scheduled, Job completed and Paid, sent through a retrying outbox.
- Automation: `new` → `follow_up` after 24 h; pre-sale leads idle for 60 days → `lost`.
- Remote MCP server at `/mcp` with `search_leads`, `get_lead`, `create_lead`, `log_note`, secured by an OAuth 2.1
  server (dynamic client registration, PKCE, rotating refresh tokens) where staff sign in with Google. Every call is
  audited in Activity; Settings lists and disconnects Claude connections.
- Website lead intake: `/api/intake/web` (embed snippet in `docs/website-form.html`) and a Jotform webhook.
- Host routing: `go.` serves only client paths; `noindex` headers everywhere; `robots.txt` disallows all on `go.`.
- Tests: Vitest unit + service tests, Playwright e2e for the Phase 1 happy paths.
