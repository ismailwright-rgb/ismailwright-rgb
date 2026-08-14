import { useEffect, useMemo, useRef, useState } from 'react';

// This file is the entire client-facing surface. Per the project's white-
// label guardrail: no vendor name, no model name, no mention of retrieval/
// embeddings/"AI" architecture anywhere in the strings below - an attorney
// using this should see a case-research tool, not a peek at how it works.

const DEFAULT_COLORS = { primary: '#0B3D2E', secondary: '#C9A24B', accent: '#F4F1EA' };

function applyTheme(colors) {
  const root = document.documentElement.style;
  root.setProperty('--color-primary', colors.primary);
  root.setProperty('--color-secondary', colors.secondary);
  root.setProperty('--color-accent', colors.accent);
}

/** First 1-2 initials of the firm name, for the header monogram shown
 * when no logo is configured or the logo fails to load - purely derived
 * from firm_name, which /theme already returns, so this needs no new
 * config field. */
function initials(name) {
  return (name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

/** Small inline icons - not emoji, to match the rest of this app's
 * restrained visual language, and not an icon library (no new
 * dependency for two shapes). currentColor so they inherit whatever
 * button state they're drawn in. */
function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor" />
      <path d="M5 11a7 7 0 0 0 14 0" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
      <line x1="12" y1="18" x2="12" y2="22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" />
    </svg>
  );
}

// Title abbreviations espeak-ng (Piper's phonemizer) doesn't reliably
// expand on its own - confirmed live, "Ms." was read as the letters
// "M S" instead of "Miss". Spelled out fully rather than left as an
// abbreviation so this doesn't depend on the phonemizer's own guesswork.
const TITLE_EXPANSIONS = { Ms: 'Miss', Mrs: 'Missus', Mr: 'Mister', Dr: 'Doctor' };

function expandTitlesForSpeech(text) {
  return text.replace(/\b(Ms|Mrs|Mr|Dr)\.?(?=\s)/g, (_match, title) => TITLE_EXPANSIONS[title]);
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Case documents' own dates (event_date, and dates quoted verbatim from
// passage text the model reproduces in its answer) are ISO YYYY-MM-DD -
// correct to write, but not a shape espeak-ng recognizes as a date, so it
// read the literal digits and dashes instead of a spoken date. Converts
// to "Month D, YYYY" and lets the TTS engine's own (reliable) handling of
// that conventional written form read the day as an ordinal.
function expandIsoDatesForSpeech(text) {
  return text.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (match, year, month, day) => {
    const monthIdx = parseInt(month, 10) - 1;
    const dayNum = parseInt(day, 10);
    if (monthIdx < 0 || monthIdx > 11 || dayNum < 1 || dayNum > 31) return match;
    return `${MONTH_NAMES[monthIdx]} ${dayNum}, ${year}`;
  });
}

/** Prepares answer text for /speak: strips citation brackets and bullet
 * markers (same reasons as before - a voice shouldn't read "bracket doc
 * pdf comma p dot 3 bracket" or "asterisk" aloud), expands title
 * abbreviations and ISO dates into how they're actually meant to sound,
 * and splits the text into the same blocks/points AnswerBody renders as
 * separate paragraphs or list items, guaranteeing each one ends with
 * terminal punctuation before rejoining them. Without that, points that
 * already lack a trailing period (the answer contract doesn't require
 * one) blur together into what sounds like one run-on sentence once
 * newlines stop meaning anything to the TTS engine - a period is the one
 * thing every speech synthesizer reliably treats as a pause boundary. */
function stripCitationsForSpeech(text) {
  const blocks = text.trim().split(/\n\s*\n/);
  const sentences = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const isList = lines.length > 0 && lines.every((l) => /^[*-]\s+/.test(l));
    const points = isList ? lines.map((l) => l.replace(/^[*-]\s+/, '')) : [lines.join(' ')];
    for (const rawPoint of points) {
      let point = rawPoint.replace(/\[[^\]]+\]/g, '').replace(/[ \t]{2,}/g, ' ').trim();
      point = expandIsoDatesForSpeech(expandTitlesForSpeech(point));
      if (!point) continue;
      if (/[.!?]$/.test(point)) {
        sentences.push(point);
      } else if (point.endsWith(':')) {
        // A trailing colon ("Supporting points:") reads oddly with a
        // period appended after it - swap it for one instead.
        sentences.push(`${point.slice(0, -1)}.`);
      } else {
        sentences.push(`${point}.`);
      }
    }
  }
  return sentences.join(' ');
}

// --- Hands-free wake-phrase listening mode -------------------------------
//
// Reuses the same local /transcribe pipeline the mic button already uses
// (core/transcribe.py's Whisper model) via short rolling audio chunks,
// rather than a dedicated wake-word engine - the real one considered
// (openwakeword) only ships pretrained single-*word* detectors; a custom
// 5-word phrase needs training a model, which pulls in a much bigger
// dependency footprint (torch/speechbrain/audiomentations) than anything
// else optional in this project. This needs zero new dependencies and
// zero backend changes - phrase matching is pure client-side string logic
// over text /transcribe already returns.
const WAKE_PHRASE = "let's do a case review";
const WAKE_PHRASE_WORD_COUNT = WAKE_PHRASE.split(' ').length;
const LISTEN_CHUNK_MS = 4000;
const LISTEN_PAUSE_RETRY_MS = 500;
// 10 minutes, reset only when a chunk actually matches the wake phrase -
// deliberately not reset by ordinary background speech. Resetting on any
// detected speech would let an unrelated client-meeting conversation keep
// hands-free armed indefinitely, exactly what this toggle-plus-expiry
// design exists to prevent.
const LISTEN_INACTIVITY_MS = 10 * 60 * 1000;
// RMS threshold (0-1 scale) a chunk's peak amplitude must clear before
// it's ever sent to /transcribe - keeps a quiet room from costing a
// Whisper call every LISTEN_CHUNK_MS regardless of activity. Deliberately
// conservative (low): missing real speech here just means repeating the
// phrase, the same recoverable failure the manual mic button already has,
// whereas a threshold set too high risks never activating at all. This is
// a starting point, not a tuned value - real rooms/microphones vary, and
// tuning it needs a real Mac (see README.internal.md's Voice section).
const LISTEN_ENERGY_THRESHOLD = 0.02;
// Normalized Levenshtein ratio (edit distance / longer string's length)
// a candidate window must be at or under to count as the wake phrase -
// tolerates "let's" vs "lets", one misheard word, etc. without requiring
// an exact match. Known tradeoff, not fully closed: at this ratio a
// single wrong word inside the 5-word phrase can still pass (e.g. "let's
// do a quick review" scores ~0.22, under threshold) - tightening the
// ratio would close that gap but risks missing genuine mishears of the
// real phrase instead. Which side of that tradeoff is actually right is
// exactly the real false-positive-rate question flagged as real-Mac-only
// in README.internal.md's Voice section - this is a starting point.
const LISTEN_MATCH_MAX_RATIO = 0.25;

function normalizeForMatch(text) {
  return text.toLowerCase().replace(/[^a-z0-9'\s]/g, '').replace(/\s+/g, ' ').trim();
}

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** True if some contiguous word-window of `transcript` is close enough to
 * WAKE_PHRASE to count as a match. A sliding window over word count
 * rather than comparing the whole transcript, since a 4-second chunk can
 * contain speech before or after the phrase itself ("okay, let's do a
 * case review" or "let's do a case review, please"). Window sizes span
 * the phrase's own word count plus/minus one, tolerating a dropped or
 * extra word without needing an exact length match. */
function matchesWakePhrase(transcript) {
  const normalizedPhrase = normalizeForMatch(WAKE_PHRASE);
  const words = normalizeForMatch(transcript).split(' ').filter(Boolean);
  if (words.length === 0) return false;
  const minSize = Math.max(1, WAKE_PHRASE_WORD_COUNT - 1);
  const maxSize = WAKE_PHRASE_WORD_COUNT + 1;
  for (let size = minSize; size <= maxSize; size++) {
    for (let start = 0; start + size <= words.length; start++) {
      const window = words.slice(start, start + size).join(' ');
      const distance = levenshteinDistance(window, normalizedPhrase);
      const ratio = distance / Math.max(window.length, normalizedPhrase.length, 1);
      if (ratio <= LISTEN_MATCH_MAX_RATIO) return true;
    }
  }
  return false;
}

/** Root-mean-square of a Web Audio AnalyserNode's time-domain byte data
 * (centered on 128, the analyser's silence baseline) - a cheap proxy for
 * "how loud was this instant," used to gate chunks before they're ever
 * transcribed. */
function computeRms(byteData) {
  let sumSquares = 0;
  for (let i = 0; i < byteData.length; i++) {
    const centered = (byteData[i] - 128) / 128;
    sumSquares += centered * centered;
  }
  return Math.sqrt(sumSquares / byteData.length);
}

// --- Auto-stop a question recording once you've gone quiet -------------
//
// Originally both the manual mic button and hands-free mode required an
// explicit click/second wake-phrase-style action to stop recording and
// start transcribing - real friction against the "talk to it like Siri
// or Alexa" experience this is supposed to be. This makes startRecording
// itself listen for a pause and stop on its own, the same energy-sampling
// approach LISTEN_ENERGY_THRESHOLD already uses for wake-phrase chunk
// gating, just pointed at a live recording instead of a background
// chunk. A manual click still works as an override (stop early, or if
// the room is too noisy for energy-based detection to behave well) -
// this doesn't remove that path, it just means most of the time you
// won't need it.
const AUTO_STOP_SILENCE_MS = 1300;
const AUTO_STOP_MAX_MS = 60000; // safety cap - never leaves the mic open indefinitely
const AUTO_STOP_POLL_MS = 150;
const AUTO_STOP_ENERGY_THRESHOLD = 0.02;

/** Pure decision logic for "has this recording gone quiet long enough to
 * auto-stop" - deliberately decoupled from the Web Audio wiring below so
 * it's unit-testable without a browser, the same reason matchesWakePhrase
 * is a standalone function rather than inlined into its caller. Call
 * shouldStop(rms, now) once per energy sample (now is a real timestamp,
 * injected rather than read internally, so this is fully testable with
 * synthetic values); it tracks whether real speech has happened yet - a
 * recording that hasn't been spoken into at all shouldn't immediately
 * auto-stop just because it opened in silence - and returns true the
 * instant either AUTO_STOP_SILENCE_MS of continuous quiet follows real
 * speech, or AUTO_STOP_MAX_MS has elapsed regardless, as a safety cap. */
function createSilenceStopDetector({
  silenceMs = AUTO_STOP_SILENCE_MS,
  maxMs = AUTO_STOP_MAX_MS,
  threshold = AUTO_STOP_ENERGY_THRESHOLD,
} = {}) {
  let hasSpoken = false;
  let lastLoudAt = null;
  let startedAt = null;
  return function shouldStop(rms, now) {
    if (startedAt === null) startedAt = now;
    if (lastLoudAt === null) lastLoudAt = now;
    if (rms >= threshold) {
      hasSpoken = true;
      lastLoudAt = now;
    }
    if (hasSpoken && now - lastLoudAt >= silenceMs) return true;
    if (now - startedAt >= maxMs) return true;
    return false;
  };
}

/** Wires createSilenceStopDetector up to a live MediaStream via a Web
 * Audio AnalyserNode, polling every AUTO_STOP_POLL_MS and calling
 * onSilenceDetected() the instant the detector says stop. Returns a
 * cleanup function - callers must invoke it once (whatever stopped the
 * recording, auto-detection or a manual click) so the polling interval
 * and AudioContext don't leak. */
function armAutoStopOnSilence(stream, onSilenceDetected) {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume().catch(() => {});
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const sampleData = new Uint8Array(analyser.fftSize);
  const shouldStop = createSilenceStopDetector();

  const intervalId = setInterval(() => {
    analyser.getByteTimeDomainData(sampleData);
    const rms = computeRms(sampleData);
    if (shouldStop(rms, Date.now())) onSilenceDetected();
  }, AUTO_STOP_POLL_MS);

  return () => {
    clearInterval(intervalId);
    audioCtx.close().catch(() => {});
  };
}

/** Very small formatter for the answer text: blocks separated by a blank
 * line become paragraphs, or a bulleted list if every line in the block
 * starts with "* " or "- " - matches the shape the answer contract asks
 * the model to produce (thesis paragraph, then a bulleted list of
 * supporting points). No markdown library - the shape is simple and
 * fixed enough not to need one. */
function AnswerBody({ text }) {
  // Genuinely empty for a brief instant while a streamed turn's sources
  // have arrived but its first delta hasn't yet - nothing to render, not
  // an empty paragraph.
  if (!text.trim()) return null;
  const blocks = text.trim().split(/\n\s*\n/);
  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
        const isList = lines.length > 0 && lines.every((l) => /^[*-]\s+/.test(l));
        if (isList) {
          return (
            <ul key={i} className="answer-list">
              {lines.map((l, j) => (
                <li key={j}>{l.replace(/^[*-]\s+/, '')}</li>
              ))}
            </ul>
          );
        }
        return <p key={i}>{block}</p>;
      })}
    </>
  );
}

function SourceCard({ source, index, forceOpen }) {
  const [open, setOpen] = useState(false);
  // forceOpen drives the print view: every source's full text needs to be
  // on the page when printed, regardless of which cards the user happened
  // to have expanded on screen.
  const isOpen = open || forceOpen;
  const badges = [];
  if (source.human_entered) badges.push('Human-entered note');
  if (source.date_confidence === 'approximate') badges.push('Approximate date');
  if (source.date_confidence === 'undated') badges.push('Undated');

  return (
    <li className="source-card">
      <button className="source-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={isOpen}>
        <span className="source-num">{index + 1}</span>
        <span className="source-meta">
          <span className="source-doc">{source.doc_name}</span>
          <span className="source-page">p.{source.page}</span>
        </span>
        <span className="source-chevron">{isOpen ? '−' : '+'}</span>
      </button>
      {badges.length > 0 && (
        <div className="source-badges">
          {badges.map((b) => (
            <span key={b} className="badge">{b}</span>
          ))}
        </div>
      )}
      {isOpen && <p className="source-text">{source.text}</p>}
    </li>
  );
}

export default function App() {
  const [theme, setTheme] = useState(null);
  // Light (default) or dark - a real, persisted preference, not the
  // earlier three-way comparison scaffolding. Dark mode is the "modern
  // dark professional" direction that came out of comparing two real
  // mockups against actual case content (see web/src/index.css's
  // [data-look='dark'] block) - restrained on purpose (no glow/neon),
  // chosen as the safer register for something attorneys need to trust.
  const [darkMode, setDarkMode] = useState(() => {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem('sanaku-dark-mode') === 'true';
  });
  const [logoFailed, setLogoFailed] = useState(false);
  const [cases, setCases] = useState([]);
  const [caseId, setCaseId] = useState('');
  const [question, setQuestion] = useState('');
  // A conversation thread, not a single replaced answer: each entry is
  // {id, question, data: {answer, sources}}. Sent back to /ask as
  // {question, answer} pairs so follow-ups ("what about her prior
  // injuries?") resolve context from earlier in the session - see
  // core/retrieve.py's build_retrieval_query and the answer contract's
  // Rule 5 for how that stays honest about citations.
  const [turns, setTurns] = useState([]);
  const [pendingQuestion, setPendingQuestion] = useState(null);
  // `loading` covers only the retrieval wait (before sources exist to
  // show anything); `streamingTurnId` covers the answer actually
  // streaming in afterward - see handleAsk for why these are kept apart.
  const [loading, setLoading] = useState(false);
  const [streamingTurnId, setStreamingTurnId] = useState(null);
  const [error, setError] = useState(null);
  const [printExpand, setPrintExpand] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [speakingId, setSpeakingId] = useState(null);
  const [synthesizingId, setSynthesizingId] = useState(null);
  // The toggle's source of truth for hands-free wake-phrase listening -
  // off by default (an explicit choice, not always-on), see the
  // WAKE_PHRASE block above for the full design reasoning.
  const [listeningMode, setListeningMode] = useState(false);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioRef = useRef(null);
  // Lets handleNewConversation actually stop an in-flight /ask/stream
  // read rather than leaving it running to completion in the background
  // against a turns array that's already been cleared.
  const streamAbortRef = useRef(null);
  // recordingRef/transcribingRef mirror the `recording`/`transcribing`
  // state but update synchronously (not on React's next render) - the
  // hands-free loop is a plain async function outside React's render
  // cycle and needs an up-to-the-instant answer to "is a manual
  // recording in progress right now," not a possibly-stale closure over
  // state from whenever the loop function was created.
  const recordingRef = useRef(false);
  const transcribingRef = useRef(false);
  // The persistent microphone stream + energy analyser used while
  // listeningMode is armed, and a "generation" counter that invalidates
  // any in-flight chunk-loop iterations the instant the toggle flips off
  // (or back on) - simpler than threading an AbortController through a
  // recursive setTimeout chain.
  const listeningStreamRef = useRef(null);
  const listeningAnalyserRef = useRef(null);
  const listeningGenerationRef = useRef(0);
  const listeningInactivityTimerRef = useRef(null);
  // Cleanup for the current question recording's auto-stop-on-silence
  // monitor (see armAutoStopOnSilence) - set at the start of every
  // startRecording() call, invoked and cleared the instant that
  // recording actually stops, whatever stopped it.
  const autoStopCleanupRef = useRef(null);

  const micSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  useEffect(() => {
    if (darkMode) {
      document.documentElement.dataset.look = 'dark';
    } else {
      delete document.documentElement.dataset.look;
    }
    try {
      localStorage.setItem('sanaku-dark-mode', String(darkMode));
    } catch {
      // Private-browsing/storage-disabled contexts - the preference just
      // won't persist across a reload, not worth surfacing as an error.
    }
  }, [darkMode]);

  // Printing needs every source card expanded first (so the printed page
  // has the full passage text, not just collapsed toggles) - flip every
  // card open via printExpand, wait for that re-render, then invoke the
  // browser's print dialog. 'afterprint' fires whether the user printed or
  // cancelled, so it's the right place to collapse everything back.
  useEffect(() => {
    if (!printExpand) return undefined;
    const raf = requestAnimationFrame(() => window.print());
    const collapse = () => setPrintExpand(false);
    window.addEventListener('afterprint', collapse);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('afterprint', collapse);
    };
  }, [printExpand]);

  useEffect(() => {
    fetch('/theme')
      .then((r) => r.json())
      .then((t) => {
        setTheme(t);
        applyTheme(t.colors || DEFAULT_COLORS);
        document.title = t.firm_name || 'Case Intelligence';
        const descEl = document.querySelector('meta[name="description"]');
        if (descEl) descEl.setAttribute('content', `Case research for ${t.firm_name || 'this firm'}.`);
      })
      .catch(() => applyTheme(DEFAULT_COLORS));

    fetch('/cases')
      .then((r) => r.json())
      .then((d) => {
        const list = d.cases || [];
        setCases(list);
        if (list.length === 1) setCaseId(list[0]);
      })
      .catch(() => {});
  }, []);

  // ⌘⇧M (⌃⇧M off Mac) toggles the mic exactly like clicking its button -
  // a modifier combo specifically so it's safe to leave active regardless
  // of focus, including while typing in the question box, without a
  // special case for text-entry contexts. Left active globally rather
  // than gated to "not in a text field" the way a bare key like spacebar
  // would need to be.
  useEffect(() => {
    if (!micSupported) return undefined;
    function handleKeydown(e) {
      const isMicShortcut = (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'm';
      if (!isMicShortcut) return;
      e.preventDefault();
      handleMicClick();
    }
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [micSupported, handleMicClick]);

  // Non-null while a turn's answer is actively streaming in - a distinct
  // state from `loading` (which now only covers the retrieval wait,
  // before sources exist to show). Ask/mic stay disabled across both:
  // asking again mid-stream would mean sending an incomplete answer as
  // this turn's own history to the next question.
  const canAsk = useMemo(
    () => caseId.trim() && question.trim() && !loading && !streamingTurnId,
    [caseId, question, loading, streamingTurnId],
  );

  // POST /ask/stream, not /ask: the answer streams in as Ollama produces
  // it instead of arriving all at once - see api/main.py's own docstring
  // on that route for why (waiting for an entire non-streamed completion
  // to land before showing anything reads as "did this hang?", not "this
  // is working"). Sources arrive as the stream's first line (retrieval is
  // the fast part) and populate the source panel immediately, well before
  // the answer's first word exists.
  async function handleAsk(e) {
    e.preventDefault();
    if (!canAsk) return;
    audioRef.current?.pause();
    setSpeakingId(null);
    const askedQuestion = question.trim();
    const historyPayload = turns.map((t) => ({ question: t.question, answer: t.data.answer }));
    setLoading(true);
    setPendingQuestion(askedQuestion);
    setError(null);
    setQuestion('');

    const turnId = crypto.randomUUID();
    let turnStarted = false;
    const abortController = new AbortController();
    streamAbortRef.current = abortController;

    try {
      const r = await fetch('/ask/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ case_id: caseId.trim(), question: askedQuestion, history: historyPayload }),
        signal: abortController.signal,
      });
      if (!r.ok || !r.body) {
        // A non-JSON error body (a proxy error page, anything
        // unanticipated before the stream even starts) shouldn't crash
        // with a raw parse error - fall back to the generic message.
        const data = await r.json().catch(() => ({}));
        throw new Error(data.detail || 'Something went wrong.');
      }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const handleLine = (line) => {
        if (!line.trim()) return;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return; // an unparsable line isn't worth aborting the whole stream over
        }
        if (event.type === 'sources') {
          turnStarted = true;
          setLoading(false);
          setPendingQuestion(null);
          setStreamingTurnId(turnId);
          setTurns((prev) => [
            ...prev,
            { id: turnId, question: askedQuestion, data: { answer: '', sources: event.sources, streaming: true } },
          ]);
        } else if (event.type === 'delta') {
          setTurns((prev) =>
            prev.map((t) => (t.id === turnId ? { ...t, data: { ...t.data, answer: t.data.answer + event.text } } : t)),
          );
        } else if (event.type === 'done') {
          setTurns((prev) =>
            prev.map((t) => (t.id === turnId ? { ...t, data: { ...t.data, answer: event.answer, streaming: false } } : t)),
          );
          setStreamingTurnId(null);
        } else if (event.type === 'error') {
          throw new Error(event.detail || 'Something went wrong.');
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // last element may be a partial line - carried to the next read
        for (const line of lines) handleLine(line);
      }
      if (buffer.trim()) handleLine(buffer);
    } catch (err) {
      // A deliberate abort (handleNewConversation, see streamAbortRef)
      // isn't a failure worth an error banner - the user already moved
      // on, that's the whole point of cancelling.
      if (err.name !== 'AbortError') setError(err.message);
      if (turnStarted) {
        // Sources had already rendered a turn before the failure - drop
        // the partial turn rather than leaving a card stuck forever on
        // "still generating" with no way to finish.
        setTurns((prev) => prev.filter((t) => t.id !== turnId));
      }
      setStreamingTurnId(null);
    } finally {
      setLoading(false);
      setPendingQuestion(null);
      if (streamAbortRef.current === abortController) streamAbortRef.current = null;
    }
  }

  // Ends the current line of questioning on purpose - without this,
  // every later question keeps dragging the whole prior thread into
  // retrieval-query-folding and prompt history forever, which is wrong
  // the moment someone genuinely moves to an unrelated question.
  function handleNewConversation() {
    audioRef.current?.pause();
    setSpeakingId(null);
    setSynthesizingId(null);
    // Actually stop an in-flight /ask/stream read, rather than leaving
    // it running to completion in the background against a turns array
    // that's about to be cleared.
    streamAbortRef.current?.abort();
    setStreamingTurnId(null);
    setTurns([]);
    setQuestion('');
    setError(null);
  }

  // Starts a real question-recording session - click-to-start, click-
  // again-to-stop, transcribed entirely via this project's own
  // /transcribe endpoint (a local model, see core/transcribe.py), never
  // the browser's built-in speech recognition, which on Chrome typically
  // sends audio to Google's servers. Extracted out of handleMicClick so
  // the hands-free wake-phrase loop below can call the exact same
  // function the mic button does - one recording path, not two. The
  // transcribed text fills the question box; it does not submit on its
  // own - a misheard word silently becoming the actual question is the
  // wrong failure mode for legal software, and that stays true whether
  // the recording was started by hand or by voice.
  async function startRecording() {
    if (recordingRef.current || transcribingRef.current) return;
    recordingRef.current = true;
    setError(null);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      recordingRef.current = false;
      setError('Microphone access was blocked or unavailable.');
      return;
    }

    const recorder = new MediaRecorder(stream);
    audioChunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
      // Whatever stopped this recording - the silence monitor below, the
      // AUTO_STOP_MAX_MS safety cap, or a manual click - tear the monitor
      // down here, the one place every stop path actually converges.
      autoStopCleanupRef.current?.();
      autoStopCleanupRef.current = null;
      stream.getTracks().forEach((t) => t.stop());
      recordingRef.current = false;
      setRecording(false);
      transcribingRef.current = true;
      setTranscribing(true);
      try {
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        const form = new FormData();
        form.append('audio', blob, 'clip.webm');
        const r = await fetch('/transcribe', { method: 'POST', body: form });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.detail || 'Could not transcribe that.');
        setQuestion(data.text || '');
      } catch (err) {
        setError(err.message);
      } finally {
        transcribingRef.current = false;
        setTranscribing(false);
      }
    };

    mediaRecorderRef.current = recorder;
    recorder.start();
    setRecording(true);
    // Talk-then-pause, like Siri/Alexa, rather than requiring a second
    // click to say "I'm done" - stops itself once you've gone quiet.
    // Clicking the mic button again (handleMicClick's existing toggle)
    // still works as a manual override in the meantime.
    autoStopCleanupRef.current = armAutoStopOnSilence(stream, () => {
      if (recorder.state !== 'inactive') recorder.stop();
    });
  }

  async function handleMicClick() {
    if (transcribingRef.current) return;
    if (recordingRef.current) {
      mediaRecorderRef.current?.stop();
      return;
    }
    await startRecording();
  }

  // Restarts (or, on first arm, starts) the 10-minute hands-free
  // inactivity window. `generation` is captured at call time so a timer
  // from a since-superseded arming can never turn off a *later* one.
  function resetListenInactivityTimer(generation) {
    if (listeningInactivityTimerRef.current) clearTimeout(listeningInactivityTimerRef.current);
    listeningInactivityTimerRef.current = setTimeout(() => {
      if (listeningGenerationRef.current === generation) setListeningMode(false);
    }, LISTEN_INACTIVITY_MS);
  }

  // One iteration of the hands-free chunk-scheduling loop: record a
  // LISTEN_CHUNK_MS clip on the persistent listening stream, energy-gate
  // it, transcribe survivors, check for a wake-phrase match, then
  // reschedule itself - a recursive loop, not setInterval, so the next
  // chunk never starts until this one's whole round trip (record +
  // energy-check + maybe-transcribe) has actually finished. Self-pauses
  // whenever a manual recording is in progress (checked via recordingRef,
  // not the `recording` state, so this sees a same-tick answer) and
  // resumes once it ends. `generation` guards every checkpoint against a
  // stale iteration from a listening session that's since been toggled
  // off (or restarted).
  async function runListenChunk(generation) {
    if (listeningGenerationRef.current !== generation) return;

    if (recordingRef.current || transcribingRef.current) {
      setTimeout(() => runListenChunk(generation), LISTEN_PAUSE_RETRY_MS);
      return;
    }

    const stream = listeningStreamRef.current;
    const analyser = listeningAnalyserRef.current;
    if (!stream || !analyser) return;

    const recorder = new MediaRecorder(stream);
    const chunkParts = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunkParts.push(e.data);
    };

    let peakRms = 0;
    const sampleData = new Uint8Array(analyser.fftSize);
    const sampleIntervalId = setInterval(() => {
      analyser.getByteTimeDomainData(sampleData);
      peakRms = Math.max(peakRms, computeRms(sampleData));
    }, 200);

    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, LISTEN_CHUNK_MS));
    clearInterval(sampleIntervalId);

    if (listeningGenerationRef.current !== generation) return;
    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve;
    });
    recorder.stop();
    await stopped;

    if (listeningGenerationRef.current !== generation) return;

    // Silent (or near-silent) chunk, or a manual recording started mid-
    // chunk - discard without ever calling /transcribe, and try again
    // right away.
    if (peakRms < LISTEN_ENERGY_THRESHOLD || recordingRef.current) {
      setTimeout(() => runListenChunk(generation), 0);
      return;
    }

    try {
      const blob = new Blob(chunkParts, { type: recorder.mimeType || 'audio/webm' });
      const form = new FormData();
      form.append('audio', blob, 'clip.webm');
      const r = await fetch('/transcribe', { method: 'POST', body: form });
      const data = await r.json().catch(() => ({}));
      const text = r.ok ? data.text || '' : '';
      if (listeningGenerationRef.current === generation && !recordingRef.current && matchesWakePhrase(text)) {
        resetListenInactivityTimer(generation);
        startRecording();
      }
    } catch {
      // A transcription hiccup on a background chunk isn't worth
      // surfacing as an error banner - the loop just tries the next one.
    }

    if (listeningGenerationRef.current === generation) {
      setTimeout(() => runListenChunk(generation), 0);
    }
  }

  // Arms/disarms hands-free listening: on, it claims a persistent
  // microphone stream and a Web Audio analyser for energy-gating, starts
  // the 10-minute inactivity window, and kicks off the chunk loop; off
  // (via the toggle, the banner's "Turn off," inactivity expiry, or this
  // component unmounting), it tears all of that down. Runs once per
  // listeningMode flip, not per render.
  useEffect(() => {
    if (!listeningMode) return undefined;
    listeningGenerationRef.current += 1;
    const generation = listeningGenerationRef.current;
    let stopped = false;
    let audioCtx = null;

    (async () => {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        setError('Microphone access was blocked or unavailable.');
        setListeningMode(false);
        return;
      }
      if (stopped || listeningGenerationRef.current !== generation) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      listeningStreamRef.current = stream;
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtx.resume().catch(() => {});
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      listeningAnalyserRef.current = analyser;
      resetListenInactivityTimer(generation);
      runListenChunk(generation);
    })();

    return () => {
      stopped = true;
      listeningGenerationRef.current += 1;
      if (listeningInactivityTimerRef.current) {
        clearTimeout(listeningInactivityTimerRef.current);
        listeningInactivityTimerRef.current = null;
      }
      listeningStreamRef.current?.getTracks().forEach((t) => t.stop());
      listeningStreamRef.current = null;
      listeningAnalyserRef.current = null;
      audioCtx?.close().catch(() => {});
    };
  }, [listeningMode]);

  // Reads a turn's answer aloud via /speak - a separate local Piper
  // process (core/speak.py), never a cloud voice API and never the
  // browser's own speechSynthesis (whose default OS voices are what
  // prompted this in the first place). Per-turn: audioRef holds at most
  // one playing clip, mirroring the old single-utterance behavior.
  async function handleListenClick(turn) {
    if (speakingId === turn.id) {
      audioRef.current?.pause();
      setSpeakingId(null);
      return;
    }
    audioRef.current?.pause();
    setSpeakingId(null);
    setSynthesizingId(turn.id);
    setError(null);
    try {
      const r = await fetch('/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: stripCitationsForSpeech(turn.data.answer) }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.detail || 'Could not read this answer aloud.');
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        setSpeakingId(null);
        URL.revokeObjectURL(url);
      };
      audio.onerror = () => {
        setSpeakingId(null);
        URL.revokeObjectURL(url);
      };
      setSynthesizingId(null);
      setSpeakingId(turn.id);
      await audio.play();
    } catch (err) {
      setError(err.message);
      setSynthesizingId(null);
      setSpeakingId(null);
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        {theme?.logo_url && !logoFailed ? (
          <img
            className="logo"
            src={theme.logo_url}
            alt=""
            onError={() => setLogoFailed(true)}
          />
        ) : (
          theme && (
            <span className="logo-monogram" aria-hidden="true">
              {initials(theme.firm_name)}
            </span>
          )
        )}
        <span className="firm-name">{theme?.firm_name || 'Case Intelligence'}</span>
        <button
          type="button"
          className={`theme-toggle${darkMode ? ' is-active' : ''}`}
          onClick={() => setDarkMode((v) => !v)}
          aria-pressed={darkMode}
          aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          title={darkMode ? 'Dark mode is on' : 'Dark mode'}
        >
          {darkMode ? 'Dark mode is on' : 'Dark mode'}
        </button>
        {micSupported && (
          <button
            type="button"
            className={`handsfree-toggle${listeningMode ? ' is-active' : ''}`}
            onClick={() => setListeningMode((v) => !v)}
            aria-pressed={listeningMode}
            aria-label={
              listeningMode
                ? `Hands-free is on. Say "${WAKE_PHRASE}" to start a question. Click to turn off.`
                : `Turn on hands-free. Once on, say "${WAKE_PHRASE}" to start a question.`
            }
            title={listeningMode ? 'Hands-free is on' : 'Hands-free'}
          >
            {listeningMode ? 'Hands-free is on' : 'Hands-free'}
          </button>
        )}
      </header>

      {listeningMode && (
        <div className="handsfree-banner" role="status">
          <span className="listening-dot" aria-hidden="true" />
          <span>Hands-free is on. Say &ldquo;{WAKE_PHRASE}&rdquo; to start a question.</span>
          <button type="button" className="handsfree-off-button" onClick={() => setListeningMode(false)}>
            Turn off
          </button>
        </div>
      )}

      <main className="app-main">
        <form className="ask-form" onSubmit={handleAsk}>
          {cases.length > 1 ? (
            <select
              className="case-select"
              value={caseId}
              onChange={(e) => setCaseId(e.target.value)}
              aria-label="Case"
            >
              <option value="">Select a case…</option>
              {cases.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          ) : (
            <input
              className="case-select"
              placeholder="Case ID"
              value={caseId}
              onChange={(e) => setCaseId(e.target.value)}
              aria-label="Case ID"
            />
          )}
          <div className="question-row">
            <input
              className="question-input"
              placeholder={transcribing ? 'Transcribing…' : 'Ask a question about this case…'}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              aria-label="Question"
              disabled={transcribing}
            />
            {micSupported && (
              <button
                type="button"
                className={`mic-button${recording ? ' is-recording' : ''}`}
                onClick={handleMicClick}
                disabled={transcribing}
                aria-pressed={recording}
                aria-label={recording ? 'Stop recording (⌘⇧M)' : 'Ask by voice (⌘⇧M)'}
                title={recording ? 'Stop recording (⌘⇧M)' : 'Ask by voice (⌘⇧M)'}
              >
                {recording ? <StopIcon /> : <MicIcon />}
              </button>
            )}
            <button
              className={`ask-button${loading || streamingTurnId ? ' is-loading' : ''}`}
              type="submit"
              disabled={!canAsk}
            >
              {loading ? 'Asking…' : streamingTurnId ? 'Generating…' : 'Ask'}
            </button>
          </div>
          {(recording || transcribing) && (
            <p className="voice-status" role="status">
              {recording ? (
                <>
                  <span className="mic-dot" aria-hidden="true" /> Listening… stops automatically when you pause
                </>
              ) : (
                'Transcribing…'
              )}
            </p>
          )}
        </form>

        {error && <div className="error-banner">{error}</div>}

        <span className="sr-only" role="status">
          {loading ? 'Searching case documents…' : streamingTurnId ? 'Generating your answer…' : ''}
        </span>

        {turns.length > 0 && (
          <div className="thread-toolbar">
            <button type="button" className="new-conversation-button" onClick={handleNewConversation}>
              Start a new conversation
            </button>
            <button type="button" className="print-button" onClick={() => setPrintExpand(true)}>
              Print this conversation
            </button>
          </div>
        )}

        {(turns.length > 0 || loading) && (
          <div className="conversation-thread">
            <div className="print-only">
              <p className="print-case">Case: {caseId}</p>
            </div>

            {turns.map((turn) => (
              <article className="turn" key={turn.id}>
                <p className="turn-question">{turn.question}</p>
                <div className="answer-toolbar">
                  <button
                    type="button"
                    className={`voice-button${speakingId === turn.id ? ' is-active' : ''}${
                      synthesizingId === turn.id ? ' is-synthesizing' : ''
                    }`}
                    onClick={() => handleListenClick(turn)}
                    disabled={synthesizingId === turn.id || turn.data.streaming}
                    title={turn.data.streaming ? 'Still generating this answer' : undefined}
                  >
                    {synthesizingId === turn.id
                      ? 'Synthesizing…'
                      : speakingId === turn.id
                        ? 'Stop'
                        : 'Listen to this answer'}
                  </button>
                </div>
                <div className="answer-layout">
                  <section className="answer-panel" aria-label="Answer">
                    <h2 className="answer-heading">
                      Answer
                      {turn.data.streaming && (
                        <span className="generating-indicator" role="status">
                          <span className="generating-dot" aria-hidden="true" /> Generating…
                        </span>
                      )}
                    </h2>
                    <AnswerBody text={turn.data.answer} />
                  </section>
                  <aside className="source-panel" aria-label="Sources">
                    <h2 className="source-heading">Sources</h2>
                    {turn.data.sources.length === 0 ? (
                      <p className="no-sources">No matching passages found in this case.</p>
                    ) : (
                      <ul className="source-list">
                        {turn.data.sources.map((s, i) => (
                          <SourceCard
                            key={`${s.doc_id}-${s.page}-${s.chunk_index}`}
                            source={s}
                            index={i}
                            forceOpen={printExpand}
                          />
                        ))}
                      </ul>
                    )}
                  </aside>
                </div>
              </article>
            ))}

            {loading && (
              <article className="turn" aria-busy="true">
                {pendingQuestion && <p className="turn-question">{pendingQuestion}</p>}
                <div className="answer-layout">
                  <section className="answer-panel skeleton-panel" aria-label="Preparing your answer">
                    <div className="skeleton skeleton-line skeleton-line--lead" />
                    <div className="skeleton skeleton-line" />
                    <div className="skeleton skeleton-line" />
                    <div className="skeleton skeleton-line skeleton-line--short" />
                  </section>
                  <aside className="source-panel skeleton-panel" aria-label="Preparing sources">
                    <div className="skeleton skeleton-chip" />
                    <div className="skeleton skeleton-chip" />
                    <div className="skeleton skeleton-chip" />
                  </aside>
                </div>
              </article>
            )}
          </div>
        )}

        {!loading && turns.length === 0 && !error && (
          <div className="empty-state">
            <h2 className="empty-state-heading">Ready when you are.</h2>
            <p className="empty-state-body">
              {caseId
                ? 'Ask a question about this case to see a sourced answer, with every citation linked back to the page it came from.'
                : 'Select a case, then ask a question to see a sourced answer, with every citation linked back to the page it came from.'}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
