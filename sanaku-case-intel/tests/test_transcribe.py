"""core/transcribe.py's WhisperTranscriber.transcribe() had no error
handling at all around the real faster-whisper call - a real bug found
live: any failure decoding/transcribing a clip propagated as a bare,
uncaught exception, which api/main.py's `except TranscriptionError`
clause can't catch (it isn't one), producing an unhandled 500 with a
plain-text body - the frontend's defensive `.json().catch(() => ({}))`
then falls back to its own generic "Could not transcribe that." message,
hiding what actually went wrong. These tests don't need faster-whisper
installed (it's optional, requirements-voice.txt, not in this sandbox) -
they bypass _ensure_loaded() by setting a fake `_model` directly, since
_ensure_loaded() only calls the real import when self._model is still
None.
"""
from __future__ import annotations

from core.transcribe import TranscriptionError, WhisperTranscriber


class _FakeModel:
    def __init__(self, exc: Exception):
        self._exc = exc

    def transcribe(self, *args, **kwargs):
        raise self._exc


class _Segment:
    def __init__(self, text: str):
        self.text = text


class _FakeWorkingModel:
    def transcribe(self, *args, **kwargs):
        return [_Segment(" hello "), _Segment("world ")], {}


def test_transcribe_wraps_a_decode_failure_as_transcription_error():
    transcriber = WhisperTranscriber()
    transcriber._model = _FakeModel(RuntimeError("could not decode audio"))
    try:
        transcriber.transcribe(b"not really audio")
        assert False, "expected TranscriptionError"
    except TranscriptionError as e:
        assert "could not decode audio" in str(e)
        assert "clip" in str(e)


def test_transcribe_joins_segments_on_success():
    transcriber = WhisperTranscriber()
    transcriber._model = _FakeWorkingModel()
    assert transcriber.transcribe(b"some audio") == "hello world"
