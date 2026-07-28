# Compliance Notes — GDPR / CCPA / TCPA

This pipeline stores business contact data and places AI voice calls. This
document describes the guardrails built into the workflows and the manual
procedures you must follow. **It is not legal advice** — confirm your
obligations with counsel, especially before scaling outreach volume.

## What data is processed

- Business (B2B) contact data only: company name, business domain, role-based
  contact name/title, business email, business phone, employee count, and
  publicly observable website technology signals.
- Apollo email reveals are made with `reveal_personal_emails: false` —
  personal emails are never requested (data minimization).
- Call recordings/transcripts from Vapi are stored in `outreach_log`.

## GDPR (if any data subjects are in the EU)

- **Lawful basis**: legitimate interest (Art. 6(1)(f)) for B2B prospecting.
  Every `prospects` row carries `lawful_basis = 'legitimate_interest'`.
  Keep a short balancing-test record: the data is business-facing, minimal,
  sourced from a licensed provider (Apollo) and public websites, and used for
  relevant B2B outreach the recipient can trivially refuse.
- **Right to object / erasure**: see the deletion procedure below. Objections
  must be honored immediately and permanently.
- **Transparency**: your first outreach (email or call) must identify who you
  are, why you have their details, and how to opt out. The follow-up email
  template includes an unsubscribe line; the Vapi assistant prompt requires
  AI + on-whose-behalf disclosure.
- **Retention**: don't keep stale prospect data forever. Suggested quarterly
  purge of rows untouched for 12 months:
  ```sql
  delete from prospects
  where last_updated < now() - interval '12 months'
    and outreach_status in ('new', 'not_interested', 'contacted');
  ```

## CCPA/CPRA (California — which is where the prospects are)

- B2B contact data is in scope of CPRA. You must honor:
  - **Right to know/delete**: deletion procedure below.
  - **Right to opt out**: the suppression list, below.
- If you sell/share personal information (this pipeline does not), further
  obligations apply. Keep it that way.

## The suppression list (single opt-out mechanism)

The `suppression_list` table is enforced at every stage:

1. **Enrichment (workflow 01)** — suppressed domains are excluded *before*
   any scraping or Apollo enrichment.
2. **Digest (workflow 02)** — the `tier1_prospects` view excludes suppressed
   domains/emails/phones.
3. **Calling (workflow 04)** — suppressed domains/phones are filtered out of
   the dial queue even if a row was previously approved.
4. **Automatic entry (workflow 05)** — when a called prospect asks not to be
   contacted, the workflow sets `do_not_contact = true`, sets
   `outreach_status = 'do_not_call'`, and inserts a suppression row. No
   manual step needed.

Manual opt-out (e.g. someone replies "unsubscribe" to an email):

```sql
insert into suppression_list (domain, email, phone, reason)
values ('example.com', 'owner@example.com', '+15551234567', 'email unsubscribe request');
update prospects set do_not_contact = true where domain = 'example.com';
```

## Deletion requests (GDPR erasure / CCPA delete)

Delete the data **and** keep a suppression entry so the weekly run cannot
re-acquire the same business:

```sql
insert into suppression_list (domain, email, reason)
values ('example.com', 'owner@example.com', 'deletion request YYYY-MM-DD');
delete from prospects where domain = 'example.com';  -- cascades to outreach_log
```

## TCPA — AI voice calls (workflow 04/05)

The FCC has confirmed that AI-generated voices are "artificial or prerecorded
voice" under the TCPA. Treat every Vapi call accordingly:

- **Approval gating**: workflow 04 only ever dials rows a human explicitly set
  to `outreach_status = 'approved'`. Never bypass this.
- **Business numbers only**: the pipeline stores the company's business phone
  (from Apollo org data). Do not load personal/mobile numbers.
- **Calling window**: TCPA permits 8am–9pm in the recipient's local time. The
  default schedule (weekdays 10:00 America/Los_Angeles, California prospects)
  is inside the window. If you expand beyond California, adjust the schedule
  per target timezone.
- **Disclosure**: the assistant must state, at the start of the call, that it
  is an AI assistant and on whose behalf it is calling. This is baked into the
  suggested assistant prompt in docs/setup.md — keep it there.
- **Do-not-call honoring**: any "don't call me" is honored immediately and
  automatically (workflow 05). Also check numbers against the National DNC
  Registry if you scale beyond occasional B2B calls; business-to-business
  calls have exemptions but state mini-TCPA laws (including California's)
  can be stricter.
- **Volume**: keep per-run caps modest (default 10 calls/run). High-volume
  automated calling changes your risk profile and may require consent.

## Storage security

- The Supabase service-role key lives only in the n8n credential store —
  never in the workflow JSON, git, or client-side code.
- Row Level Security: the schema assumes server-side access via the service
  role. If you ever expose these tables to a client app, enable RLS first.
