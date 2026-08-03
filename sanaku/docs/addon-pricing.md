# Add-on pricing — voice agents

What to charge, and why those numbers.

---

## What a voice minute actually costs you

| Component | Per minute |
|---|---|
| Vapi platform | ~$0.05 |
| Speech-to-text | ~$0.01 |
| LLM (small model, short turns) | ~$0.01–0.03 |
| Text-to-speech | ~$0.03–0.08 |
| Twilio carrier | ~$0.014 |
| **All-in** | **~$0.13–0.18** |

Plus ~$1.15/month per phone number.

A qualification call runs 2–4 minutes. Call it **$0.45 a call**. A busy home-services
client taking 120 missed calls a month costs you about **$55/month to serve**.

That number is the floor. Everything above it is provisioning, script writing,
calendar wiring, tuning the thing when it mishears a street name, and carrying
support — which is the actual work, and where the price comes from.

---

## The catalog

**There is no price table in this file, deliberately.** There used to be, and by
the time anyone noticed it had drifted badly: it listed eight of the
twenty-eight services, and both its overage and its per-lead figures were well
adrift of what the catalog actually charged. A hand-typed table sitting
next to a generator will always lose to it, and the copy people read is the one
that is wrong.

The prices live in `sanaku_addons`. To see them:

```sh
sh ~/sanaku.sh sellsheet     # pulls live and writes the sheet + workbook
```

That produces `sell-sheet.html` (printable, for clients) and
`sanaku-services.xlsx` (every figure a formula, for you). `node
scripts/audit.mjs` fails if any other document quotes a number the catalog does
not contain.

**Margin at the included tier:** 400 minutes costs ~$52–72 to serve against $350
collected — roughly 79–85%. Overage priced well above the ~$0.18 all-in cost
keeps that margin roughly constant as volume grows, which is the entire point of
the allowance.

**Never sell unlimited minutes.** Your cost is linear in volume and a flat
unlimited price is a bet that your best client stays small. The allowance is
not a nickel-and-dime tactic, it is the thing that stops one busy client
eating the margin on all the others.

---

## Why the verticals differ

**Home services $350.** A plumbing company missing 30 calls a month, at ~$400
a job, is losing $12,000/month. $350 is an easy yes and they do the arithmetic
themselves on the call.

**Law $650.** Longer intake, a script that has to avoid giving legal advice,
conflict-of-interest flagging. One signed matter is worth $5,000–$50,000, so
the price is not the objection — trust is.

**Medical $650, flat only.** Same intake burden, plus compliance overhead
(below). Never per-patient.

**After-hours $175** exists to have something to say when $350 stalls. It is
also the honest recommendation for a small operator, since after-hours is when
most missed calls happen anyway.

---

## The rules this is built around

Three of these are encoded so they cannot be got wrong by accident; the rest
you have to hold.

**No per-patient pricing in healthcare.** Per-patient and percentage
arrangements can implicate anti-kickback and fee-splitting rules. The
`sanaku_addons_pricing_legal` CHECK constraint makes a medical add-on with a
`per_lead_fee` fail to insert.

**No fee-splitting with law firms.** Per-lead means per intake *delivered*,
never per case signed and never a share of fees or recoveries — most states
bar that with non-lawyers. The catalog copy says so where the client reads it.

**No cold outbound voice, ever.** The FCC has held that AI-generated voices are
"artificial" under the TCPA. Calling a mobile with one, without prior express
written consent, runs $500–$1,500 **per call**. Both callback products are
scoped to people who just contacted the client, about the thing they contacted
them about. This is the rule most likely to end the business if broken, and it
is the easiest one to break by "just trying a small list."

**Disclosure, twice.** The agent says it is automated, and says the call is
recorded, before it asks anything. California is a two-party consent state, and
several states now separately require AI disclosure.

**Medical needs BAAs before go-live.** A voice agent talking to patients handles
PHI, so every vendor in the call path — Vapi, Twilio, the model provider, the
speech vendors, wherever recordings land — needs a signed business associate
agreement. Some do not offer one on a self-serve plan. **Check this before you
sell the medical add-on**, not after; the `requires_baa` flag surfaces it in
the portal but does not do the paperwork.

---

## How a client buys one

Portal → **Add services**. They see their vertical's catalog with setup,
monthly, included minutes, overage and per-lead all stated up front, plus the
compliance line for that product. They hit *Ask about this* and can leave a note.

It lands in your command center under **Clients** as a pending request with the
monthly value attached. You approve or decline.

Two things the database enforces rather than trusting the UI:

- **A client cannot activate their own billing.** Every commercial field is
  overwritten on insert, so a hand-crafted request cannot arrive pre-approved
  or priced at zero. There is no client UPDATE policy at all — with one,
  PostgREST's upsert would let them flip their own row to `active`.
- **Terms freeze at approval.** The catalog price is copied onto the
  subscription when you approve it. Raising a price next year never reaches
  back and re-prices someone who signed up today.

Approving is not provisioning. You still need to buy the number, write the
script, and amend the agreement — the confirmation dialog says so.

---

## What to say when they ask "why so much for a robot"

Don't defend the technology, price against the alternative. A human answering
service runs $1.50–$3.00 a minute or $300–$600/month for modest volume, does
not book into their calendar, and does not work at 2am. A part-time receptionist
is $2,500/month loaded. The agent answers on the second ring, every time, and
the first month usually pays for itself out of jobs that used to go to voicemail.

Then show them their own number: the after-hours count already on their
overview tab is the argument.
