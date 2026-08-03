# Voice agents

`assistant-home-services.json` is the assistant the T2 workflow expects. It is
kept here rather than only in the VAPI dashboard because the prompt *is* the
product — the difference between a $350/mo agent and a bad one is entirely in
these few hundred words, and a prompt that only exists in a web form cannot be
diffed, reviewed, or rolled back after a bad edit.

## Setting one up

1. **Number.** Import the client's tracked number into VAPI (Phone Numbers →
   Import from Twilio), or buy one there. The number the assistant answers on
   must equal `inbound_number` on the client's row in `sanaku_clients` — that
   is the only way `T2 Voice Agent` knows whose call it was.
2. **Assistant.** Create it from this JSON (VAPI's API takes it as the request
   body for `POST /assistant`, or paste the fields in by hand).
3. **Server URL.** Replace `REPLACE_WITH_YOUR_N8N_WEBHOOK` with the webhook
   `sh ~/sanaku.sh voice` prints. Leave `serverMessages` at
   `["end-of-call-report"]` — the other message types fire constantly and the
   workflow drops them anyway.
4. **Assign** the number to the assistant.

`{{brand}}`, `{{city}}` and `{{callback_promise}}` are VAPI template variables.
Set them per client under the assistant's variable values, or pass them in
`assistantOverrides` if you ever run several clients through one assistant.
`callback_promise` is the tail of a sentence — something like
" first thing in the morning" or " within the hour" — so leave it empty rather
than putting a full sentence in it.

## What is deliberately in the prompt

- **It admits what it is.** The first message says "automated assistant" and
  "this call is recorded" before anything is asked, and the prompt forbids
  dodging the question if a caller asks again. The catalog promises this
  (`compliance_note` on `voice_reception_home`), California is a two-party
  consent state, and a recorded call where the caller was never told is a
  problem for the client, not for the vendor.
- **It never quotes a price.** A voice agent that guesses at a callout fee
  creates a number the client then has to honour or argue about.
- **Gas and injury stop the intake.** The agent tells them to leave and call
  911 rather than carrying on collecting an address.
- **`appointment_booked` is separate from `is_qualified`.** The workflow only
  writes `outcome = 'booked'` when a real time was agreed. A dashboard that
  says "booked" about a call that ended in "someone will ring you back" is the
  fastest way to lose a client's trust in every other number on the page.

## The other verticals

Law and medical are the same file with a different system prompt and the
catalog's own guardrails: an intake agent states it is not a lawyer and gives
no legal advice; a medical front desk routes anything clinical to staff,
directs emergencies to 911, and cannot go live until a BAA is signed with every
vendor in the call path (`requires_baa` is already true on that catalog row).
Neither is written yet — home services is the one the demo films.
