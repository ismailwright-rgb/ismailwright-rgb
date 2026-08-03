import { useEffect, useState } from 'react';
import { supabase } from './supabase.js';
import Statements from './Statements.jsx';

const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const monthStart = () => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; };
const monthLabel = () => new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });

/**
 * What each client owes this period, computed from the lead meter - never from
 * anything a client self-reports.
 *
 * The money comes from sanaku_statements_for_period(), the same function
 * Statements issues from, because this screen used to total retainer + per-lead
 * and nothing else - it did not count add-on revenue at all, so it under-read
 * every client running a service. Lead counts and reported value stay local;
 * they are not billing figures.
 */
export default function Earnings() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const start = monthStart();
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
    const iso = (d) => d.toISOString().slice(0, 10);
    const [c, l, f] = await Promise.all([
      // is_demo excluded: the demo client used for sales calls has a retainer
      // on it so the portal looks real, and counting it here would quote you
      // revenue from a company that does not exist.
      supabase.from('sanaku_clients').select('*').eq('status', 'active').eq('is_demo', false).order('company_name'),
      supabase.from('sanaku_client_leads').select('client_id, qualified, after_hours, billable, reported_value, captured_at').gte('captured_at', start.toISOString()),
      supabase.rpc('sanaku_statements_for_period', { _start: iso(start), _end: iso(end) }),
    ]);
    const leads = l.data || [];
    const due = Object.fromEntries((f.data || []).map((r) => [r.client_id, r]));
    const out = (c.data || []).map((cl) => {
      const mine = leads.filter((x) => x.client_id === cl.id && x.billable !== false);
      const d = due[cl.id] || {};
      return {
        ...cl,
        captured: mine.length,
        qualified: mine.filter((x) => x.qualified).length,
        afterHours: mine.filter((x) => x.after_hours).length,
        retainer: Number(d.retainer_due || 0),
        perLead: Number(d.per_lead_due || 0),
        addons: Number(d.addons_due || 0),
        setup: Number(d.setup_due || 0),
        overage: Number(d.overage_due || 0),
        capped: d.capped === true,
        inTrial: d.in_trial === true,
        reportedValue: mine.reduce((s, x) => s + Number(x.reported_value || 0), 0),
        total: Number(d.total_due || 0),
      };
    });
    setRows(out);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  // Recurring means retainer PLUS the services they run. Counting the retainer
  // alone described a business smaller than it is.
  const mrr = rows.reduce((s, r) => s + r.retainer + r.addons, 0);
  const perLeadTotal = rows.reduce((s, r) => s + r.perLead, 0);
  const owed = rows.reduce((s, r) => s + r.total, 0);
  const capturedTotal = rows.reduce((s, r) => s + r.captured, 0);
  const afterHoursTotal = rows.reduce((s, r) => s + r.afterHours, 0);

  return (
    <>
      <div className="metrics">
        <div className="metric"><div className="v">{money(mrr)}</div><div className="l">Recurring MRR</div></div>
        <div className="metric"><div className="v">{money(perLeadTotal)}</div><div className="l">Per-lead fees ({monthLabel()})</div></div>
        <div className="metric"><div className="v">{money(owed)}</div><div className="l">Total due this period</div></div>
        <div className="metric"><div className="v">{capturedTotal}</div><div className="l">Leads captured</div></div>
        <div className="metric"><div className="v">{afterHoursTotal}</div><div className="l">…while they were closed</div></div>
      </div>

      <div className="card">
        <h3>What each client owes — {monthLabel()}</h3>
        {loading ? <div className="empty">Loading…</div> : rows.length === 0 ? (
          <div className="empty">No active clients yet. Earnings appear here the moment one is onboarded.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th className="hide-m">Structure</th>
                <th>Captured</th>
                <th>Qualified</th>
                <th className="hide-m">After hours</th>
                <th>Retainer</th>
                <th>Services</th>
                <th>Per-lead</th>
                <th>Total due</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <b>{r.company_name}</b>
                    <div className="muted">{r.vertical}</div>
                  </td>
                  <td className="hide-m muted">
                    {r.pricing_model === 'retainer_plus_per_lead'
                      ? `${money(r.monthly_retainer)}/mo + ${money(r.per_lead_fee)}/lead`
                      : r.pricing_model === 'retainer_plus_rev_share'
                      ? `${money(r.monthly_retainer)}/mo + ${r.rev_share_pct}%`
                      : `${money(r.monthly_retainer)}/mo flat`}
                  </td>
                  <td className="num">{r.captured}</td>
                  <td className="num"><b>{r.qualified}</b></td>
                  <td className="hide-m num">{r.afterHours}</td>
                  <td className="num">{money(r.retainer)}</td>
                  <td className="num">
                    {money(r.addons)}
                    {r.inTrial && <div className="muted">in trial</div>}
                    {r.setup > 0 && <div className="muted">+{money(r.setup)} setup</div>}
                    {r.overage > 0 && <div className="muted">+{money(r.overage)} overage</div>}
                  </td>
                  <td className="num">
                    {money(r.perLead)}
                    {r.capped && <div className="muted">at monthly cap</div>}
                  </td>
                  <td className="num"><b>{money(r.total)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="muted">
        Billed from leads our system captured and timestamped — never from client-reported revenue.
        Per-lead totals respect each client's monthly cap.
        {rows.some((r) => r.reportedValue > 0) && (
          <> Client-confirmed converted value this period: <b>{money(rows.reduce((s, r) => s + r.reportedValue, 0))}</b> (renewal ammunition, not a billing input).</>
        )}
      </p>
      <Statements />
    </>
  );
}
