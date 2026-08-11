import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase.js';
import {
  bestEmail, bestPhone, saveDraft, approveDraft, skipDraft, approveAndSend,
  sendBudget, sendHealth, canSend, sendSwitch, setSendSwitch, canDraft, draftFor, draftableProspects,
} from './outreach.js';

/**
 * The outreach bench — the second approval gate.
 *
 * W2 drafts an email and stops. Nothing reaches a stranger's inbox until it
 * has been read here. The draft is shown as it will arrive, with the contact
 * details beside it, because deciding whether to send is partly deciding
 * whether this is the right person at all.
 */
const VERTICAL = {
  law_firm: 'PI law', accounting_tax: 'Accounting & tax', therapy: 'Therapy',
  financial_advisory: 'Financial advisory', family_office: 'Family office',
};
const day = (s) => (s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');
const STEP = { 1: 'Opener', 2: 'Follow-up · day 3', 3: 'Breakup · day 8' };

export default function OutreachDrafts() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState(null);
  const [busy, setBusy] = useState(null);
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({ subject: '', body: '' });
  const [budget, setBudget] = useState(null);
  const [health, setHealth] = useState(null);   // is the sender actually working
  const [sending, setSending] = useState(null);   // master switch state
  const [pool, setPool] = useState([]);          // verified people with no draft yet

  async function load() {
    setLoading(true);
    const { data, error } = await supabase.from('sanaku_prospects')
      .select('*').in('status', ['draft_review', 'approved'])
      .order('draft_generated_at', { ascending: true });
    if (error) setFlash(`Could not load drafts: ${error.message}`);
    setRows(data || []);
    setBudget(await sendBudget().catch(() => null));
    setHealth(await sendHealth().catch(() => null));
    setSending(await sendSwitch().catch(() => null));
    setPool(await draftableProspects().catch(() => []));
    setLoading(false);
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!flash) return undefined;
    const t = setTimeout(() => setFlash(null), 5000);
    return () => clearTimeout(t);
  }, [flash]);

  const waiting = useMemo(() => rows.filter((r) => r.status === 'draft_review'), [rows]);
  const ready = useMemo(() => rows.filter((r) => r.status === 'approved'), [rows]);

  function startEdit(p) {
    setEditing(p.id);
    setDraft({ subject: p.draft_subject || '', body: p.draft_body || '' });
  }

  async function act(p, what) {
    setBusy(p.id);
    try {
      if (what === 'save') {
        const changed = draft.subject !== p.draft_subject || draft.body !== p.draft_body;
        await saveDraft(p.id, draft.subject, draft.body, changed);
        setEditing(null);
        setFlash(changed ? 'Saved your edit.' : 'Saved.');
      }
      if (what === 'approve') { await approveDraft(p.id); setFlash('Approved — the sender will pick it up.'); }
      if (what === 'skip') { await skipDraft(p.id); setFlash('Skipped. Nothing will be sent.'); }
      if (what === 'send') {
        if (!window.confirm(`Send this email to ${p.contact_name || p.company_name} now?\n\n${bestEmail(p).email}`)) {
          setBusy(null); return;
        }
        await approveAndSend(p.id);
        setFlash(`Sent to ${bestEmail(p).email}.`);
      }
      await load();
    } catch (e) {
      setFlash(`${what} failed: ${e.message}`);
    } finally { setBusy(null); }
  }

  return (
    <>
      <div className="metrics">
        <div className="metric"><div className="v">{waiting.length}</div><div className="l">Drafts to read</div></div>
        <div className="metric"><div className="v">{ready.length}</div><div className="l">Approved, not yet sent</div></div>
        <div className="metric">
          <div className="v">{budget ? budget.left : '—'}</div>
          <div className="l">Sends left today{budget ? ` of ${budget.cap}` : ''}</div>
        </div>
        {/* The allowance says what MAY go out. This says what actually did -
            the distinction the 2026-08-11 outage turned on. */}
        <div className="metric">
          <div className="v">{health ? health.delivered : '—'}</div>
          <div className="l">Delivered, last 24h</div>
        </div>
      </div>

      {/* A sender that is failing must never look like a sender that is idle. */}
      {health && (health.failed > 0 || health.blocked > 0) && (
        <div className="card ob-alarm">
          <div>
            <b>
              {health.failed > 0
                ? `${health.failed} send${health.failed === 1 ? '' : 's'} failed in the last 24 hours`
                : `${health.blocked} prospect${health.blocked === 1 ? '' : 's'} parked after repeated send failures`}
            </b>
            <div className="muted">
              {health.delivered === 0 && health.failed > 0
                ? 'Nothing has been delivered in that time. Treat the sender as down.'
                : 'Some mail is getting through, but not all of it.'}
              {health.lastError ? ` Last error: ${health.lastError}` : ''}
            </div>
            {health.blocked > 0 && health.failed > 0 && (
              <div className="muted">
                {health.blocked} prospect{health.blocked === 1 ? ' is' : 's are'} parked at
                {' '}<code>send_blocked</code> after three consecutive failures.
              </div>
            )}
          </div>
        </div>
      )}

      <div className={`card ob-switch ${sending ? 'on' : 'off'}`}>
        <div>
          <b>Automatic sending is {sending === null ? '…' : sending ? 'ON' : 'OFF'}</b>
          <div className="muted">
            {sending
              ? 'W2s sends approved drafts on its own, 08:00–17:00 PT weekdays, one at a time, up to the daily cap.'
              : 'Approved drafts wait. Approve & send still works — a click is your authorisation.'}
          </div>
        </div>
        <span className="spacer" />
        <button
          className={sending ? 'rowbtn mk-danger' : 'rowbtn primary'}
          disabled={sending === null || busy === 'switch'}
          onClick={async () => {
            const next = !sending;
            if (next && !window.confirm('Turn automatic sending ON?\n\nApproved drafts will start going out without further clicks.')) return;
            setBusy('switch');
            try { await setSendSwitch(next); setSending(next); setFlash(next ? 'Automatic sending is on.' : 'Automatic sending is off.'); }
            catch (e) { setFlash(`Could not change it: ${e.message}`); }
            finally { setBusy(null); }
          }}
        >
          {sending ? 'Turn sending off' : 'Turn sending on'}
        </button>
      </div>

      {flash && <div className="notice">{flash}</div>}

      {canDraft && pool.length > 0 && (
        <div className="card">
          <h3 style={{ padding: '13px 16px 0', margin: 0 }}>
            Write a draft — {pool.length} verified decision-maker{pool.length === 1 ? '' : 's'} with nothing written yet
          </h3>
          <div className="muted" style={{ padding: '4px 16px 10px', fontSize: '12.5px' }}>
            Nothing is approved by writing a draft. You read it first, then decide.
          </div>
          <table>
            <tbody>
              {pool.map((p) => {
                const em = bestEmail(p); const ph = bestPhone(p);
                return (
                  <tr key={p.id}>
                    <td><b>{p.company_name}</b><div className="muted">{VERTICAL[p.vertical] || p.vertical}</div></td>
                    <td>{p.contact_name || '—'}<div className="muted">{p.contact_title || ''}</div></td>
                    <td>{em.email}<div className="muted">{em.kind}</div></td>
                    <td>{ph.phone || '—'}<div className="muted">{ph.kind}</div></td>
                    <td style={{ width: '1%', whiteSpace: 'nowrap' }}>
                      <button className="rowbtn primary" disabled={busy === p.id}
                        onClick={async () => {
                          setBusy(p.id);
                          try {
                            await draftFor(p.id);
                            setFlash('Writing… the draft appears here in under a minute.');
                            for (let i = 0; i < 12; i++) {
                              await new Promise((r) => setTimeout(r, 6000));
                              const { data } = await supabase.from('sanaku_prospects')
                                .select('draft_body').eq('id', p.id).maybeSingle();
                              if (data && data.draft_body) { setFlash('Draft ready — read it below.'); break; }
                            }
                            await load();
                          } catch (e) { setFlash(`Could not draft: ${e.message}`); }
                          finally { setBusy(null); }
                        }}>
                        {busy === p.id ? 'Writing…' : 'Write draft'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {loading ? <div className="card"><div className="empty">Loading…</div></div>
        : rows.length === 0 ? (
          <div className="card"><div className="empty">
            No drafts waiting. Use “Write draft” above to see an email before you commit to anything.
          </div></div>
        ) : rows.map((p) => {
          const em = bestEmail(p);
          const ph = bestPhone(p);
          const isEditing = editing === p.id;
          const warn = (p.notes || '').startsWith('DRAFT WARNINGS:') ? p.notes.replace('DRAFT WARNINGS:', '').trim() : null;
          return (
            <div className="card mk" key={p.id}>
              <div className="mk-head">
                <span className={`pill status-${p.status === 'approved' ? 'won' : 'queued'}`}>
                  {p.status === 'approved' ? 'approved' : 'needs reading'}
                </span>
                <span className="pill t2">{STEP[p.draft_step] || 'Opener'}</span>
                <b className="mk-title">{p.company_name}</b>
                <span className="spacer" />
                <span className="muted mk-meta">
                  {VERTICAL[p.vertical] || p.vertical} · {day(p.draft_generated_at)}
                </span>
              </div>

              <div className="mk-body">
                <div className="ob-who">
                  <div><span className="muted">To</span> <b>{p.contact_name || '(no name)'}</b>
                    {p.contact_title ? <span className="muted"> · {p.contact_title}</span> : null}</div>
                  <div>
                    <span className="muted">Email</span> <b>{em.email || '—'}</b>
                    <span className={`pill ${em.kind === 'shared inbox' ? 'no' : 'yes'}`}>{em.kind}</span>
                    {p.email_verified ? <span className="pill yes">verified</span> : <span className="pill no">unverified</span>}
                  </div>
                  <div>
                    <span className="muted">Phone</span> <b>{ph.phone || '—'}</b>
                    <span className="pill t3">{ph.kind}</span>
                  </div>
                </div>

                {warn && <div className="ob-warn"><b>Check before sending:</b> {warn}</div>}

                {isEditing ? (
                  <div className="mk-edit">
                    <label>Subject<input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} /></label>
                    <label>Body<textarea rows={14} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} /></label>
                  </div>
                ) : (
                  <div className="ob-mail">
                    <div className="ob-subject">{p.draft_subject}</div>
                    <p className="mk-caption">{p.draft_body}</p>
                  </div>
                )}
              </div>

              <div className="mk-actions">
                {isEditing ? (
                  <>
                    <button className="rowbtn primary" disabled={busy === p.id} onClick={() => act(p, 'save')}>Save</button>
                    <button className="rowbtn" onClick={() => setEditing(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    {canSend && (
                      <button className="rowbtn primary" disabled={busy === p.id || !em.email || !p.email_verified}
                        title={!p.email_verified ? 'This address has not been verified — it will not send' : ''}
                        onClick={() => act(p, 'send')}>
                        {busy === p.id ? 'Sending…' : 'Approve & send'}
                      </button>
                    )}
                    {p.status !== 'approved' && (
                      <button className="rowbtn" disabled={busy === p.id} onClick={() => act(p, 'approve')}>Approve only</button>
                    )}
                    <button className="rowbtn" onClick={() => startEdit(p)}>Edit</button>
                    <span className="spacer" />
                    <button className="rowbtn mk-danger" disabled={busy === p.id} onClick={() => act(p, 'skip')}>Skip</button>
                  </>
                )}
              </div>
            </div>
          );
        })}
    </>
  );
}
