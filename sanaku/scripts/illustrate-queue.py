#!/usr/bin/env python3
"""Fill in the artwork M1 could not draw.

Why this exists
---------------
M1 runs on the remote n8n droplet, because that is where the whole Sanaku stack
lives and it is always up. Alexya runs on Ismail's Mac, bound to 127.0.0.1:8000,
and there is no inbound route to it. So the generator's image step cannot reach
the illustrator - by design it fails soft and queues the item with its text
complete and `image_prompt` set but `image_url` empty.

This closes that gap from the other side. It runs ON the Mac, finds queued items
that wanted a picture and did not get one, draws them locally, and writes the
public URL back. The two halves never need to reach each other: the droplet
writes text on a schedule, the Mac fills in art whenever it happens to be awake.

That decoupling is the point. A tunnel would have worked too, until the Mac
slept or the free ngrok URL rotated, and then the failure would be a stale
ALEXYA_URL that silently 502s every morning.

Safe to run repeatedly and safe to run concurrently with M1 - it only ever
touches rows that already exist and already lack an image.

Usage:
    python3 illustrate-queue.py [--limit N] [--dry-run]

Reads SUPABASE_URL / SUPABASE_SERVICE_KEY from ~/.sanaku.env.
"""
import argparse
import fcntl
import json
import os
import subprocess
import sys

ALEXYA = os.environ.get("ALEXYA_URL", "http://127.0.0.1:8000")
BUCKET = "sanaku-marketing"

# Cycle the look. Eight identical flat-vector scenes in a row stop being seen by
# the third, and the picture is most of what stops a thumb - so consecutive
# items get visibly different treatments.
#
# The order is deliberate rather than alphabetical: neighbours in this list are
# as unlike each other as possible, because the cycle is what the feed shows in
# sequence. Names must exist in the server's /styles palette.
STYLE_CYCLE = [
    "flat_vector",   # crisp, graphic
    "clay",          # tactile, warm, sculpted
    "mural",         # bold, painted, large-scale
    "pastel",        # soft, quiet, chalky
    "risograph",     # inky, printed, grainy
    "isometric",     # precise, technical
    "papercut",      # layered, crafted
    "linocut",       # carved, high-contrast
]


def style_for(row):
    """Pick this item's look, stably.

    Keyed off the row id so a retry redraws in the SAME style rather than
    quietly changing the look of a draft between runs, and so the three drafts
    of one morning almost always differ from each other.
    """
    h = 0
    for ch in str(row.get("id", "")):
        h = (h * 31 + ord(ch)) % 1000003
    return STYLE_CYCLE[h % len(STYLE_CYCLE)]


def sanaku_env(name):
    """Read one value from ~/.sanaku.env, the project's single credential store."""
    if os.environ.get(name):
        return os.environ[name]
    try:
        with open(os.path.expanduser("~/.sanaku.env")) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() == name:
                    return v.strip().strip("'\"")
    except OSError:
        pass
    return ""


SUPABASE_URL = sanaku_env("SUPABASE_URL").rstrip("/")
SERVICE_KEY = sanaku_env("SUPABASE_SERVICE_KEY")


def curl(method, url, headers, body=None, timeout=900):
    """HTTP via curl.

    Not urllib: a python.org Python on macOS has no CA bundle until someone runs
    'Install Certificates.command', and this script's whole job is to run
    unattended under launchd where that failure would be invisible.
    """
    cmd = ["curl", "-sS", "-X", method, url, "-w", "\n%{http_code}"]
    for k, v in headers.items():
        cmd += ["-H", f"{k}: {v}"]
    tmp = None
    if body is not None:
        import tempfile
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(body, tmp)
        tmp.close()
        cmd += ["--data-binary", "@" + tmp.name]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    finally:
        if tmp:
            os.unlink(tmp.name)
    payload, _, code = out.rpartition("\n")
    return (int(code) if code.isdigit() else 0), payload


def supa(method, path, body=None):
    code, payload = curl(method, f"{SUPABASE_URL}/rest/v1/{path}", {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }, body, timeout=60)
    if code >= 300:
        raise SystemExit(f"Supabase {method} {path} -> HTTP {code}: {payload[:300]}")
    return json.loads(payload or "[]")


def draw(prompts, slug, aspect, style_name):
    """One Alexya call. Returns the (possibly sparse) list of public URLs."""
    code, payload = curl("POST", f"{ALEXYA}/generate-illustration",
                         {"Content-Type": "application/json"},
                         {"prompts": prompts, "slug": slug, "project": "sanaku",
                          "bucket": BUCKET, "aspect_ratio": aspect, "mode": "fast",
                          "style_name": style_name})
    if code != 200:
        print(f"      alexya HTTP {code}: {payload[:180]} - leaving for the next run")
        return []
    return json.loads(payload).get("image_urls") or []


def hero_pass(limit):
    """A cover image for EVERY draft, approved or not.

    This is deliberately not gated on approval. Three drafts land each morning
    and the picture is a large part of how you tell which one is worth posting -
    choosing between three blocks of text with the artwork arriving only after
    you have already decided is backwards.

    It is affordable: ~31 credits an image, three drafts a day, about 2,790 a
    month against a balance near 27,000 - roughly ten months of runway. The
    expensive half (a full carousel, 5-8 images) is what waits for approval,
    in slide_pass below.
    """
    rows = supa("GET",
                "content_queue"
                "?select=id,content_type,image_prompt,image_url,slides,bottleneck,created_at,status"
                "&image_url=is.null"
                "&image_prompt=not.is.null"
                "&status=in.(queued,approved)"
                f"&order=created_at.asc&limit={limit}")
    if not rows:
        return 0
    print(f"[illustrate] {len(rows)} draft(s) need a cover image")
    drawn = 0
    for r in rows:
        slug = f"{(r.get('created_at') or '')[:10]}_{(r.get('bottleneck') or 'sanaku').replace('_', '-')}"
        style = style_for(r)
        print(f"  cover  {r['content_type']:10} {r['id'][:8]}  [{style}]  {r['image_prompt'][:52]}")
        urls = draw([r["image_prompt"]], slug, "1:1", style)
        first = next((u for u in urls if u), None)
        if not first:
            continue
        patch = {"image_url": first}
        # A carousel's cover IS slide 1, so keep the two in step - otherwise the
        # post pack ships the same picture twice under two names.
        slides = r.get("slides") if isinstance(r.get("slides"), list) else []
        if r["content_type"] == "carousel" and slides:
            patch["slides"] = [{**slides[0], "image_url": first}] + slides[1:]
        supa("PATCH", f"content_queue?id=eq.{r['id']}", patch)
        drawn += 1
        print(f"      -> {first.rsplit('/', 1)[-1]}")
    return drawn


def slide_pass(limit):
    """Full per-slide artwork, APPROVED carousels only.

    A seven-slide deck is ~217 credits. Drawing that for every draft carousel
    would be roughly two thirds of the balance spent on decks deleted the same
    day, so this half genuinely does wait until you have picked one.
    """
    rows = supa("GET",
                "content_queue"
                "?select=id,content_type,slides,bottleneck,created_at"
                "&content_type=eq.carousel"
                "&status=eq.approved"
                f"&order=created_at.asc&limit={limit}")
    todo = []
    for r in rows:
        slides = r.get("slides") if isinstance(r.get("slides"), list) else []
        # Slide 1 already has the cover; anything after it that has a scene and
        # no image is outstanding work.
        if any(s.get("scene") and not s.get("image_url") for s in slides[1:]):
            todo.append((r, slides))
    if not todo:
        return 0
    print(f"[illustrate] {len(todo)} approved carousel(s) need slide art")
    drawn = 0
    for r, slides in todo:
        slug = f"{(r.get('created_at') or '')[:10]}_{(r.get('bottleneck') or 'sanaku').replace('_', '-')}_slides"
        # Index-aligned with the slides, so a failed scene leaves a gap rather
        # than shifting every later slide's picture by one.
        prompts = [s.get("scene") or "" for s in slides]
        # One style for the whole deck - a carousel that changes look between
        # slides reads as a mistake, not as variety.
        style = style_for(r)
        print(f"  slides {r['id'][:8]}  [{style}]  {len(prompts)} scenes")
        urls = draw(prompts, slug, "4:5", style)
        if not any(urls):
            continue
        merged = []
        for i, s in enumerate(slides):
            u = urls[i] if i < len(urls) else None
            merged.append({**s, "image_url": u} if u else s)
        # Slide 1 stays the cover the item already advertises.
        if slides and slides[0].get("image_url"):
            merged[0] = slides[0]
        supa("PATCH", f"content_queue?id=eq.{r['id']}", {"slides": merged})
        drawn += 1
        print(f"      -> {sum(1 for u in urls if u)} slide image(s)")
    return drawn


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=4,
                    help="max drafts to give a cover image per run")
    ap.add_argument("--carousels", type=int, default=1,
                    help="max approved carousels to fully illustrate per run; "
                         "one deck is 5-8 images, so this is the expensive knob")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not SUPABASE_URL or not SERVICE_KEY:
        raise SystemExit("SUPABASE_URL / SUPABASE_SERVICE_KEY missing from ~/.sanaku.env")

    # Single instance only.
    #
    # The launchd agent fires every 20 minutes and a carousel can take longer
    # than that, so two copies WILL overlap eventually - and running this by
    # hand while the agent is mid-run does it immediately. Alexya serialises
    # batches with a lockfile of its own and simply 500s the loser
    # ("batch_already_running"), which burns the run and reads like an Alexya
    # fault rather than our own concurrency. Losing the race here is silent and
    # correct instead: the work is still queued for the next pass.
    lock_path = "/tmp/sanaku-illustrator.lock"
    lock = open(lock_path, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("[illustrate] another run is already working; leaving it to finish")
        return 0
    lock.write(str(os.getpid()))
    lock.flush()

    code, _ = curl("GET", f"{ALEXYA}/health", {}, timeout=10)
    if code != 200:
        # Not worth alarming about - the Mac is simply not serving right now.
        # The next run picks the work up untouched.
        print(f"[illustrate] Alexya not reachable at {ALEXYA} (HTTP {code}); nothing to do")
        return 0

    if args.dry_run:
        pending = supa("GET", "content_queue?select=id,content_type,status,image_prompt"
                              "&image_url=is.null&image_prompt=not.is.null"
                              "&status=in.(queued,approved)&limit=20")
        print(f"[illustrate] {len(pending)} draft(s) would get a cover image")
        for r in pending:
            print(f"  {r['content_type']:10} {r['status']:8} {r['id'][:8]}")
        return 0

    total = hero_pass(args.limit) + slide_pass(args.carousels)
    print(f"[illustrate] done, {total} item(s) illustrated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
