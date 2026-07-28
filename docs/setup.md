# Setup Guide — AI Prospect Tiering Pipeline

End-to-end setup for the n8n prospecting pipeline: Apollo discovery → website
signal scraping → scoring → Supabase storage → weekly Tier 1 digest → Vapi
voice outreach.

## Prerequisites

| What | Where | Free tier notes |
|---|---|---|
| n8n 1.x | self-hosted or n8n Cloud | any recent 1.x version |
| Supabase project | supabase.com | free tier is plenty |
| Apollo.io API key | app.apollo.io → Settings → Integrations → API | ~50 email-reveal credits/month; **search calls do not spend credits** |
| Vapi account | vapi.ai | pay-as-you-go per call minute |
| SMTP account | Gmail app password or any SMTP provider | for digest + follow-up emails |
| BuiltWith API key (optional) | api.builtwith.com | free Domain API is heavily rate-restricted; the pipeline works without it |

## 1. Supabase

1. Create a project, then open the SQL editor and run the whole of
   [`supabase/schema.sql`](../supabase/schema.sql). It is idempotent — safe to re-run.
2. Copy from Project Settings → API:
   - the **Project URL** (becomes the `SUPABASE_URL` env var)
   - the **service_role key** (goes into an n8n credential, never into git)

## 2. n8n environment variables

Set these on your n8n instance (Settings → Variables on n8n Cloud, or the
container/host environment when self-hosting). See [`.env.example`](../.env.example).

```
SUPABASE_URL=https://<project-ref>.supabase.co
DIGEST_FROM_EMAIL=you@yourdomain.com
DIGEST_TO_EMAIL=you@yourdomain.com
VAPI_ASSISTANT_ID=<vapi assistant uuid>
VAPI_PHONE_NUMBER_ID=<vapi phone number uuid>
VAPI_WEBHOOK_SECRET=<long random string you invent>
BUILTWITH_API_KEY=            # optional; leave unset to skip BuiltWith entirely
```

## 3. n8n credentials

Create these credentials (names must match exactly — the workflows reference
them by name):

| Credential name | Type | Configuration |
|---|---|---|
| `Supabase Service Role (Header Auth)` | Header Auth | name: `apikey`, value: your Supabase **service_role** key |
| `Apollo API Key (Header Auth)` | Header Auth | name: `x-api-key`, value: your Apollo API key |
| `Vapi API Key (Header Auth)` | Header Auth | name: `Authorization`, value: `Bearer <your Vapi private key>` |
| `SMTP Account` | SMTP | your SMTP host/port/user/password |

> Supabase note: the `apikey` header alone authenticates PostgREST requests
> (it is used as the JWT when no `Authorization` header is present). If your
> project is configured to require both, add an `Authorization` header with
> value `Bearer <same service_role key>` in each HTTP Request node's header
> parameters.

## 4. Import the workflows

Import the five files from [`n8n/workflows/`](../n8n/workflows/) (Workflows →
Import from File), in any order:

1. `03-error-handler.json` — import **first** so you can wire it up below
2. `01-prospect-enrichment.json`
3. `02-tier1-digest.json`
4. `04-vapi-outreach.json`
5. `05-vapi-call-results.json`

After import, open each workflow's nodes that show a credential warning and
select the matching credential you created in step 3.

**Attach the error workflow** (cannot be pre-wired in the JSON): in workflows
01, 02, and 04 open Workflow → Settings → *Error Workflow* and select
`Prospecting - 03 Global Error Handler`. Unhandled failures then land in the
Supabase `error_log` table with `level='fatal'`.

## 5. Vapi assistant

1. In the Vapi dashboard create an **assistant** for outbound prospecting.
   Suggested system prompt skeleton (the workflow injects the variables):

   > You are an assistant calling {{company_name}} on behalf of Ismail's AI
   > automation agency. You are speaking with {{contact_name}}. **Begin by
   > disclosing that you are an AI assistant and who you are calling on behalf
   > of** (this is legally required). The business is in the {{vertical}}
   > space and currently has little or no automation on its website. Briefly
   > offer a free demo of AI appointment booking / missed-call recovery. If
   > they are interested, say a follow-up email is coming. If they ask not to
   > be called again, apologize, confirm they will be removed, and end the
   > call politely.

2. Under the assistant's **Analysis** settings, add a structured-data field so
   the webhook gets a clean outcome (recommended):
   - schema property `outcome` with enum values:
     `interested`, `callback`, `not_interested`, `voicemail`, `asked_not_to_call`, `no_answer`, `contacted`
   - (Workflow 05 falls back to keyword-matching the call summary when this is
     absent, but the structured field is far more reliable.)
3. Buy or import a **phone number**; copy its ID and the assistant's ID into
   the `VAPI_PHONE_NUMBER_ID` / `VAPI_ASSISTANT_ID` env vars.
4. Activate workflow 05, copy the **production webhook URL** from its
   `Vapi Webhook` node, and set it as the assistant's **Server URL**. Set the
   server **secret** to the same value as your `VAPI_WEBHOOK_SECRET` env var
   (Vapi sends it as the `x-vapi-secret` header; workflow 05 rejects anything
   else with a 401).

## 6. Activate and run

Activate all five workflows. Schedules (workflow timezone is
`America/Los_Angeles`, editable in each workflow's settings):

| Workflow | Schedule | Change to |
|---|---|---|
| 01 Enrichment | Mondays 06:00 | — |
| 02 Tier 1 Digest | Mondays 08:00 | daily: cron `0 8 * * 1-5` in `Digest Trigger` |
| 04 Vapi Outreach | weekdays 10:00 | keep inside 8am–9pm local (TCPA) |
| 05 Call Results | webhook (always on) | — |

Kick off a first run manually: open workflow 01 and click *Execute workflow*.
Then check Supabase: `select company_name, tier, intent_score from prospects order by intent_score desc;`

### The weekly loop

1. Monday 06:00 — enrichment run discovers, scrapes, scores, and stores new prospects.
2. Monday 08:00 — digest email lands with ranked Tier 1 prospects.
3. You approve the ones worth calling:
   ```sql
   update prospects set outreach_status = 'approved'
   where domain in ('example-firm.com', 'other-dental.com');
   ```
4. Weekdays 10:00 — workflow 04 dials approved prospects (max 10/run, 30s apart).
5. As calls end, workflow 05 logs outcomes, emails interested prospects a
   follow-up, and alerts you on `interested` / `callback` outcomes.

## Free-tier limits and tuning

All caps live in workflow 01's `Run Config` node:

- `maxRevealsPerRun: 12` — Apollo `people/match` is the **only**
  credit-spending call. 12/run × ~4 runs/month = 48 ≤ 50 free credits. The
  run also checks month-to-date usage in the `api_usage` table and skips
  itself entirely at ≥ `monthlyCreditCap` (48).
- `maxNewPerVertical: 8` — companies scraped per vertical per run (searching
  and scraping are free; raise this if you want a bigger scored backlog).
- Apollo free-tier searches return masked emails (`email_not_unlocked@...`) —
  that is why the pipeline searches wide but reveals narrow. Qualified
  prospects beyond the reveal cap are stored with
  `signals.email_pending = true` and appear in the digest as "(pending)".
- BuiltWith's free Domain API allows very few lookups; the `BuiltWith
  Enabled?` gate skips it when `BUILTWITH_API_KEY` is unset and the HTML
  scraper remains the authoritative signal source either way.

### Rate limiting / errors

- Every external HTTP node retries 3× with a 5s pause.
- The two Apollo search nodes have an additional exponential-backoff loop
  (5s → 10s → 20s → 40s → 80s) on 429/5xx responses.
- Website fetches are paced 2s apart; a dead site is logged to `error_log`
  (`level='skipped'`) and never kills the run.
- Review problems with:
  ```sql
  select created_at, workflow, node, level, domain, message
  from error_log order by created_at desc limit 50;
  ```
  Run summaries are the `level='info'` rows.

## Compliance

Read [`docs/compliance.md`](compliance.md) before switching anything on —
especially the TCPA section for voice outreach and how the
`suppression_list` table enforces opt-outs across the whole pipeline.
