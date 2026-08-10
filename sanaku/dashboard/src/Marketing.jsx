import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase.js';
import {
  captionFor, imagesFor, packName, copyText, downloadImage,
  downloadPostPack, downloadBatchPack,
} from './postpack.js';

/**
 * The content studio.
 *
 * M1 writes one LinkedIn item a day into content_queue and stops. This is the
 * approval gate and the export bench: read it, fix it, approve it, and leave
 * with a folder you can upload. Nothing here posts to LinkedIn - the API will
 * not reliably publish polls, carousels or articles to a personal profile, so
 * the handoff is a deliberate copy-and-paste rather than a broken automation.
 *
 * Work one format at a time. That is why the format filter is the first control
 * and not a column: writing five posts is a different job from assembling a
 * carousel, and batching by format is how the week actually gets done.
 */

const TYPES = [
  ['all', 'Everything'],
  ['post', 'Posts'],
  ['carousel', 'Carousels'],
  ['poll', 'Polls'],
  ['article', 'Articles'],
  ['newsletter', 'Newsletter'],
  ['featured', 'Featured'],
];
const STATUSES = [['queued', 'Queued'], ['approved', 'Approved'], ['posted', 'Posted'], ['all', 'All']];

const VERTICAL_LABEL = {
  personal_injury_law: 'PI law',
  accounting_tax: 'Accounting & tax',
  therapy: 'Therapy',
  financial_advisory: 'Financial advisory',
  family_office: 'Family office',
};
const pretty = (s) => String(s || '').replace(/_/g, ' ');
const day = (s) => (s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');

export default function Marketing() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [type, setType] = useState('all');
  const [status, setStatus] = useState('queued');
  const [busy, setBusy] = useState(null);      // id or 'batch', while exporting
  const [flash, setFlash] = useState(null);
  const [editing, setEditing] = useState(null); // id being edited
  const [draft, setDraft] = useState({});

  async function load() {
    setLoading(true);
    const { data, error } = await supabase
      .from('content_queue')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) setFlash(`Could not load the queue: ${error.message}`);
    setRows(data || []);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  // A flash message that clears itself, so the bench does not accumulate stale
  // "Copied" banners while working through a week of items.
  useEffect(() => {
    if (!flash) return undefined;
    const t = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(t);
  }, [flash]);

  const shown = useMemo(() => rows.filter(
    (r) => (type === 'all' || r.content_type === type)
        && (status === 'all' || r.status === status),
  ), [rows, type, status]);

  const approved = useMemo(() => rows.filter((r) => r.status === 'approved'), [rows]);
  const counts = useMemo(() => {
    const c = {};
    for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [rows]);

  async function patch(id, fields) {
    const { error } = await supabase.from('content_queue').update(fields).eq('id', id);
    if (error) { setFlash(`Save failed: ${error.message}`); return false; }
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...fields } : r)));
    return true;
  }

  async function remove(item) {
    if (!window.confirm(`Delete this ${item.content_type}? This cannot be undone.`)) return;
    const { error } = await supabase.from('content_queue').delete().eq('id', item.id);
    if (error) { setFlash(`Delete failed: ${error.message}`); return; }
    setRows((rs) => rs.filter((r) => r.id !== item.id));
  }

  function startEdit(item) {
    setEditing(item.id);
    setDraft({
      title: item.title || '',
      post_text: item.post_text || '',
      body: item.body || '',
      poll_question: item.poll_question || '',
      poll_options: (item.poll_options || []).join('\n'),
      // Slides are edited as one block split on a --- line. One textarea per
      // slide turns an eight-slide carousel into an unusable wall of boxes.
      slides: (item.slides || []).map((s) => s.text).join('\n---\n'),
    });
  }

  async function saveEdit(item) {
    const fields = {};
    if (item.content_type === 'post') fields.post_text = draft.post_text;
    if (item.content_type === 'carousel') {
      fields.title = draft.title;
      fields.post_text = draft.post_text || null;
      const texts = draft.slides.split(/^\s*---\s*$/m).map((s) => s.trim()).filter(Boolean);
      if (texts.length < 1) { setFlash('A carousel needs at least one slide.'); return; }
      // Keep each slide's existing image, matched by position.
      fields.slides = texts.map((text, i) => {
        const was = (item.slides || [])[i] || {};
        return was.image_url ? { text, image_url: was.image_url } : { text };
      });
    }
    if (item.content_type === 'poll') {
      const opts = draft.poll_options.split('\n').map((s) => s.trim()).filter(Boolean);
      if (opts.length < 2 || opts.length > 4) { setFlash('A poll needs 2 to 4 options.'); return; }
      fields.poll_question = draft.poll_question;
      fields.poll_options = opts;
      fields.post_text = draft.post_text || null;
    }
    if (['article', 'newsletter', 'featured'].includes(item.content_type)) {
      fields.title = draft.title;
      fields.body = draft.body || null;
    }
    if (await patch(item.id, fields)) { setEditing(null); setFlash('Saved.'); }
  }

  async function doCopy(item) {
    const ok = await copyText(captionFor(item));
    setFlash(ok ? 'Copied — paste straight into LinkedIn.' : 'Could not reach the clipboard.');
  }

  async function doPack(item) {
    setBusy(item.id);
    try {
      const { missing } = await downloadPostPack(item);
      setFlash(missing
        ? `Downloaded ${packName(item)}.zip — but ${missing} image(s) could not be fetched; see MISSING-IMAGES.txt.`
        : `Downloaded ${packName(item)}.zip`);
    } catch (e) {
      setFlash(`Could not build the pack: ${e.message}`);
    } finally { setBusy(null); }
  }

  async function doBatch() {
    if (!approved.length) return;
    setBusy('batch');
    try {
      const { count, missing } = await downloadBatchPack(approved);
      setFlash(missing
        ? `Downloaded ${count} approved item(s) — ${missing} image(s) missing, noted inside.`
        : `Downloaded ${count} approved item(s), one folder each.`);
    } catch (e) {
      setFlash(`Batch export failed: ${e.message}`);
    } finally { setBusy(null); }
  }

  return (
    <>
      <div className="metrics">
        <div className="metric"><div className="v">{counts.queued || 0}</div><div className="l">Waiting on you</div></div>
        <div className="metric"><div className="v">{counts.approved || 0}</div><div className="l">Approved, ready to post</div></div>
        <div className="metric"><div className="v">{counts.posted || 0}</div><div className="l">Posted</div></div>
      </div>

      <div className="controls">
        <div className="seg">
          {TYPES.map(([k, label]) => (
            <button key={k} className={type === k ? 'on' : ''} onClick={() => setType(k)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="controls">
        <div className="seg">
          {STATUSES.map(([k, label]) => (
            <button key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{label}</button>
          ))}
        </div>
        <button
          className="bulk"
          disabled={!approved.length || busy === 'batch'}
          onClick={doBatch}
        >
          {busy === 'batch' ? 'Building…' : `Download all approved (${approved.length})`}
        </button>
      </div>

      {flash && <div className="notice">{flash}</div>}

      {loading ? <div className="card"><div className="empty">Loading…</div></div>
        : shown.length === 0 ? (
          <div className="card">
            <div className="empty">
              {rows.length === 0
                ? 'Nothing in the queue yet. M1 writes one item each morning at 7am.'
                : 'Nothing matches this filter.'}
            </div>
          </div>
        ) : shown.map((item) => (
          <Item
            key={item.id}
            item={item}
            busy={busy === item.id}
            editing={editing === item.id}
            draft={draft}
            setDraft={setDraft}
            onEdit={() => startEdit(item)}
            onCancel={() => setEditing(null)}
            onSave={() => saveEdit(item)}
            onCopy={() => doCopy(item)}
            onPack={() => doPack(item)}
            onApprove={() => patch(item.id, { status: 'approved' })}
            onUnapprove={() => patch(item.id, { status: 'queued' })}
            onPosted={() => patch(item.id, { status: 'posted', posted_at: new Date().toISOString() })}
            onDelete={() => remove(item)}
            onFlash={setFlash}
          />
        ))}
    </>
  );
}

function Item({
  item, busy, editing, draft, setDraft, onEdit, onCancel, onSave, onCopy, onPack,
  onApprove, onUnapprove, onPosted, onDelete, onFlash,
}) {
  const images = imagesFor(item);
  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  return (
    <div className="card mk">
      <div className="mk-head">
        <span className={`pill mk-type-${item.content_type}`}>{item.content_type}</span>
        <span className={`pill status-${item.status === 'approved' ? 'won' : item.status === 'posted' ? 'contacted' : 'queued'}`}>
          {item.status}
        </span>
        <b className="mk-title">{item.title || (item.post_text || '').slice(0, 70) || item.poll_question || '(untitled)'}</b>
        <span className="spacer" />
        <span className="muted mk-meta">
          {VERTICAL_LABEL[item.target_vertical] || pretty(item.target_vertical)}
          {item.bottleneck ? ` · ${pretty(item.bottleneck)}` : ''} · {day(item.created_at)}
        </span>
      </div>

      <div className="mk-body">
        {editing ? (
          <Editor item={item} draft={draft} set={set} />
        ) : (
          <Preview item={item} />
        )}

        {images.length > 0 && (
          <div className="mk-shots">
            {images.map((img) => (
              <figure key={img.url}>
                <img src={img.url} alt={img.name} loading="lazy" />
                <figcaption>
                  <span className="muted">{img.name}</span>
                  <button
                    className="rowbtn"
                    onClick={() => downloadImage(img.url, `${packName(item)}_${img.name}.jpg`)
                      .catch((e) => onFlash(`Download failed: ${e.message}`))}
                  >
                    Download
                  </button>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>

      <div className="mk-actions">
        {editing ? (
          <>
            <button className="rowbtn primary" onClick={onSave}>Save</button>
            <button className="rowbtn" onClick={onCancel}>Cancel</button>
          </>
        ) : (
          <>
            <button className="rowbtn primary" onClick={onCopy}>Copy text</button>
            <button className="rowbtn" disabled={busy} onClick={onPack}>
              {busy ? 'Building…' : 'Download post pack'}
            </button>
            <button className="rowbtn" onClick={onEdit}>Edit</button>
            {item.status === 'queued' && <button className="rowbtn" onClick={onApprove}>Approve</button>}
            {item.status === 'approved' && (
              <>
                <button className="rowbtn" onClick={onPosted}>Mark posted</button>
                <button className="rowbtn" onClick={onUnapprove}>Un-approve</button>
              </>
            )}
            <span className="spacer" />
            <button className="rowbtn mk-danger" onClick={onDelete}>Delete</button>
          </>
        )}
      </div>
    </div>
  );
}

function Preview({ item }) {
  if (item.content_type === 'carousel') {
    const slides = item.slides || [];
    return (
      <>
        {item.post_text && <p className="mk-caption">{item.post_text}</p>}
        <div className="mk-slides">
          {slides.map((s, i) => (
            <div className="mk-slide" key={i}>
              <div className="mk-slide-n">{i + 1}/{slides.length}</div>
              {s.image_url && <img src={s.image_url} alt="" loading="lazy" />}
              <p>{s.text}</p>
            </div>
          ))}
        </div>
      </>
    );
  }

  if (item.content_type === 'poll') {
    return (
      <>
        {item.post_text && <p className="mk-caption">{item.post_text}</p>}
        <p className="mk-question">{item.poll_question}</p>
        <ul className="mk-options">
          {(item.poll_options || []).map((o, i) => <li key={i}>{o}</li>)}
        </ul>
      </>
    );
  }

  const text = item.body || item.post_text || '';
  return <p className="mk-caption">{text}</p>;
}

function Editor({ item, draft, set }) {
  const t = item.content_type;
  return (
    <div className="mk-edit">
      {['carousel', 'article', 'newsletter', 'featured'].includes(t) && (
        <label>Title<input value={draft.title} onChange={set('title')} /></label>
      )}
      {t === 'post' && (
        <label>Post text<textarea rows={9} value={draft.post_text} onChange={set('post_text')} /></label>
      )}
      {t === 'carousel' && (
        <>
          <label>Caption<textarea rows={3} value={draft.post_text} onChange={set('post_text')} /></label>
          <label>
            Slides <span className="muted">— separate each slide with a line containing only ---</span>
            <textarea rows={14} value={draft.slides} onChange={set('slides')} />
          </label>
        </>
      )}
      {t === 'poll' && (
        <>
          <label>Body<textarea rows={5} value={draft.post_text} onChange={set('post_text')} /></label>
          <label>Question<input value={draft.poll_question} onChange={set('poll_question')} /></label>
          <label>
            Options <span className="muted">— one per line, 2 to 4</span>
            <textarea rows={4} value={draft.poll_options} onChange={set('poll_options')} />
          </label>
        </>
      )}
      {['article', 'newsletter', 'featured'].includes(t) && (
        <label>Body<textarea rows={18} value={draft.body} onChange={set('body')} /></label>
      )}
    </div>
  );
}
