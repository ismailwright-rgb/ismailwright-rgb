import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase.js';
import { WORKFLOWS, recommendWorkflow, buildScript, scriptToText } from './playbook.js';

const STATUSES = ['new', 'queued', 'contacted', 'replied', 'demo_booked', 'won', 'lost', 'dnc'];
const CHANNELS = [['call', 'Call'], ['email', 'Email'], ['sms', 'Text']];
const fmt = (d) => (d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const inDays = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  d.setHours(9, 0, 0, 0);
  return d.toISOString().slice(0, 16);
};

/**
 * Call-prep and call-logging in one surface: the script to run, the full
 * history, and the controls to record what happened and what's next.
 */
export default function ProspectDrawer({ prospect, onClose, onChanged }) {
  const [timeline, setTimeline] = useState([]);
  const [note, setNote] = useState('');
  const [logging, setLogging] = useState({ channel: 'call', direction: 'outbound', body: '' });
  const [status, setStatus] = useState(prospect.status);
  const [nextAction, setNextAction] = useState(prospect.next_action || '');
  const [nextAt, setNextAt] = useState(prospect.next_action_at ? prospect.next_action_at.slice(0, 16) : '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  const [copied, setCopied] = useState(false);

  const rec = useMemo(() => recommendWorkflow(prospect), [prospect]);
  const script = useMemo(() => buildScript(prospect, rec), [prospect, rec]);

  async function loadTimeline() {
    const [c, n] = await Promise.all([
      supabase.from('sanaku_conversations').select('*').eq('prospect_id', prospect.id),
      supabase.from('sanaku_notes').select('*').eq('prospect_id', prospect.id),
    ]);
    const items = [
      ...(c.data || []).map((x) => ({ ...x, kind: 'msg', at: x.sent_at })),
      ...(n.data || []).map((x) => ({ ...x, kind: 'note', at: x.created_at })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at));
    setTimeline(items);
  }
  useEffect(() => { loadTimeline(); /* eslint-disable-next-line */ }, [prospect.id]);

  function flash(msg) {
    setSaved(msg);
    setTimeout(() => setSaved(''), 1800);
  }

  async function addNote() {
    if (!note.trim()) return;
    setBusy(true);
    const { error } = await supabase.from('sanaku_notes').insert({ prospect_id: prospect.id, body: note.trim() });
    setBusy(false);
    if (error) return flash('Error: ' + error.message);
    setNote('');
    flash('Note saved');
    loadTimeline();
    onChanged?.();
  }

  async function logActivity() {
    if (!logging.body.trim()) return;
    setBusy(true);
    const { error } = await supabase.from('sanaku_conversations').insert({
      prospect_id: prospect.id,
      channel: logging.channel,
      direction: logging.direction,
      body: logging.body.trim(),
    });
    // Logging an outbound touch is what "contacted" means.
    if (!error && logging.direction === 'outbound' && ['new', 'queued'].includes(status)) {
      await supabase.from('sanaku_prospects')
        .update({ status: 'contacted', last_contacted: new Date().toISOString() })
        .eq('id', prospect.id);
      setStatus('contacted');
    }
    setBusy(false);
    if (error) return flash('Error: ' + error.message);
    setLogging({ ...logging, body: '' });
    flash('Activity logged');
    loadTimeline();
    onChanged?.();
  }

  async function saveFields() {
    setBusy(true);
    const { error } = await supabase.from('sanaku_prospects').update({
      status,
      next_action: nextAction.trim() || null,
      next_action_at: nextAt ? new Date(nextAt).toISOString() : null,
    }).eq('id', prospect.id);
    setBusy(false);
    flash(error ? 'Error: ' + error.message : 'Saved');
    if (!error) onChanged?.();
  }

  async function copyScript() {
    try {
      await navigator.clipboard.writeText(scriptToText(prospect, rec, script));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard unavailable */ }
  }

  const p = prospect;
  return (
    <div className="drawer wide">
      <header>
        <div>
          <b>{p.company_name}</b>
          <div className="muted">
            <a href={p.website_url || `https://${p.domain}`} target="_blank" rel="noreferrer">{p.domain}</a>
            {p.contact_phone && <> · <a href={`tel:${p.contact_phone.replace(/[^\d+]/g, '')}`}>{p.contact_phone}</a></>}
            {p.contact_email && <> · <a href={`mailto:${p.contact_email}`}>{p.contact_email}</a></>}
          </div>
        </div>
        <button className="rowbtn" onClick={onClose}>Close</button>
      </header>

      <div className="drawer-body">
        {/* --- what to sell them, and the script --- */}
        <section className="dsec">
          <div className="dsec-head">
            <span className="k">Best fit</span>
            <button className="rowbtn primary" onClick={copyScript}>{copied ? 'Copied ✓' : 'Copy script'}</button>
          </div>
          <div className="fitname">{WORKFLOWS[rec.key].name}</div>
          <p className="fitwhy">{rec.why}</p>
          <details className="objections">
            <summary>Call script</summary>
            <div className="script">
              <div className="sline"><span>OPEN</span><p>{script.opener}</p></div>
              <div className="sline"><span>ASK</span><p><b>{script.question}</b></p></div>
              <div className="sline"><span>STAKES</span><p>{script.stakes}</p></div>
              <div className="sline"><span>MATH</span><p>{script.math}</p></div>
              <div className="sline"><span>CLOSE</span><p>{script.close}</p></div>
              {script.objections.map((o, i) => (
                <p key={i} className="muted"><b>{o.q}</b><br />{o.a}</p>
              ))}
            </div>
          </details>
        </section>

        {/* --- pipeline controls --- */}
        <section className="dsec">
          <span className="k">Where it stands</span>
          <div className="drow">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <input
              placeholder="Next action (e.g. call back re: pricing)"
              value={nextAction}
              onChange={(e) => setNextAction(e.target.value)}
            />
          </div>
          <div className="drow">
            <input type="datetime-local" value={nextAt} onChange={(e) => setNextAt(e.target.value)} />
            <div className="quick">
              <button type="button" className="rowbtn" onClick={() => setNextAt(inDays(1))}>Tomorrow</button>
              <button type="button" className="rowbtn" onClick={() => setNextAt(inDays(3))}>+3d</button>
              <button type="button" className="rowbtn" onClick={() => setNextAt(inDays(7))}>+1wk</button>
            </div>
          </div>
          <button className="rowbtn primary" disabled={busy} onClick={saveFields}>Save</button>
          {saved && <span className="savedflash">{saved}</span>}
        </section>

        {/* --- log what happened --- */}
        <section className="dsec">
          <span className="k">Log activity</span>
          <div className="drow">
            <select value={logging.channel} onChange={(e) => setLogging({ ...logging, channel: e.target.value })}>
              {CHANNELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <select value={logging.direction} onChange={(e) => setLogging({ ...logging, direction: e.target.value })}>
              <option value="outbound">Outbound</option>
              <option value="inbound">Inbound</option>
            </select>
          </div>
          <textarea
            rows="2"
            placeholder="What was said? (Left voicemail. Spoke to office manager — asked me to call Tuesday.)"
            value={logging.body}
            onChange={(e) => setLogging({ ...logging, body: e.target.value })}
          />
          <button className="rowbtn primary" disabled={busy} onClick={logActivity}>Log it</button>
        </section>

        {/* --- notes --- */}
        <section className="dsec">
          <span className="k">Add a note</span>
          <textarea rows="2" placeholder="Anything worth remembering before the next call…" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="rowbtn" disabled={busy} onClick={addNote}>Save note</button>
        </section>

        {/* --- history --- */}
        <section className="dsec">
          <span className="k">History</span>
          {timeline.length === 0 && <p className="muted">Nothing logged yet.</p>}
          {timeline.map((t) => (
            <div key={t.kind + t.id} className={'tl ' + t.kind}>
              <div className="tl-meta">
                {t.kind === 'note' ? 'NOTE' : `${t.direction} · ${t.channel}`}
                {t.sentiment ? ` · ${t.sentiment}` : ''} · {fmt(t.at)}
              </div>
              <div>{t.body}</div>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
