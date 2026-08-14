import { useEffect, useMemo, useState } from 'react';

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

function SourceCard({ source, index }) {
  const [open, setOpen] = useState(false);
  const badges = [];
  if (source.human_entered) badges.push('Human-entered note');
  if (source.date_confidence === 'approximate') badges.push('Approximate date');
  if (source.date_confidence === 'undated') badges.push('Undated');

  return (
    <li className="source-card">
      <button className="source-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="source-num">{index + 1}</span>
        <span className="source-meta">
          <span className="source-doc">{source.doc_name}</span>
          <span className="source-page">p.{source.page}</span>
        </span>
        <span className="source-chevron">{open ? '−' : '+'}</span>
      </button>
      {badges.length > 0 && (
        <div className="source-badges">
          {badges.map((b) => (
            <span key={b} className="badge">{b}</span>
          ))}
        </div>
      )}
      {open && <p className="source-text">{source.text}</p>}
    </li>
  );
}

export default function App() {
  const [theme, setTheme] = useState(null);
  const [cases, setCases] = useState([]);
  const [caseId, setCaseId] = useState('');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/theme')
      .then((r) => r.json())
      .then((t) => {
        setTheme(t);
        applyTheme(t.colors || DEFAULT_COLORS);
        document.title = t.firm_name || 'Case Intelligence';
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

  const canAsk = useMemo(() => caseId.trim() && question.trim() && !loading, [caseId, question, loading]);

  async function handleAsk(e) {
    e.preventDefault();
    if (!canAsk) return;
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

  return (
    <div className="app">
      <header className="app-header">
        {theme?.logo_url && (
          <img
            className="logo"
            src={theme.logo_url}
            alt=""
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
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
              placeholder="Ask a question about this case…"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              aria-label="Question"
            />
            <button className="ask-button" type="submit" disabled={!canAsk}>
              {loading ? 'Asking…' : 'Ask'}
            </button>
          </div>
        </form>

        {error && <div className="error-banner">{error}</div>}

        {answer && (
          <div className="answer-layout">
            <section className="answer-panel" aria-label="Answer">
              <AnswerBody text={answer.answer} />
            </section>
            <aside className="source-panel" aria-label="Sources">
              <h2 className="source-heading">Sources</h2>
              {answer.sources.length === 0 ? (
                <p className="no-sources">No matching passages found in this case.</p>
              ) : (
                <ul className="source-list">
                  {answer.sources.map((s, i) => (
                    <SourceCard key={`${s.doc_id}-${s.page}-${s.chunk_index}`} source={s} index={i} />
                  ))}
                </ul>
              )}
            </aside>
          </div>
        )}
      </main>
    </div>
  );
}
