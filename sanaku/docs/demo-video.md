# The demo video

Two and a half minutes. A prospect hears the agent answer a call, then watches
the lead appear in the dashboard with the recording attached. Nothing in it is
simulated — you place a real call to a real number and film what happens.

The whole argument is one sentence: *this is the call you would have missed.*
Everything below serves that sentence.

---

## Before the camera is on

**Once, ever:**

```
sh ~/sanaku.sh migrate                     # adds 'voice' as a lead channel
sh ~/sanaku.sh voice                       # installs T2, prints the VAPI setup
sh ~/sanaku.sh demo seed +1XXXXXXXXXX      # the number VAPI answers on
sh ~/sanaku.sh dashboard                   # deploys the portal changes
```

Then wire VAPI as `voice` printed it, and place one throwaway call to check the
lead lands. Do not discover a problem on take one.

**Before every take:**

```
sh ~/sanaku.sh demo reset
```

That empties the demo client's leads. The portal goes back to "No leads
captured yet," which is what makes the lead appearing feel like it happened
rather than like it was always there.

**Set the stage:**

- Film in the evening. The demo client's hours are 7am–5pm Mon–Fri, so an
  evening call is logged `after_hours` — and "while you were closed" is the
  line that sells this.
- Two devices: the phone you call from, and the screen showing the portal.
- Open the portal *before* you start: Command center → Clients → **Portal** on
  the Delgado row. It opens full-screen with no operator chrome in the shot.
- Phone on speaker, close to the mic. The agent's voice is the product.
- Close every other tab. A stray tab title is how a prospect learns the name of
  another client.

---

## What must never be on screen

These are the same fields `scripts/audit.mjs` blocks from client-facing code,
for the same reason:

- `monthly_retainer`, `per_lead_fee`, `rev_share_pct`, `per_lead_monthly_cap`
- The **Pipeline** tab — that is your prospect list, including people you have
  not contacted yet
- The **Earnings** tab
- The client roster — any real client's name
- Your Supabase or n8n tabs

The portal preview shows only the columns a client can read. The risk is not
the portal; it is everything around it.

---

## The sequence

**0:00 — Cold open, phone in frame.** Dial the number. Say nothing. Let it ring
once.

> "This is a plumbing company's after-hours line."

**0:06 — The agent picks up.** Do not talk over it. The disclosure — "you're
speaking with an automated assistant, and this call is recorded" — needs to be
audible, because it is the thing a sceptical business owner is listening for.

**0:15 — Play the homeowner.** Be a real caller, not a scripted one:

> "Uh, yeah — my water heater just burst, there's water all over the garage."

Let the agent work. Let it ask about the shutoff valve. Answer slightly out of
order once, so it visibly handles a real conversation rather than a script.
Give a callback number and an address. Let it book a time.

**1:20 — Hang up.** One beat of silence.

> "That call took ninety seconds and nobody was awake for it."

**1:25 — Cut to the screen.** Refresh. The lead is there.

> "Name, number, the actual job, the address. Marked after-hours, because it
> was."

**1:40 — Press Listen to the call.** Let four or five seconds of the real
recording play out loud. **This is the shot the video exists for** — the
prospect is hearing, inside the dashboard, the call they would have lost.

**1:50 — Scroll the transcript.** Do not narrate it. Let them read.

**2:00 — Land it.**

> "Every call your phone doesn't catch ends up here, with the recording, before
> you're back at your desk. That's the whole thing."

**2:10 — Stop.** No pricing, no features, no outro card. The next thing they
should want is to ask what it costs, and you cannot answer a question they
never got to ask.

---

## Say this, not that

| Don't | Do |
|---|---|
| "Our AI-powered omnichannel platform…" | "It picks up when you can't." |
| "Fully automated lead capture" | "It writes down what's wrong and where they are." |
| "Never miss a lead again" | "This is the call you would have missed." |
| "Book a discovery call" | Nothing. Stop talking. |

The demo company is fictional. Say "this is a demo account" once, early, if you
show the company name — do not let a prospect believe Delgado Plumbing is a
reference customer they could call.

---

## When it goes wrong on camera

**The agent answers but no lead appears.** Almost always the number: the one
VAPI answered on has to equal `inbound_number` exactly, in E.164.

```
sh ~/sanaku.sh demo status
```

**The lead appears but has no recording.** Recording is off in the assistant's
artifact plan, or `serverMessages` is not `end-of-call-report`.

**Nothing at all.** Check n8n → Executions for the last run of
*Sanaku - T2 Voice Agent*. Three things stop it deliberately and each says so
in the execution: the message was not a call report, the client is paused
(`workflow_enabled = false`), or that call id was already logged.

**The owner-alert text does not send.** Expected until a Twilio credential is
picked by hand on the *Alert The Owner* node. The lead still lands — that node
is set to carry on rather than fail the run — so it does not affect the video.

---

## If you want the SMS product in the same video

T1 is a separate, shorter cut: call the number and let it ring out, and the
text-back arrives on the caller's phone in a few seconds. Film the phone, not
the screen. It needs no VAPI and no per-minute spend, so it is the one to shoot
first if the voice agent is not wired up yet.
