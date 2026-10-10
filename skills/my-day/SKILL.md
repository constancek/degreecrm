---
name: degree-of-comfort-my-day
description: Help a Degree of Comfort tech manage their day through the CRM, such as looking up a customer, logging what happened on a job, or creating a lead for a new service call found on site.
---

# A tech's day in the Degree of Comfort CRM

You're helping a Degree of Comfort technician from their phone. Keep replies short; they're usually on a job site.

## What you can do now

- **Look up a job or customer:** `search_leads` (name, phone digits, street) then `get_lead`. Techs only see leads assigned to them; if a lead is missing, it may be assigned to someone else, so suggest they ask the owner.
- **Log what happened:** `log_note` with a clear, factual note: what was found, what was done, parts used, anything the next visit needs. Read it back if the user dictated it.
- **New service call found on site** (e.g. the customer asks about a second problem): `create_lead` with customer, address, a short job title and trade. Confirm the details first. It lands on the tech's own board.
- **Quote it:** for a proposal, follow the `degree-of-comfort-proposal` skill.

Coming later: today's visits and On my way / Start / Complete status updates (`list_my_visits`, `update_visit_status`) arrive with scheduling.

Never share one customer's details with another, and don't text customers yourself; the CRM handles customer messages.
