---
name: degree-of-comfort-booking
description: Book a Degree of Comfort estimate appointment from a phone call or message. Use when someone wants to schedule, book, set up a visit, find an appointment time, or when the owner wants to confirm pending appointment requests.
---

# Booking an estimate in the Degree of Comfort CRM

Customers get a day and an **arrival window**: 9 am–12 pm, 12–3 pm, 3–6 pm, or all day (9 am–6 pm), Monday to Saturday, up to three weeks out. Always collect **at least two choices** (a third is welcome). A request isn't a confirmed appointment until the owner confirms it; only then does the customer get the confirmation text and the visit land on a tech's calendar.

## Taking a request (anyone on the team)

1. **Find or create the customer.** Use `search_leads` (name, phone digits, street). If they're already a lead, use that `leadId`. Otherwise collect: name, mobile phone, service address with ZIP, trade (HVAC, plumbing or electrical) and a sentence about the problem.
2. **Offer windows.** Call `booking_windows` and suggest two or three options, favoring windows with fewer `alreadyBooked`. Read them as "Tuesday the 14th, between 9 and noon".
3. **Record it.** Call `request_booking` with the first choice (`date`, `window`), the second (`altDate`, `altWindow`) and any third (`alt2Date`, `alt2Window`). Tell the user the request is in and the owner will confirm by text. Don't tell the customer it's confirmed.

## Confirming (owner)

1. `list_booking_requests` shows pending requests and the team with tech ids.
2. Suggest a tech: the lead's assigned tech if there is one, otherwise whoever has the lighter day for that window.
3. After the owner agrees, call `confirm_booking` (a different `date`/`window` is fine if the requested one doesn't work). The customer is texted the confirmed window automatically.

Keep replies short and confirm names, phone numbers and addresses back before saving them.
