#!/usr/bin/env python3
"""Records a real, live demo video of the running app for a customer-
facing sales video: real Ollama generation, real Whisper transcription,
real Piper voice synthesis. Nothing here is faked or scripted content —
every answer, citation, and spoken response comes from the live stack.

IMPORTANT — the saved .webm has NO AUDIO TRACK. Playwright's browser
video recording is a frame-only CDP screencast; it never captures
speaker output or a microphone, regardless of what plays out loud
during the take. See DEMO-VIDEO.internal.md for the narration plan
this implies — audio (voiceover) is always a post-production step,
added afterward in a video editor against the shot list there.

Run this against the REAL stack, never against dev_server_stub.py:

    Terminal 1:  bash scripts/dev.sh
    Terminal 2:  python3 scripts/record_demo.py --check          # preflight only
                 python3 scripts/record_demo.py --dry-run --headed  # full rehearsal, no video saved
                 python3 scripts/record_demo.py                  # the real take

Output: dist/demo-video/sanaku-demo-<timestamp>.webm

One-time prep this script cannot do for you: record
scripts/demo-assets/voice-question.wav by speaking one of the two
proven demo questions into any voice-memo app and exporting it as a
WAV. See DEMO-VIDEO.internal.md for the exact steps.
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import time
from pathlib import Path

import httpx
from playwright.sync_api import Page, TimeoutError as PWTimeoutError, sync_playwright

PROJECT_ROOT = Path(__file__).resolve().parent.parent
APP_URL = "http://localhost:5173"
API_URL = "http://127.0.0.1:8001"
PIPER_URL = "http://127.0.0.1:5001"
CASE_ID = "maria_delgado"

OUT_DIR = PROJECT_ROOT / "dist" / "demo-video"
VOICE_CLIP = PROJECT_ROOT / "scripts" / "demo-assets" / "voice-question.wav"

VIDEO_SIZE = {"width": 1920, "height": 1080}
DEFAULT_TIMEOUT_MS = 120_000  # real inference, not a stub - the default 30s is too tight

# Tunable without touching code, in case a rehearsal shows the pacing
# feels rushed or draggy on real hardware.
BEAT_PAUSE = float(os.environ.get("DEMO_BEAT_PAUSE", "3.5"))

# The two questions already proven (README.internal.md) to retrieve and
# correctly cite [medical_record_dr_chen.pdf, p.3] - a direct causation
# opinion and a differently-worded paraphrase of the same underlying
# fact, to show semantic retrieval rather than keyword matching.
QUESTION_1 = "What did the treating physician say about causation?"
QUESTION_2 = "What evidence is there that the injury came from the crash?"

MANUAL_LABEL = "Phone call with client, 3/10/2024"
MANUAL_NOTE = (
    "Client confirmed by phone that she had no prior history of "
    "lower-back injury before the collision."
)
MANUAL_DATE = "2024-03-10"


# --------------------------------------------------------------------
# Preflight
# --------------------------------------------------------------------
def _fail(message: str) -> None:
    print(f"\n[record_demo] {message}", file=sys.stderr)
    sys.exit(1)


def preflight() -> None:
    """Fail fast, with an actionable message, before a browser is ever
    opened or a take is ever spent - same fail-fast ethos as
    scripts/dev.sh's own startup checks."""
    print("[record_demo] Preflight checks…")

    try:
        resp = httpx.get(f"{API_URL}/health", timeout=10)
        resp.raise_for_status()
        health = resp.json()
    except httpx.HTTPError as e:
        _fail(
            f"Could not reach {API_URL}/health ({e}). Is the real stack "
            "running? Start it in another terminal with: bash scripts/dev.sh"
        )
        return

    missing = [
        field
        for field in ("ollama_reachable", "gen_model_available", "embed_model_available")
        if not health.get(field)
    ]
    if missing:
        _fail(
            f"/health reports these as not ready: {missing} (full response: {health}). "
            "Run `ollama serve` and make sure both models in config/client.json are "
            "pulled (`ollama pull <gen_model>`, `ollama pull <embed_model>`)."
        )
    print("    Ollama + models: ready")

    try:
        httpx.get(f"{PIPER_URL}/", timeout=5)
    except httpx.HTTPError as e:
        _fail(
            f"Could not reach the local voice service at {PIPER_URL} ({e}). "
            "See README.internal.md's Voice section for the one-time setup, then "
            "start it (scripts/dev.sh does this automatically once it's set up)."
        )
    print("    Piper voice service: reachable")

    index_dir = PROJECT_ROOT / "data" / "cases" / CASE_ID / "index"
    if not index_dir.exists():
        _fail(
            f"{index_dir} doesn't exist - the '{CASE_ID}' case hasn't been ingested. "
            f"Run: python3 cli.py ingest --case-id {CASE_ID}"
        )
    print(f"    Case '{CASE_ID}': already ingested")

    if not VOICE_CLIP.exists():
        _fail(
            f"{VOICE_CLIP} doesn't exist yet. Record one of the two proven demo "
            "questions into any voice-memo app on your Mac and export it as a WAV "
            "there - see DEMO-VIDEO.internal.md for the exact steps."
        )
    print(f"    Voice clip: found ({VOICE_CLIP.name})")

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            browser.close()
    except Exception as e:  # Playwright raises a plain Exception for a missing browser
        _fail(
            f"Could not launch Chromium ({e}). If this is the first time Playwright "
            "runs on this machine: python3 -m playwright install chromium"
        )
    print("    Chromium: installed")
    print("[record_demo] All preflight checks passed.\n")


def warm_models() -> None:
    """Forces every real model's cold-start (embed+gen, whisper,
    piper) to happen now, via direct HTTP calls that never touch the
    browser - so none of this appears in the recorded video. This
    matters more than it might look: this is very likely the first
    time real Whisper -> real Ollama -> real Piper have all been
    exercised together in one flow on this machine, and a first-ever
    cold model load can take minutes, not seconds."""
    print("[record_demo] Warming models (this can take a while on a first run)…")

    t0 = time.time()
    httpx.post(
        f"{API_URL}/ask",
        json={"case_id": CASE_ID, "question": "warm-up, ignore this answer", "history": []},
        timeout=180,
    )
    print(f"    generation + embedding models warm ({time.time() - t0:.1f}s)")

    t0 = time.time()
    httpx.post(
        f"{API_URL}/transcribe",
        files={"audio": ("warmup.wav", VOICE_CLIP.read_bytes(), "audio/wav")},
        timeout=180,
    )
    print(f"    whisper model warm ({time.time() - t0:.1f}s)")

    t0 = time.time()
    httpx.post(f"{API_URL}/speak", json={"text": "Warming up."}, timeout=180)
    print(f"    piper voice warm ({time.time() - t0:.1f}s)")
    print("[record_demo] Models warm.\n")


# --------------------------------------------------------------------
# Small waiting helper - polls a predicate rather than relying only on
# Playwright's own wait_for_selector, since "wait until this thing that
# might already be gone has fully detached" is awkward to express with
# a single selector state.
# --------------------------------------------------------------------
def wait_until(predicate, *, timeout_ms: int = DEFAULT_TIMEOUT_MS, poll_ms: int = 250, description: str = "condition"):
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(poll_ms / 1000)
    raise PWTimeoutError(f"Timed out waiting for: {description}")


def pause(seconds: float = BEAT_PAUSE) -> None:
    time.sleep(seconds)


# --------------------------------------------------------------------
# Demo beats
# --------------------------------------------------------------------
def beat_confirm_case(page: Page) -> None:
    print("[beat] Loading the app and confirming the case…")
    page.goto(APP_URL)
    page.wait_for_selector(".firm-name", timeout=DEFAULT_TIMEOUT_MS)

    # With only one case in data/cases/, the app auto-selects it - no
    # click needed. Fall back to typing it in if that ever changes (a
    # second case gets added later and the UI switches to a real
    # <select>), so this script doesn't silently break.
    def case_ready() -> bool:
        loc = page.locator("input.case-select")
        if loc.count() and loc.input_value() == CASE_ID:
            return True
        select_loc = page.locator("select.case-select")
        if select_loc.count() and select_loc.input_value() == CASE_ID:
            return True
        return False

    try:
        wait_until(case_ready, timeout_ms=15_000, description="case auto-selected")
    except PWTimeoutError:
        select_loc = page.locator("select.case-select")
        if select_loc.count():
            select_loc.select_option(CASE_ID)
        else:
            page.fill("input.case-select", CASE_ID)
    pause()


def _wait_for_generation_done(page: Page) -> None:
    # The turn being generated is always the LAST .turn article once
    # the request has actually started (App.jsx appends it to `turns`
    # immediately, with turn.data.streaming true - the separate
    # aria-busy skeleton article is only shown before that happens).
    wait_until(
        lambda: page.locator("article.turn").last.locator(".generating-indicator").count() == 0,
        timeout_ms=DEFAULT_TIMEOUT_MS,
        description="answer generation to finish",
    )


def beat_typed_question(page: Page, question: str, *, expand_p3_source: bool, click_listen: bool) -> None:
    print(f"[beat] Typed question: {question!r}")
    page.fill("input.question-input", question)
    page.click("button.ask-button")

    # Wait for a new turn (or the pre-turn skeleton) to appear at all.
    wait_until(
        lambda: page.locator("article.turn").count() > 0,
        timeout_ms=30_000,
        description="a turn to appear",
    )
    _wait_for_generation_done(page)
    pause()

    last_turn = page.locator("article.turn").last

    if expand_p3_source:
        # Only expand a source card whose page is p.3 - that's the one
        # passage confirmed (scripts/generate_sample_case.py) to be
        # free of the "FICTIONAL DEMO DATA" disclaimer text. Page 1 of
        # either fixture document carries that disclaimer and should
        # never be the one shown expanded on camera.
        cards = last_turn.locator("li.source-card")
        expanded_one = False
        for i in range(cards.count()):
            card = cards.nth(i)
            page_label = card.locator(".source-page").inner_text()
            if page_label.strip() == "p.3":
                card.locator("button.source-toggle").click()
                page.wait_for_selector("p.source-text", timeout=10_000)
                expanded_one = True
                pause(BEAT_PAUSE + 1.5)  # extra beat to let the passage be readable
                break
        if not expanded_one:
            print("    (no p.3 source card found this run - skipping the expand beat, not failing the recording)")

    if click_listen:
        listen_btn = last_turn.locator("button.voice-button")
        wait_until(lambda: listen_btn.is_enabled(), timeout_ms=15_000, description="Listen button to be enabled")
        listen_btn.click()
        wait_until(
            lambda: "is-active" in (listen_btn.get_attribute("class") or ""),
            timeout_ms=15_000,
            description="playback to start",
        )
        pause(BEAT_PAUSE + 1.5)


def beat_manual_entry(page: Page) -> None:
    print("[beat] Adding a manual note…")
    page.click("button.manual-entry-toggle")
    page.wait_for_selector("form.manual-entry-form", timeout=10_000)

    page.fill("form.manual-entry-form input.manual-entry-input", MANUAL_LABEL)
    page.fill("form.manual-entry-form textarea.manual-entry-input", MANUAL_NOTE)
    page.fill("form.manual-entry-form input[type='date']", MANUAL_DATE)
    page.select_option("form.manual-entry-form select.manual-entry-input", "exact")

    page.click("button.manual-entry-submit")
    page.wait_for_selector("p.manual-entry-success", timeout=30_000)
    pause(BEAT_PAUSE + 1)


def beat_voice_question(page: Page) -> None:
    print("[beat] Asking by voice…")
    turns_before = page.locator("article.turn").count()

    page.click("button.mic-button")
    page.wait_for_selector("p.voice-status", timeout=10_000)

    # Chromium is feeding VOICE_CLIP as the fake mic input continuously;
    # the app's own real silence-detector auto-stops recording once the
    # clip's trailing silence is detected - no second click needed.
    # Real transcription, then a real auto-submitted question follow.
    wait_until(
        lambda: page.locator("article.turn").count() > turns_before,
        timeout_ms=60_000,  # AUTO_STOP_MAX_MS (60s) is the hard cap on the recording side alone
        description="voice question to transcribe and auto-submit",
    )
    _wait_for_generation_done(page)

    # A voice-asked answer auto-plays itself - confirm that actually
    # happened rather than assuming it, then hold on the final frame.
    last_turn = page.locator("article.turn").last
    listen_btn = last_turn.locator("button.voice-button")
    try:
        wait_until(
            lambda: "is-active" in (listen_btn.get_attribute("class") or ""),
            timeout_ms=15_000,
            description="auto-playback to start",
        )
    except PWTimeoutError:
        print("    (auto-playback didn't confirm within 15s - continuing anyway, not failing the recording)")
    pause(BEAT_PAUSE + 2)


# --------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------
def run(dry_run: bool, headed: bool) -> None:
    with sync_playwright() as p:
        launch_args = [
            "--use-fake-ui-for-media-stream",  # auto-grant mic permission, skip the dialog
            "--use-fake-device-for-media-stream",
            f"--use-file-for-fake-audio-capture={VOICE_CLIP}",
        ]
        browser = p.chromium.launch(headless=not headed, args=launch_args)

        context_kwargs = {"viewport": VIDEO_SIZE, "permissions": ["microphone"]}
        if not dry_run:
            OUT_DIR.mkdir(parents=True, exist_ok=True)
            context_kwargs["record_video_dir"] = str(OUT_DIR)
            context_kwargs["record_video_size"] = VIDEO_SIZE

        context = browser.new_context(**context_kwargs)
        context.set_default_timeout(DEFAULT_TIMEOUT_MS)
        page = context.new_page()

        beat_confirm_case(page)
        beat_typed_question(page, QUESTION_1, expand_p3_source=True, click_listen=True)
        beat_typed_question(page, QUESTION_2, expand_p3_source=False, click_listen=False)
        beat_manual_entry(page)
        beat_voice_question(page)

        video = page.video
        context.close()  # only now is the .webm finalized on disk
        browser.close()

    if not dry_run and video is not None:
        final_path = OUT_DIR / f"sanaku-demo-{time.strftime('%Y%m%d-%H%M%S')}.webm"
        shutil.move(video.path(), final_path)
        print(f"\n[record_demo] Saved: {final_path}")
        print("[record_demo] Reminder: this video has no audio track. See DEMO-VIDEO.internal.md to narrate over it.")
    elif dry_run:
        print("\n[record_demo] Dry run complete - no video was saved.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="run preflight + model warm-up only, no browser")
    parser.add_argument("--dry-run", action="store_true", help="run every beat for real, but save no video")
    parser.add_argument("--headed", action="store_true", help="show the browser window (use with --dry-run to watch a rehearsal)")
    args = parser.parse_args()

    preflight()
    warm_models()

    if args.check:
        return

    run(dry_run=args.dry_run, headed=args.headed)


if __name__ == "__main__":
    main()
