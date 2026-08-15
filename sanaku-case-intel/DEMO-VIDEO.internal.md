# Demo video — recording + narration guide

Internal only, like `README.internal.md` — never shipped in a client
bundle (`scripts/package-release.sh`'s `git archive` only bundles what's
tracked under `docs/`, not this file).

`scripts/record_demo.py` records a real screen-capture video of the
actual app doing actual work: real Ollama-generated, correctly-cited
answers, real Whisper transcription of a spoken question, real Piper
voice playback. Nothing in the recording is canned or simulated — it's
the genuine product, on your own Mac, with the real stack running.

**One thing it can't do: put sound in the video.** Playwright's browser
video recording is a frame-only capture (CDP screencast) — it never
records speaker output or a microphone, no matter what plays out loud in
the room while it runs. So the saved `.webm` is silent, always. The plan
here is: record the (silent) screen capture, then narrate over it
afterward in any ordinary video editor (iMovie, CapCut, Premiere —
whatever you already have) using the shot list below.

## One-time prep

**1. Get the real stack running**, in its own terminal, and leave it
running for the whole recording session:
```
bash scripts/dev.sh
```
Not `scripts/dev_server_stub.py` — that one fakes every model and would
produce a video full of placeholder answers.

**2. Record the one voice clip the script needs.** Speak this question
out loud into any voice-memo app on your Mac (Voice Memos, QuickTime,
etc.), then export/convert it to a WAV file at
`scripts/demo-assets/voice-question.wav`:

> "What evidence is there that the injury came from the crash?"

This is real human speech, transcribed by real Whisper when the script
runs — it's just recorded once, ahead of time, rather than spoken live
during the take (the take is meant to run unattended). Speak naturally,
then pause in silence for a couple of seconds at the end — the app's own
auto-stop-on-silence logic needs that trailing quiet to know you're
done, the same as it would if you spoke into the mic yourself. Keep the
whole clip well under a minute.

**3. Preflight, in a second terminal** (repo root, with `.venv-dev`
active):
```
python3 scripts/record_demo.py --check
```
Confirms Ollama, both configured models, Piper, the `maria_delgado`
case index, the voice clip, and Chromium are all actually ready —
before you spend a real take finding out one of them isn't. Fix
whatever it flags and re-run until it passes clean.

**4. Full rehearsal, watched live, no video saved:**
```
python3 scripts/record_demo.py --dry-run --headed
```
Run this at least once before the real take. This exact combination —
real recorded audio, real Whisper, real Ollama, real Piper, all
together in one flow — has never been run end-to-end before on any
machine. Expect the first run to be rough; that's what this step is
for. Watch it, note anything that looks off (a selector timing out, an
answer that reads oddly, pacing that feels rushed), and fix or re-tune
before recording for real.

## The real recording

```
python3 scripts/record_demo.py
```
Runs headless (no window to protect from being clicked into or
covered), unattended, start to finish. Output:
```
dist/demo-video/sanaku-demo-<timestamp>.webm
```
No audio track — see above. Pacing between beats can be tuned without
touching the script: `DEMO_BEAT_PAUSE=5 python3 scripts/record_demo.py`
(default `3.5` seconds).

## Beat-by-beat shot list

Use this to write (or read live) narration over the silent video
afterward. Timings are illustrative only — real model inference time
varies run to run; re-time against your own actual recording rather
than trusting these numbers.

| # | On screen | Approx. elapsed* | Suggested narration |
|---|---|---|---|
| 1 | App loads, the case is already selected | 0:00–0:05 | "This is the firm's own case research tool — every document in this case, already loaded and ready." |
| 2 | Types "What did the treating physician say about causation?" — a real, cited answer streams in; the page-3 source card expands to show the actual passage | 0:05–0:30 | "A real question, typed live. This isn't a canned answer — it's reading the actual medical record and pointing to the exact page it came from." |
| 2b | Clicks "Listen to this answer" — audio plays | 0:30–0:38 | "It can read that answer back out loud too, in the firm's own voice — useful hands-free, between meetings, in the car." |
| 3 | Types the paraphrased version — "What evidence is there that the injury came from the crash?" — same underlying passage gets cited again | 0:38–1:00 | "Ask it a completely different way — it still finds the same evidence. This understands the question, it's not just matching keywords." |
| 4 | Clicks "+ Add a note," fills in a phone-call note, saves it | 1:00–1:25 | "Staff can add facts that never made it into a document — a phone call, a clarification — and it becomes a real, citable source from that moment on." |
| 5 | Clicks the mic, a real spoken question is heard and transcribed, the question auto-submits, the answer generates and reads itself back automatically | 1:25–1:55 | "And you can just talk to it." |

*Approximate only.

## Do / don't

- **Do** expand the source card citing **page 3** of
  `medical_record_dr_chen.pdf` on camera — confirmed clean of any
  disclaimer text (see `scripts/generate_sample_case.py`).
- **Don't** expand a source card citing **page 1** of either fixture
  document — both carry a visible `"FICTIONAL DEMO DATA — not a real
  patient, firm, or provider"` line, since this is fixture data, not a
  real case. Fine to show on purpose if you want to address it directly
  on camera; the script itself only ever expands the p.3 card, by
  design.
- If you want a genuinely different spoken question for beat 5 instead
  of reusing question 2's wording: verify it retrieves and cites
  correctly first —
  `python3 cli.py ask --case-id maria_delgado --question "..."` — before
  recording it into `voice-question.wav`. Nothing beyond the two proven
  questions above has been confirmed against real retrieval.
- The manual note added in beat 4 is **not** followed up with a
  question proving it's instantly citable — that's a great next beat to
  add later, but it depends on real retrieval behavior that hasn't been
  rehearsed yet for this exact case. Try it with `--dry-run --headed`
  first if you want to add it; don't bake an unrehearsed beat into a
  real take.
