import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase.js';
import { WORKFLOWS, recommendWorkflow, buildScript, scriptToText } from './playbook.js';

const STATUSES = ['new', 'queued', 'contacted', 'replied', 'demo_booked', 'won', 'lost', 'dnc'];

// What each number actually reaches. Only one of these puts you through to the
// person whose name is on the card, and the difference decides your first
// sentence: "Hi Elaine" or "could I speak with Elaine".
const PHONE_SOURCE = {
  apollo_direct:  { label: 'Direct line',   good: true,
                    hint: 'Apollo direct dial — this should reach them.' },
  apollo_company: { label: 'Main line',     good: false,
                    hint: 'Company switchboard. Ask for them by name.' },
  google_places:  { label: 'Main line',     good: false,
                    hint: 'Google listing number. Ask for them by name.' },
  website:        { label: 'Main line',     good: false,
                    hint: 'Scraped off their homepage. Ask for them by name.' },
  manual:         { label: 'Entered by hand', good: false, hint: '' },
};
const tel = (s) => String(s || '').replace(/[^\d+]/g, '');

// What the contact's title is. Whether that band can APPROVE is per-vertical
// and already decided by W1 into decision_maker - an office manager is the
// de-facto approver for back-office tools at a dental practice and a gatekeeper
// at a plumbing shop, on the identical title. So the label comes from here and
// the verdict comes from the row; this table never overrides it.
const AUTHORITY = {
  owner:      { label: 'Owner / CEO',        hint: 'Can say yes on the call.' },
  partner:    { label: 'Partner',            hint: 'One of several owners — expect "let me talk to my partners".' },
  operations: { label: 'Operations',         hint: 'Runs the phones day to day. Owns this problem even when the owner signs.' },
  office:     { label: 'Office manager',     hint: 'Runs the front desk. For back-office tools, usually the real decision.' },
  c_suite:    { label: 'C-suite',            hint: 'Signs it, or walks it to the owner the same day.' },
  marketing:  { label: 'Marketing / intake', hint: 'Owns the missed-call problem even if they do not own the firm.' },
  leader:     { label: 'Dept. lead',         hint: 'Real, but they route you rather than buy. Ask who owns intake.' },
  staff:      { label: 'Staff',              hint: 'A gatekeeper. Use them to get the owner\'s name, not to pitch.' },
  none:       { label: 'Business only',      hint: '' },
};

/**
 * The header of a call. Who picks up, whether the number reaches them, and a
 * way to check they still work there before you dial.
 *
 * A prospect with no name is one Apollo had nobody for, so the business itself
 * is the contact. Saying that plainly is the point - a blank where a name
 * should be is a different call, not a smaller one, and must never read as a
 * decision maker we simply forgot to fill in.
 */
function WhoYouAreCalling({ p }) {
  const src = PHONE_SOURCE[p.contact_phone_source] || null;
  const main = p.company_phone && p.company_phone !== p.contact_phone ? p.company_phone : null;
  const auth = AUTHORITY[p.contact_authority] || null;
  return (
    <section className="dsec who">
      <span className="k">Who you're calling</span>
      {p.contact_name ? (
        <div className="whoname">
          <b>{p.contact_name}</b>
          {p.contact_title && <span className="whotitle">{p.contact_title}</span>}
          {auth && (
            <span className={'pill ' + (p.decision_maker ? 'dm' : 'notdm')} title={auth.hint}>
              {auth.label}
            </span>
          )}
          {p.contact_linkedin_url && (
            <a className="wholink" href={p.contact_linkedin_url} target="_blank" rel="noreferrer">
              verify on LinkedIn ↗
            </a>
          )}
        </div>
      ) : (
        <div className="whoname none">
          <b>No decision maker found</b>
          <span className="whotitle">
            Apollo has nobody at this company. Falling back to the business line —
            your first job on the call is to get the owner's name.
          </span>
        </div>
      )}
      {auth?.hint && <p className="whohint">{auth.hint}</p>}
      {p.phone_reveal_request_id && p.contact_phone_source !== 'apollo_direct' && (
        <p className="whopending">
          Direct-line reveal requested — Apollo can take several minutes.
          Check back after the next scrape.
        </p>
      )}
      <div className="whophones">
        {p.contact_phone ? (
          <div className={'whophone' + (src?.good ? ' direct' : '')}>
            <a href={`tel:${tel(p.contact_phone)}`}>{p.contact_phone}</a>
            {src && <span className="phlabel">{src.label}</span>}
            {src?.hint && <span className="phhint">{src.hint}</span>}
          </div>
        ) : (
          <div className="whophone"><span className="phlabel">No phone number</span></div>
        )}
        {main && (
          <div className="whophone">
            <a href={`tel:${tel(main)}`}>{main}</a>
            <span className="phlabel">Main line</span>
          </div>
        )}
      </div>
      <div className="whophones">
        {p.contact_email && (
          <div className="whophone">
            <a href={`mailto:${p.contact_email}`}>{p.contact_email}</a>
            <span className="phlabel">Business</span>
          </div>
        )}
        {p.contact_email_personal && (
          <div className="whophone">
            <a href={`mailto:${p.contact_email_personal}`}>{p.contact_email_personal}</a>
            <span className="phlabel">Personal</span>
            <span className="phhint">Apollo had this on file. Verify it's live before sending anything that matters.</span>
          </div>
        )}
      </div>
    </section>
  );
}
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
            {p.contact_email && <> · <a href={`mailto:${p.contact_email}`}>{p.contact_email}</a></>}
          </div>
        </div>
        <button className="rowbtn" onClick={onClose}>Close</button>
      </header>

      <div className="drawer-body">
        <WhoYouAreCalling p={p} />
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
