# Why every price is what it is

Written down because the reasoning kept living in chat messages that scroll
away. If you are asked "why do you charge that" on a sales call, the answer is
in here. If you are deciding whether to change a number, so is the constraint
that stops you.

**No prices in this file.** They live in `sanaku_addons` and print via
`sh ~/sanaku.sh sellsheet`. A number typed here would drift, and
`node scripts/audit.mjs` would fail the moment it did.

---

## 1. What it costs to serve

Per voice minute, all-in: **$0.13–0.18** (Vapi platform, speech-to-text, model,
text-to-speech, Twilio carrier). Per text: **$0.011**. Plus about $1.15/month
per phone number.

Everything above that floor is provisioning, script writing, calendar wiring,
tuning the agent when it mishears a street name, and carrying support — which
is the actual work, and where the price comes from.

**Gross margin at the included allowance runs 78–99%.** The thinnest is instant
callback at 78%; the messaging products are near 99% because a text costs
almost nothing. Overage runs 60–84%.

That margin is healthy enough that **cost is not the reason for any price
here.** Every number below is set against what the client gains or what the
market charges, not against what it costs us.

---

## 2. Why the verticals differ for identical software

The workflows do not know what vertical a client is in — they read the client
row. Law and medical price higher because:

- intake is longer and the script needs more care
- one captured matter is worth far more than one captured plumbing job
- the compliance burden is real and falls on us

Per the leak calculator's own figures: one signed personal-injury case is worth
$3,000–$5,000+ in fees; one booked patient $75–$300; one home-services job
$200–$2,000+. The price tracks the value of what gets caught.

---

## 3. Per-lead, and why it moved

It was set well below market and has been corrected to what the website already
advertised.

The comparison that matters: **Angi and Thumbtack sell home-services leads at
$25–$120, and personal-injury leads average $284** — and those leads are **sold
to three to eight competitors at once**. Ours are exclusive: someone dialled
that specific business. An exclusive, high-intent inbound lead is worth more
than a shared cold one, not less.

Cost per *booked job* on those platforms — Google LSA ~$168, Thumbtack ~$250,
Angi ~$542 for HVAC — is the number the per-booked-job option competes against.

**Three rules constrain what can be charged:**

- **Healthcare: flat fee only.** Per-patient compensation can implicate
  anti-kickback and fee-splitting rules. `sanaku_addons_pricing_legal` makes a
  medical row with a per-lead fee **fail to insert** — an illegal structure is
  not representable, not merely discouraged.
- **Law: per intake delivered, never per case signed.** A share of fees or
  recoveries is fee-splitting with a non-lawyer under ABA Model Rule 5.4.
- **Conversion pricing: home services only**, enforced by
  `sanaku_addons_booked_home_only`.

**Always cap it.** `per_lead_monthly_cap` is what makes the bill predictable
enough for a client to say yes to. A cap set once and forgotten silently becomes
the price — at $100/lead a $500 cap is five leads — so it needs revisiting
whenever the rate changes.

---

## 4. Why "per booked job" means booked, not paid

The system's central claim, repeated in `Statements.jsx`, `Earnings.jsx` and on
the site, is *"we bill from our meter, never from what you report."*

`sanaku_client_leads.outcome` allows `booked`, `converted`, `no_response`,
`lost`. **Only `booked` is written by the system** — `t2-voice-agent` sets it
from `appointment_booked`. `converted` is set by nobody, and `reported_value`
is explicitly labelled *"renewal ammunition, not a billing input"* because
clients self-report it.

So billing on conversion would mean trusting a number from someone who pays less
by understating it. Booked is real, timestamped and auditable. That is the whole
argument, and it is worth making on a sales call: **the client can check every
line against their own phone records.**

---

## 5. Why packages discount 27–31%

The parts overlap heavily in setup, and one client running four workflows costs
barely more to serve than one running two. The discount is real economics, not a
concession.

Two rules hold:

- **Packages price off the à-la-carte sum, never off another package.**
  Discounting a discount compounds, and the second one is invisible on an
  invoice.
- **No package contains both after-hours answering and the full phone agent.**
  After-hours *is* the phone agent restricted to closed hours; selling both
  charges twice for one product. Enforced by a check in `migration-012`.

---

## 6. The setup fee, and the free month

**They pay the service's own setup fee, then thirty days before any monthly
charge, then the monthly begins.** There is no separate trial price and no
discount to claw back — the free month is the offer.

Why keep setup at all when the pitch is low-risk: free pilots attract people who
were never going to buy. Setup filters that, pays for build time, and puts cash
in on day one. **De-risk the retainer instead** — that is what the free month is
for.

Why per service rather than one flat number: a $1,500 intake-agent build and a
$250 review-request build do not cost the same to stand up, and charging the
same for both loses money on one and overcharges on the other.

**The clock starts when the service goes live, not when they sign.** Anything
that sends SMS needs A2P 10DLC carrier registration first, which takes days;
the voice agent can start same-day. Burning a client's free month while they
wait on carrier vetting is how a good offer produces a bad first impression.

For comparison, agencies charge $1,500–$15,000 setup for bespoke automation
builds. Ours is lower on purpose — this is a productised service, and the
recurring revenue is the business. *(That range comes from agency marketing
material and is self-interested; treat it as a ceiling, not a benchmark.)*

---

## 7. Where the pricing sits against the market

- **AI phone agent, home services.** Above self-serve AI tools ($18–$50) and
  below traditional answering services ($300–$1,500; $450–$650 for a plumber).
  Roughly level with Smith.ai for a busy contractor.
- **Legal intake.** Looks dear next to Smith.ai's ~$293 until you normalise —
  they include about 30 calls, we include 400 minutes. Per call we are cheaper
  than their human tier and dearer than bare AI, which is the right place.
- **Missed-call text-back.** This is the weak spot. It sits level with Podium
  (~$249) and Weave ($199–$249), which are **whole platforms** — reviews,
  payments, webchat, VOIP. Done-for-you justifies a premium over software you
  configure yourself, but that argument has to be won on every call. **Lead with
  the recovery package instead**: four workflows against four separate tools is
  a comparison that wins itself.

---

## 8. What stops any of this drifting

- Prices live in `sanaku_addons`. Both the sell sheet and the workbook are
  generated from it; neither is typed.
- `node scripts/audit.mjs` extracts every dollar figure from `site/*.html`,
  `docs/*` **and the demo client seed** and fails when one is not in the
  catalog. The demo seed is included because its own comment says it is used on
  sales calls and in the demo video — it was seeded at a rate no document
  agreed with, and nothing else would have caught it.
- The generator refuses to print a sheet whose package arithmetic does not hold.
- Terms freeze onto a subscription at approval, so raising a catalog price never
  reaches back and re-prices someone who signed up last quarter.
