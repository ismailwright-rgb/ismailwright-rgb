import { useEffect, useState } from 'react';
import { supabase } from './supabase.js';
import Statements from './Statements.jsx';

const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const monthStart = () => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; };
const monthLabel = () => new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });

/**
 * What each client owes this period, computed from the lead meter - never from
 * anything a client self-reports. Mirrors sanaku_period_due() in SQL.
 */
export default function Earnings() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const from = monthStart().toISOString();
    const [c, l] = await Promise.all([
      // is_demo excluded: the demo client used for sales calls has a retainer
      // on it so the portal looks real, and counting it here would quote you
      // revenue from a company that does not exist.
      supabase.from('sanaku_clients').select('*').eq('status', 'active').eq('is_demo', false).order('company_name'),
      supabase.from('sanaku_client_leads').select('client_id, qualified, after_hours, billable, reported_value, captured_at').gte('captured_at', from),
    ]);
    const leads = l.data || [];
    const out = (c.data || []).map((cl) => {
      const mine = leads.filter((x) => x.client_id === cl.id && x.billable !== false);
      const qualified = mine.filter((x) => x.qualified).length;
      const afterHours = mine.filter((x) => x.after_hours).length;
      const retainer = Number(cl.monthly_retainer || 0);
      const rawPerLead = Number(cl.per_lead_fee || 0) * qualified;
      const cap = cl.per_lead_monthly_cap == null ? Infinity : Number(cl.per_lead_monthly_cap);
      const perLead = Math.min(rawPerLead, cap);
      return {
        ...cl,
        captured: mine.length,
        qualified,
        afterHours,
        retainer,
        perLead,
        capped: rawPerLead > cap,
        rawPerLead,
        reportedValue: mine.reduce((s, x) => s + Number(x.reported_value || 0), 0),
        total: retainer + perLead,
      };
    });
    setRows(out);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const mrr = rows.reduce((s, r) => s + r.retainer, 0);
  const perLeadTotal = rows.reduce((s, r) => s + r.perLead, 0);
  const owed = rows.reduce((s, r) => s + r.total, 0);
  const capturedTotal = rows.reduce((s, r) => s + r.captured, 0);
  const afterHoursTotal = rows.reduce((s, r) => s + r.afterHours, 0);

  return (
    <>
      <div className="metrics">
        <div className="metric"><div className="v">{money(mrr)}</div><div className="l">Retainer MRR</div></div>
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
                    {money(r.perLead)}
                    {r.capped && <div className="muted">capped (raw {money(r.rawPerLead)})</div>}
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
