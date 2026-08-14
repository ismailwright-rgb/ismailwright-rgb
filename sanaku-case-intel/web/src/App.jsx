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

/** Very small formatter for the answer text: blocks separated by a blank
 * line become paragraphs, or a bulleted list if every line in the block
 * starts with "* " or "- " - matches the shape the answer contract asks
 * the model to produce (thesis paragraph, then a bulleted list of
 * supporting points). No markdown library - the shape is simple and
 * fixed enough not to need one. */
function AnswerBody({ text }) {
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
  const [logoFailed, setLogoFailed] = useState(false);
  const [cases, setCases] = useState([]);
  const [caseId, setCaseId] = useState('');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [printExpand, setPrintExpand] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  const micSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

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

    // Some browsers return an empty voice list until this fires once -
    // warm the cache early so speakAnswer() has real voices to filter by
    // the first time someone clicks "Listen to this answer".
    if (speechSupported) {
      window.speechSynthesis.getVoices();
    }
  }, []);

  const canAsk = useMemo(() => caseId.trim() && question.trim() && !loading, [caseId, question, loading]);

  async function handleAsk(e) {
    e.preventDefault();
    if (!canAsk) return;
    if (speechSupported) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
    }
    setLoading(true);
    setError(null);
    setAnswer(null);
    try {
      const r = await fetch('/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ case_id: caseId.trim(), question: question.trim() }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || 'Something went wrong.');
      setAnswer(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Click to start recording, click again to stop - transcription runs
  // entirely on this project's own /transcribe endpoint (a local model,
  // see core/transcribe.py), never the browser's built-in speech
  // recognition, which on Chrome typically sends audio to Google's
  // servers. The transcribed text fills the question box; it does not
  // submit on its own - a misheard word silently becoming the actual
  // question is the wrong failure mode for legal software.
  async function handleMicClick() {
    if (recording) {
      mediaRecorderRef.current?.stop();
      return;
    }
    setError(null);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError('Microphone access was blocked or unavailable.');
      return;
    }

    const recorder = new MediaRecorder(stream);
    audioChunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setRecording(false);
      setTranscribing(true);
      try {
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        const form = new FormData();
        form.append('audio', blob, 'clip.webm');
        const r = await fetch('/transcribe', { method: 'POST', body: form });
        const data = await r.json();
        if (!r.ok) throw new Error(data.detail || 'Could not transcribe that.');
        setQuestion(data.text || '');
      } catch (err) {
        setError(err.message);
      } finally {
        setTranscribing(false);
      }
    };

    mediaRecorderRef.current = recorder;
    recorder.start();
    setRecording(true);
  }

  // Reads the answer aloud using an on-device voice only (localService
  // === true) - never a network voice - so this stays consistent with the
  // "nothing leaves the building" guarantee even though speechSynthesis
  // itself isn't something this project controls the internals of.
  function speakAnswer() {
    if (!speechSupported || !answer) return;
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    // Citation tokens like [doc.pdf, p.3] are fine to read on screen,
    // tedious to hear spoken aloud on every sentence - strip them from
    // what's spoken; they stay fully visible in the answer panel.
    const spokenText = answer.answer.replace(/\[[^\]]+\]/g, '').replace(/[ \t]{2,}/g, ' ');
    const utterance = new SpeechSynthesisUtterance(spokenText);
    try {
      const localVoices = window.speechSynthesis.getVoices().filter((v) => v.localService);
      if (localVoices.length > 0) {
        utterance.voice = localVoices.find((v) => v.lang?.startsWith('en')) || localVoices[0];
      }
    } catch {
      // Picking a preferred voice is a nicety, not a requirement - if
      // anything about voice selection fails, fall through and let
      // speechSynthesis use its own default rather than not speaking at
      // all.
    }
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
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
      </header>

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
                aria-label={recording ? 'Stop recording' : 'Ask by voice'}
                title={recording ? 'Stop recording' : 'Ask by voice'}
              >
                {recording ? <StopIcon /> : <MicIcon />}
              </button>
            )}
            <button
              className={`ask-button${loading ? ' is-loading' : ''}`}
              type="submit"
              disabled={!canAsk}
            >
              {loading ? 'Asking…' : 'Ask'}
            </button>
          </div>
          {(recording || transcribing) && (
            <p className="voice-status" role="status">
              {recording ? (
                <>
                  <span className="mic-dot" aria-hidden="true" /> Listening…
                </>
              ) : (
                'Transcribing…'
              )}
            </p>
          )}
        </form>

        {error && <div className="error-banner">{error}</div>}

        <span className="sr-only" role="status">
          {loading ? 'Searching case documents…' : ''}
        </span>

        {loading && (
          <div className="answer-layout" aria-busy="true">
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
        )}

        {!loading && answer && (
          <>
            <div className="print-only">
              <p className="print-case">Case: {caseId}</p>
              <p className="print-question">Question: {question}</p>
            </div>
            <div className="answer-toolbar">
              {speechSupported && (
                <button
                  type="button"
                  className={`voice-button${speaking ? ' is-active' : ''}`}
                  onClick={speakAnswer}
                >
                  {speaking ? 'Stop' : 'Listen to this answer'}
                </button>
              )}
              <button type="button" className="print-button" onClick={() => setPrintExpand(true)}>
                Print this answer
              </button>
            </div>
            <div className="answer-layout">
              <section className="answer-panel" aria-label="Answer">
                <h2 className="answer-heading">Answer</h2>
                <AnswerBody text={answer.answer} />
              </section>
              <aside className="source-panel" aria-label="Sources">
                <h2 className="source-heading">Sources</h2>
                {answer.sources.length === 0 ? (
                  <p className="no-sources">No matching passages found in this case.</p>
                ) : (
                  <ul className="source-list">
                    {answer.sources.map((s, i) => (
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
          </>
        )}

        {!loading && !answer && !error && (
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
