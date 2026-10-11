# Changelog

## Estimates: packages, lump sums, decline, payment choices (2026-10-11)

- Packages renamed Essential / Premium / Supreme. Each has one typed package price; what's included is a scope list
  without prices; optional add-ons keep their own price. Claude drafts the scope, never the price.
- Customer view: estimate number (#1001…, kept across revisions), date, valid-until (30 days), Choose this package →
  Approve & sign, Request changes, Decline (reason). Staff see responses on the estimate page.
- After signing the customer picks card, bank transfer (QuickBooks invoice, recorded when it clears), check / in
  person (office alerted), or Acorn financing.
- Payment schedule: deposit + milestones (must total 100%) shown on the estimate and PDF; the owner invoices each
  milestone from the job page and the final invoice bills only what's left.

## Tech dashboard, audit fixes (2026-10-10)

- Techs land on **Today** (/my-day) and see only Today + Calendar (+ Account for Google Calendar). Pipeline, jobs,
  price book and dispatch send them back to Today.
- Today: the next stop is open with Directions / Call / Text, a step strip and only the current step's button;
  later and finished stops are rows that open the appointment page (/my-day/[id]).
- Steps (lib/visit-steps.ts): On my way → Arrived → Build estimate → Present to customer → signed: Start work now /
  Schedule return visit. Exits only where they fit: Running late / Can't make it before arriving, Customer not home
  once on the way, Trip fee only before an estimate exists, Declined once there is one.
- Customer not home (`customerNotHome` in visits.ts): visit done as no_show, tech picks the trip fee (none / collected
  / invoiced), customer texted, owner alerted, lead → Needs reschedule.
- Before you knock: talking points + public records from RentCast (year built, size, heating/cooling, last sale,
  value estimate, owner) cached on `Property.intel` for 180 days, plus our own history with the customer.
- Audit fixes: form errors announced to screen readers, shared dialog focus/Escape (`useDialog`), readable tech
  colors and small text, signature pad survives interrupted strokes, 44px icon buttons on touch screens.

## Dispatch-oriented pipeline (2026-10-10)

- New board: New request → Needs scheduling → Needs tech → Scheduled → Needs reschedule → On the way → On site →
  Estimate sent → Approved / Declined → Job scheduled → In progress → Completed → Invoiced → Paid → Review requested.
  Columns can be collapsed (remembered per device); cards show the booked time, "No tech", "Late" and fee badges.
- Booking: pick an arrival window (or exact time) plus time on site, with or without a tech. Without a tech the lead
  waits in Needs tech (Dispatch shows it to drag onto a tech); assigning sends the confirmation.
- Texts: confirmation names the address, day, arrival window ("sometime between 9 am and 6 pm" for all day) and the
  technician; "has been moved to…" on reschedule; "Change of technician" when only the tech changes; "running behind,
  new arrival about …" from the tech's Running late button; "we need to reschedule" when the tech can't make it.
- My day (tech): On my way, Running late (30 min / 1 h / 2 h), Can't make it, Arrived; on site: present the estimate,
  then Start work now (signed, no deposit, pay at the end), Schedule return visit, Declined – done (reason + service
  call fee: no charge / collected / invoice), or Done – estimate later.
- Declined estimates get a gentle follow-up drip (3, 14, 30 days). Service call fee default in Settings ($89).
- Techs can send and present estimates for their own leads (texting the link stays owner-only).
- New requests move to Needs scheduling after 4 hours (was 24), except ones where the customer already picked windows.

## Calendar, policy pages (2026-10-10)

- **Calendar** (nav → Calendar, everyone): Month / Week / 3 Days / Day views of CRM visits plus your Google Calendar
  events; filter by event type and person; US holidays toggle. Your own Google events show their titles and open in
  Google; other people's show as "Busy". Visits open the lead.
- **New appointment** (owner): book an estimate for an existing lead or a brand-new customer (creates the lead), or a
  job visit; or click an empty time in Week / 3 Days / Day view. Adds it to the tech's Google Calendar and sends the
  usual confirmation / reminder texts.
- Public **Privacy Policy** (/privacy) and **Terms of Service** (/terms-of-service) on both hosts, for Google OAuth
  verification; common misspellings redirect.

## iPad, two-choice booking, presenting in person (2026-10-10)

- Booking form always asks for two choices (different from each other), with an optional third; "All day
  (9 am – 6 pm)" added as an arrival window. Owner confirm panel picks between the choices.
- **Present to customer**: staff open a proposal on their own device without the phone check (from the proposal page
  or My day). Not counted as a customer view; the signature certificate records who presented it. Signer email is
  optional when the customer has a phone (the signed copy is texted).
- iPad: touch drag on all boards (press and hold to pick up, swipe still scrolls), 44pt touch targets and 16px inputs
  on touch screens, nav fits portrait, two-column lead/job/proposal pages from iPad portrait, dispatch side panel
  beside the board in landscape, larger signature pad (re-sizes on rotation), two-column My day in landscape.
- Fix: client-page redirects used the internal host (now always the client URL).

## Signing, booking and drag actions (2026-10-10)

- **Built-in e-signature** replaces Documenso: signature pad (draw or type) on the proposal page, separate consent to
  sign electronically, T&C acceptance and phone check recorded; signed PDF with the signature, an audit certificate
  page and agreement fingerprint (SHA-256), stored with its own hash, emailed (Resend) and texted to the customer.
  Owner can record a paper signature. Documenso code, webhook and columns removed.
- **Booking requests:** embeddable form at go.…/book (docs/website-booking.html): preferred day + 3-hour arrival
  window (9–12, 12–3, 3–6, Mon–Sat, up to 3 weeks) and an optional second choice. Owner confirms on the lead page,
  dispatch board or pipeline drag; confirmation books the window and texts the customer. Claude tools
  `booking_windows`, `request_booking`, `list_booking_requests`, `confirm_booking` + skills/booking.
- **Pipeline drags do the stage's work** (book estimate, send proposal, record approval/deposit, schedule job, start,
  complete + invoice, invoice, record payment, review request) via a dialog; backward moves are plain.
- Deleting a visit's event in Google Calendar cancels the visit and texts the customer.
- Texts from numbers not in the CRM are ignored (no lead, no Discord post).
- QuickBooks: choose the income account CRM sales post to. Dispatch drag fixes (drop at the pointer, links no longer
  hijack drags or open after a drop).

## Phases 3–6: Sign + pay, scheduling, dispatch, texting (2026-10-10)

- **Sign:** "Approve & sign" on the client page creates a Documenso document from the selected-option PDF (fixed
  Acceptance page with signature/date/name fields), sends the customer to sign and back. Completion (webhook or
  return) stores the sealed PDF, a local `Signature` audit row, moves the lead to Estimate approved, stops drips,
  supersedes other versions, texts the owner and creates the QuickBooks customer + estimate.
- **Pay:** deposit by card with Intuit browser tokenization (card data never reaches our server), idempotent charge,
  booked in QuickBooks Online as an invoice + payment linked to the estimate. Owner can record check/cash/financing
  deposits. Deposit creates the `Job`; customer gets a confirmation text. "Pay monthly" opens the Acorn link and
  alerts the owner; Acorn status emails are read by Claude at `/api/webhooks/financing`.
- **QuickBooks:** owner connects in Settings (OAuth, encrypted rotating tokens refreshed daily).
- **Scheduling:** `Visit` (estimate / job) with per-tech Google Calendar sync both ways (push on change, poll every
  5 min for moves made in Google; deletions flagged). Visits book the lead into Estimate scheduled / Job scheduled.
  `/my-day` for techs with On my way (texts the customer) / Start / Complete. Last visit done → job completed →
  final QuickBooks invoice for the balance, emailed and texted → paid when the balance hits zero (polled) →
  receipt text → next morning review request + HVAC maintenance drip.
- **Dispatch** (`/dispatch`): day grid by tech (15-min drag & drop, Google busy time in grey) and week view, list of
  jobs/estimates to schedule, map of the day's visits, and a slot finder (free time + drive time via Routes API,
  with a "just ask" box parsed by Claude).
- **Texting:** every text logged as a `Message` thread on the lead; one-off texts; Quo inbound webhook (signature
  verified) stops drips on reply, honors STOP/START, alerts Discord (urgent keywords also text the owner).
  Editable sequences (`/settings/texts`): book an estimate, proposal follow-up (day 1/3/7/14/30), estimate and job
  reminders, maintenance. Sent 9 am–8 pm ET Mon–Sat, STOP wording on the first automatic text, optional Claude
  personalization, stop after 3 failed deliveries.
- MCP: `list_my_visits`, `update_visit_status`.
- Tests: services for signing, deposit, scheduling → review, calendar sync, drips, STOP, webhooks, slot finder,
  financing; Playwright end-to-end for sign → pay → schedule → complete → invoice, dispatch slot booking and texting.

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
