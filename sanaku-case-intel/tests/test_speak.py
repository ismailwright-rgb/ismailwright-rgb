"""core/speak.py's PiperSynthesizer had no test coverage at all before
this - added after a real live bug (macOS's AirPlay Receiver silently
intercepting Piper's default port 5000, returning 403 for anything that
wasn't a real AirPlay request) motivated both moving the default port to
5001 and adding a specific, actionable hint for a 403 response
specifically, distinct from any other HTTP error status.
"""
from __future__ import annotations

import httpx
import pytest

from core.speak import PiperSynthesizer, PiperUnavailableError, SynthesisError


def test_synthesize_returns_audio_bytes_on_success():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/synthesize"
        return httpx.Response(200, content=b"fake-wav-bytes")

    client = httpx.Client(transport=httpx.MockTransport(handler), base_url="http://127.0.0.1:5001")
    synth = PiperSynthesizer(client=client)
    assert synth.synthesize("hello") == b"fake-wav-bytes"


def test_synthesize_raises_piper_unavailable_on_connect_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    client = httpx.Client(transport=httpx.MockTransport(handler), base_url="http://127.0.0.1:5001")
    synth = PiperSynthesizer(client=client)
    with pytest.raises(PiperUnavailableError) as exc_info:
        synth.synthesize("hello")
    assert "--port 5001" in str(exc_info.value)


def test_synthesize_403_includes_airplay_hint():
    # Real bug found live: macOS's AirPlay Receiver listens on port 5000
    # by default and answers with a plain 403 for anything that isn't a
    # real AirPlay request - looks exactly like "Piper is running and
    # refusing the request" unless the error message says otherwise.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, text="Forbidden")

    client = httpx.Client(transport=httpx.MockTransport(handler), base_url="http://127.0.0.1:5000")
    synth = PiperSynthesizer(client=client)
    with pytest.raises(SynthesisError) as exc_info:
        synth.synthesize("hello")
    assert "AirPlay" in str(exc_info.value)


def test_synthesize_non_403_error_has_no_airplay_hint():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="Internal Server Error")

    client = httpx.Client(transport=httpx.MockTransport(handler), base_url="http://127.0.0.1:5001")
    synth = PiperSynthesizer(client=client)
    with pytest.raises(SynthesisError) as exc_info:
        synth.synthesize("hello")
    assert "AirPlay" not in str(exc_info.value)
