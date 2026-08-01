import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase.js';

const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const day = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const time = (d) => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const startOfMonth = (offset = 0) => { const d = new Date(); d.setMonth(d.getMonth() + offset, 1); d.setHours(0, 0, 0, 0); return d; };

/**
 * What a client sees. Reads sanaku_my_client (a filtered view - the clients
 * table itself is staff-only, so retainer/per-lead pricing never reaches the
 * browser) plus their own leads, requests and statements, all scoped by RLS.
 */
export default function Portal({ onSignOut }) {
  const [client, setClient] = useState(null);
  const [leads, setLeads] = useState([]);
  const [requests, setRequests] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [tab, setTab] = useState('overview');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const since = startOfMonth(-2).toISOString();
    const [c, l, r, b] = await Promise.all([
      supabase.from('sanaku_my_client').select('*').limit(1),
      supabase.from('sanaku_client_leads').select('*').gte('captured_at', since).order('captured_at', { ascending: false }),
      supabase.from('sanaku_change_requests').select('*').order('submitted_at', { ascending: false }),
      supabase.from('sanaku_billing').select('*').order('period_start', { ascending: false }).limit(12),
    ]);
    setClient((c.data || [])[0] || null);
    setLeads(l.data || []);
    setRequests(r.data || []);
    setInvoices(b.data || []);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

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
          Your account isn't linked to a business yet. Contact us and we'll sort it out.
        </div></div>
        <button className="rowbtn" onClick={onSignOut}>Sign out</button>
      </div>
    );
  }

  return (
    <>
      <div className="topbar">
        <span className="brand">{brand}</span>
        <nav>
          {[['overview', 'Overview'], ['leads', 'Leads'], ['requests', 'Requests'], ['billing', 'Billing']].map(([k, l]) => (
            <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
          ))}
        </nav>
        <span className="spacer" />
        <button className="signout" onClick={onSignOut}>Sign out</button>
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

        {tab === 'requests' && <Requests client={client} requests={requests} onSaved={load} />}

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
    </>
  );
}

function LeadTable({ leads, full }) {
  if (leads.length === 0) {
    return <div className="empty">No leads captured yet. They'll appear here the moment one comes in.</div>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>When</th><th>Contact</th><th className="hide-m">How</th>
          <th>Qualified</th>{full && <th className="hide-m">Outcome</th>}
        </tr>
      </thead>
      <tbody>
        {leads.map((l) => (
          <tr key={l.id}>
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
            </td>
            <td className="hide-m">{(l.channel || '').replace('_', ' ')}</td>
            <td>{l.qualified ? <span className="pill t1">yes</span> : <span className="pill t3">—</span>}</td>
            {full && <td className="hide-m muted">{l.outcome || '—'}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Requests({ client, requests, onSaved }) {
  const [text, setText] = useState('');
  const [priority, setPriority] = useState('normal');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (!text.trim()) return;
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
