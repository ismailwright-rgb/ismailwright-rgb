import { Fragment, useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase.js';
import AddOns from './AddOns.jsx';

const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const day = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const time = (d) => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const startOfMonth = (offset = 0) => { const d = new Date(); d.setMonth(d.getMonth() + offset, 1); d.setHours(0, 0, 0, 0); return d; };

// Exactly the columns sanaku_my_client exposes. Staff previewing a portal read
// sanaku_clients directly - RLS lets them - so this list is the only thing
// standing between a preview and the retainer being on screen during a demo.
// Keep it identical to the view in migration-004.
const PORTAL_COLUMNS =
  'id, company_name, vertical, status, onboarded_at, brand_name, brand_logo_url, ' +
  'brand_primary_color, brand_accent_color, sending_number, workflow_enabled';

/**
 * What a client sees. Reads sanaku_my_client (a filtered view - the clients
 * table itself is staff-only, so retainer/per-lead pricing never reaches the
 * browser) plus their own leads, requests and statements, all scoped by RLS.
 *
 * `previewClientId` renders someone else's portal for staff - so a client's
 * dashboard can be shown on a sales call without a second login, and so the
 * demo client can be filmed. A client never passes it: their session cannot
 * read another client's rows regardless. Everything RLS would have scoped is
 * scoped by hand in that mode, because staff policies do not scope anything.
 */
export default function Portal({ onSignOut, previewClientId, onExitPreview }) {
  const [client, setClient] = useState(null);
  const [leads, setLeads] = useState([]);
  const [requests, setRequests] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [tab, setTab] = useState('overview');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const since = startOfMonth(-2).toISOString();
    // Staff RLS returns EVERY client's leads, so a preview has to filter by
    // hand. Without this, previewing one client shows you all of them.
    const scope = (q) => (previewClientId ? q.eq('client_id', previewClientId) : q);
    const [c, l, r, b] = await Promise.all([
      previewClientId
        ? supabase.from('sanaku_clients').select(PORTAL_COLUMNS).eq('id', previewClientId).limit(1)
        : supabase.from('sanaku_my_client').select('*').limit(1),
      scope(supabase.from('sanaku_client_leads').select('*').gte('captured_at', since)).order('captured_at', { ascending: false }),
      scope(supabase.from('sanaku_change_requests').select('*')).order('submitted_at', { ascending: false }),
      scope(supabase.from('sanaku_billing').select('*')).order('period_start', { ascending: false }).limit(12),
    ]);
    setClient((c.data || [])[0] || null);
    setLeads(l.data || []);
    setRequests(r.data || []);
    setInvoices(b.data || []);
    setLoading(false);
  }
  useEffect(() => { load(); }, [previewClientId]);

  const stats = useMemo(() => {
    const thisMonth = startOfMonth().getTime();
    const lastMonth = startOfMonth(-1).getTime();
    const cur = leads.filter((x) => new Date(x.captured_at).getTime() >= thisMonth);
    const prev = leads.filter((x) => {
      const t = new Date(x.captured_at).getTime();
      return t >= lastMonth && t < thisMonth;
    });
    const pct = prev.length ? Math.round(((cur.length - prev.length) / prev.length) * 100) : null;
    return {
      captured: cur.length,
      afterHours: cur.filter((x) => x.after_hours).length,
      qualified: cur.filter((x) => x.qualified).length,
      qualRate: cur.length ? Math.round((cur.filter((x) => x.qualified).length / cur.length) * 100) : 0,
      prev: prev.length,
      pct,
    };
  }, [leads]);

  const brand = client?.brand_name || client?.company_name || 'Your dashboard';

  if (loading) return <div className="page"><div className="empty">Loading…</div></div>;
  if (!client) {
    return (
      <div className="page">
        <div className="card"><div className="empty">
          {previewClientId
            ? "That client's row could not be read — it may have been deleted."
            : "Your account isn't linked to a business yet. Contact us and we'll sort it out."}
        </div></div>
        <button className="rowbtn" onClick={previewClientId ? onExitPreview : onSignOut}>
          {previewClientId ? 'Close preview' : 'Sign out'}
        </button>
      </div>
    );
  }

  // The portal wears the client's colour, not ours. Falls back to Sanaku green.
  const brandColor = client.brand_primary_color || '#0d6b42';

  return (
    <div className="portal" style={{ '--brand': brandColor }}>
      <div className="topbar">
        {client.brand_logo_url
          ? <img className="brandlogo" src={client.brand_logo_url} alt={brand} />
          : <span className="brand">{brand}</span>}
        <nav>
          {[['overview', 'Overview'], ['leads', 'Leads'], ['addons', 'Add services'], ['requests', 'Requests'], ['billing', 'Billing']].map(([k, l]) => (
            <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
          ))}
        </nav>
        <span className="spacer" />
        {previewClientId
          ? <button className="signout" onClick={onExitPreview}>Close preview</button>
          : <button className="signout" onClick={onSignOut}>Sign out</button>}
      </div>

      <div className="page">
        {tab === 'overview' && (
          <>
            <div className="metrics">
              <div className="metric"><div className="v">{stats.captured}</div><div className="l">Leads captured this month</div></div>
              <div className="metric"><div className="v">{stats.afterHours}</div><div className="l">…while you were closed</div></div>
              <div className="metric"><div className="v">{stats.qualified}</div><div className="l">Qualified</div></div>
              <div className="metric"><div className="v">{stats.qualRate}%</div><div className="l">Qualified rate</div></div>
              <div className="metric">
                <div className="v">{stats.pct === null ? '—' : (stats.pct > 0 ? '+' : '') + stats.pct + '%'}</div>
                <div className="l">vs last month ({stats.prev})</div>
              </div>
            </div>

            {stats.afterHours > 0 && (
              <div className="card highlight">
                <p>
                  <b>{stats.afterHours} of your {stats.captured} leads this month came in while your office was closed.</b>{' '}
                  Those are the ones that used to go to voicemail.
                </p>
              </div>
            )}

            <div className="card">
              <h3>Latest leads</h3>
              <LeadTable leads={leads.slice(0, 8)} />
            </div>

            {client.workflow_enabled === false && (
              <div className="card warn"><p>Your automations are currently paused. Get in touch when you'd like them back on.</p></div>
            )}
          </>
        )}

        {tab === 'leads' && (
          <div className="card">
            <h3>Every lead we've captured for you</h3>
            <LeadTable leads={leads} full />
          </div>
        )}

        {tab === 'addons' && <AddOns client={client} preview={!!previewClientId} />}

        {tab === 'requests' && <Requests client={client} requests={requests} onSaved={load} preview={!!previewClientId} />}

        {tab === 'billing' && (
          <div className="card">
            <h3>Statements</h3>
            {invoices.length === 0 ? (
              <div className="empty">No statements yet.</div>
            ) : (
              <table>
                <thead><tr><th>Period</th><th>Leads</th><th>Total</th><th>Status</th></tr></thead>
                <tbody>
                  {invoices.map((i) => (
                    <tr key={i.id}>
                      <td>{day(i.period_start)} – {day(i.period_end)}</td>
                      <td className="num">{i.leads_captured ?? '—'}</td>
                      <td className="num"><b>{money(i.total_due)}</b></td>
                      <td><span className={'pill status-' + (i.status === 'paid' ? 'won' : i.status === 'overdue' ? 'lost' : 'new')}>{i.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const mmss = (s) => {
  if (s == null) return null;
  return Math.floor(s / 60) + 'm ' + String(Math.round(s % 60)).padStart(2, '0') + 's';
};

// What the phone agent left behind: the recording, its own summary, and the
// conversation. Worth showing in full - a client who can listen to the call
// stops wondering whether the lead was real, which is the whole argument for
// the add-on.
function CallDetail({ lead }) {
  const turns = Array.isArray(lead.transcript) ? lead.transcript : [];
  return (
    <div className="calldetail">
      {lead.recording_url && (
        <audio controls preload="none" src={lead.recording_url} className="callaudio">
          Your browser can't play this recording.{' '}
          <a href={lead.recording_url}>Download it instead.</a>
        </audio>
      )}
      {lead.call_summary && <p className="callsummary">{lead.call_summary}</p>}
      {turns.length > 0 && (
        <div className="calltranscript">
          {turns.map((t, i) => (
            <p key={i} className={t.role === 'user' ? 'them' : 'agent'}>
              <span className="who">{t.role === 'user' ? 'Caller' : 'Agent'}</span>
              {t.message}
            </p>
          ))}
        </div>
      )}
      {!lead.recording_url && turns.length === 0 && !lead.call_summary && (
        <p className="muted">No recording was kept for this call.</p>
      )}
    </div>
  );
}

function LeadTable({ leads, full }) {
  const [open, setOpen] = useState(null);
  if (leads.length === 0) {
    return <div className="empty">No leads captured yet. They'll appear here the moment one comes in.</div>;
  }
  const cols = full ? 5 : 4;
  return (
    <table>
      <thead>
        <tr>
          <th>When</th><th>Contact</th><th className="hide-m">How</th>
          <th>Qualified</th>{full && <th className="hide-m">Outcome</th>}
        </tr>
      </thead>
      <tbody>
        {leads.map((l) => {
          const isCall = l.channel === 'voice';
          const expanded = open === l.id;
          return (
            <Fragment key={l.id}>
              <tr>
                <td>
                  {time(l.captured_at)}
                  {l.after_hours && <div className="muted">after hours</div>}
                </td>
                <td>
                  {l.name || 'Unknown'}
                  <div className="muted">
                    {l.phone ? <a href={`tel:${String(l.phone).replace(/[^\d+]/g, '')}`}>{l.phone}</a> : ''}
                    {l.email ? ` · ${l.email}` : ''}
                  </div>
                  {/* Deliberately in this column and not under "How": that one
                      is hidden on phones, and a phone is where an owner checks
                      this. */}
                  {isCall && (
                    <button className="linkbtn" onClick={() => setOpen(expanded ? null : l.id)}>
                      {expanded ? 'Hide the call' : 'Listen to the call'}
                    </button>
                  )}
                </td>
                <td className="hide-m">
                  {isCall ? 'phone call' : (l.channel || '').replace('_', ' ')}
                  {isCall && mmss(l.duration_seconds) && (
                    <div className="muted">{mmss(l.duration_seconds)}</div>
                  )}
                </td>
                <td>{l.qualified ? <span className="pill t1">yes</span> : <span className="pill t3">—</span>}</td>
                {full && <td className="hide-m muted">{l.outcome || '—'}</td>}
              </tr>
              {isCall && expanded && (
                <tr className="detailrow">
                  <td colSpan={cols}><CallDetail lead={l} /></td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function Requests({ client, requests, onSaved, preview }) {
  const [text, setText] = useState('');
  const [priority, setPriority] = useState('normal');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (!text.trim()) return;
    // Staff RLS would happily insert this, putting a request you typed during
    // a demo into your own queue as though the client had asked for it.
    if (preview) return setErr('Preview only — this would file a real request against them.');
    setBusy(true); setErr('');
    // status/submitted_at are forced server-side; sending them would be ignored.
    const { error } = await supabase.from('sanaku_change_requests').insert({
      client_id: client.id,
      request: text.trim(),
      priority,
    });
    setBusy(false);
    if (error) return setErr(error.message);
    setText('');
    onSaved();
  }

  return (
    <>
      <div className="card">
        <form className="onboard" onSubmit={submit}>
          <h3>Ask us for something</h3>
          <label>What do you need?</label>
          <textarea
            rows="3"
            placeholder="Change the wording of the text customers get, add a second number, send me a weekly summary…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <label>How urgent?</label>
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="low">Whenever</option>
            <option value="normal">Normal</option>
            <option value="urgent">Urgent — something is broken</option>
          </select>
          {err && <p className="formerr">{err}</p>}
          <div className="formactions">
            <button className="rowbtn primary" disabled={busy}>{busy ? 'Sending…' : 'Send request'}</button>
          </div>
        </form>
      </div>

      <div className="card">
        <h3>Your requests</h3>
        {requests.length === 0 ? (
          <div className="empty">Nothing open.</div>
        ) : (
          <table>
            <thead><tr><th>Request</th><th className="hide-m">Priority</th><th>Status</th><th className="hide-m">Sent</th></tr></thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td>{r.request}</td>
                  <td className="hide-m">{r.priority}</td>
                  <td><span className={'pill status-' + (r.status === 'done' ? 'won' : r.status === 'in_progress' ? 'queued' : 'new')}>{r.status}</span></td>
                  <td className="hide-m muted">{day(r.submitted_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
