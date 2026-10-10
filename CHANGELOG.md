# Changelog

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
