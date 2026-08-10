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
import json
import os
import subprocess
import sys

ALEXYA = os.environ.get("ALEXYA_URL", "http://127.0.0.1:8000")
BUCKET = "sanaku-marketing"


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=5,
                    help="max items per run; keeps an unattended run from "
                         "burning the whole Alexya balance on a backlog")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not SUPABASE_URL or not SERVICE_KEY:
        raise SystemExit("SUPABASE_URL / SUPABASE_SERVICE_KEY missing from ~/.sanaku.env")

    code, _ = curl("GET", f"{ALEXYA}/health", {}, timeout=10)
    if code != 200:
        # Not an error worth alarming about - the Mac is simply not serving
        # right now. The next run picks the work up untouched.
        print(f"[illustrate] Alexya not reachable at {ALEXYA} (HTTP {code}); nothing to do")
        return 0

    # Only items that ASKED for a picture and did not get one. 'posted' is
    # excluded: adding art to something already on LinkedIn helps nobody.
    rows = supa("GET",
                "content_queue"
                "?select=id,content_type,image_prompt,image_url,slides,bottleneck,created_at"
                "&image_url=is.null"
                "&image_prompt=not.is.null"
                "&status=in.(queued,approved)"
                f"&order=created_at.asc&limit={args.limit}")

    if not rows:
        print("[illustrate] nothing waiting for artwork")
        return 0
    print(f"[illustrate] {len(rows)} item(s) waiting")

    drawn = 0
    for r in rows:
        slug = f"{(r.get('created_at') or '')[:10]}_{(r.get('bottleneck') or 'sanaku').replace('_', '-')}"
        print(f"  {r['content_type']:10} {r['id'][:8]}  {r['image_prompt'][:70]}")
        if args.dry_run:
            continue

        code, payload = curl("POST", f"{ALEXYA}/generate-illustration",
                             {"Content-Type": "application/json"},
                             {"prompts": [r["image_prompt"]], "slug": slug,
                              "project": "sanaku", "bucket": BUCKET,
                              "aspect_ratio": "1:1", "mode": "fast"})
        if code != 200:
            print(f"      alexya HTTP {code}: {payload[:200]} - leaving for the next run")
            continue
        urls = [u for u in (json.loads(payload).get("image_urls") or []) if u]
        if not urls:
            print("      alexya returned no image - leaving for the next run")
            continue

        patch = {"image_url": urls[0]}
        # A carousel's cover is slide 1, so keep the two in step or the post
        # pack will name the same picture twice.
        if r["content_type"] == "carousel" and isinstance(r.get("slides"), list) and r["slides"]:
            slides = list(r["slides"])
            slides[0] = {**slides[0], "image_url": urls[0]}
            patch["slides"] = slides
        supa("PATCH", f"content_queue?id=eq.{r['id']}", patch)
        drawn += 1
        print(f"      -> {urls[0].rsplit('/', 1)[-1]}")

    print(f"[illustrate] done, {drawn} illustrated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
