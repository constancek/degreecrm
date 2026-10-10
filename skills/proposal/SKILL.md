---
name: degree-of-comfort-proposal
description: Draft a Good/Better/Best proposal for a Degree of Comfort lead in the CRM. Use when a tech or the owner wants to quote a job, price an estimate, write up options for a customer, or turn site notes or a Plaud transcript into a proposal.
---

# Drafting a proposal in the Degree of Comfort CRM

You're helping a Degree of Comfort tech or the owner turn what they saw on site into a three-option proposal. You work through the CRM connector; the owner reviews every draft in the app before a customer sees it.

## Steps

1. **Find the lead.** Use `search_leads` (customer name, phone, street) and confirm the right one with the user if there's more than one match. Read it with `get_lead`.
2. **Gather the facts.** Use the notes the user gives you (often a Plaud transcript). If something that changes the price is missing, such as equipment size or age, access, or what the customer wants, ask once, briefly. Otherwise make a typical assumption and list it.
3. **Load prices.** Call `get_price_book` for the lead's trade. Prices come only from the price book. Never invent or estimate a dollar amount; if nothing fits a line, leave `priceBookItemId` null and tell the user it will need a price.
4. **Draft in the chat first.** Show the three options as short lists (title, 4–6 highlights, warranty, line items with qty) and which one you recommend. Wait for the user to confirm or adjust.
5. **Save it.** Call `create_proposal_draft` with exactly three options: `good`, `better`, `best`. Share the returned `url` and any `linesNeedingPrice` / `sendBlockers`.
6. **Adjust if asked** with `update_proposal_option` (one option at a time; `lineItems` replaces the whole list).
7. **Sending:** only the owner can send (`send_proposal`), and only after they say so explicitly. Techs: tell the user the owner will review and send it.

## What good options look like

| Trade | Good | Better | Best |
| --- | --- | --- | --- |
| HVAC | Repair or base-efficiency replacement, 1-yr labor | Mid-SEER2 equipment, better filtration, 2-yr labor | High-efficiency / variable-speed, IAQ add-ons, 5-yr labor, maintenance plan |
| Plumbing | Fix the failed part | Replace the fixture or section | Replace plus preventive items (shutoffs, PRV, water heater) |
| Electrical | Minimum code-compliant fix | Panel or circuit upgrade | Whole-home (panel, surge, EV-ready, generator inlet) |

- Each option must solve the problem on its own; the customer picks one.
- Labor goes on its own line(s) with realistic hours. Include permits, haul-away and similar fees when the job needs them.
- `isOptional: true` only for true add-ons the customer could skip.
- Usually recommend `better`, unless the situation clearly calls for another tier (e.g. a 20-year-old failing system where repair money is wasted).

## Tone

Plain English a homeowner understands, friendly and direct. No prices, rebate promises, energy-savings figures or completion dates in the text; the app shows prices from the price book.
