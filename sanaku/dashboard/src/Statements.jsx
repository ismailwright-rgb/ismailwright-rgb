import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase.js';

const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const iso = (d) => d.toISOString().slice(0, 10);
const monthName = (d) => d.toLocaleString('en-US', { month: 'long', year: 'numeric' });

/** First and last day of the month `back` months ago (0 = this month). */
function period(back) {
  const s = new Date();
  s.setDate(1);
  s.setMonth(s.getMonth() - back);
  s.setHours(0, 0, 0, 0);
  const e = new Date(s);
  e.setMonth(e.getMonth() + 1);
  e.setDate(0);
  return { start: s, end: e, label: monthName(s) };
}

/**
 * Turning a month's activity into a statement the client can see.
 *
 * Earnings shows what a period is worth; this is what makes it real - without
 * it sanaku_billing is never written, the portal's Billing tab is permanently
 * empty, and there is no way to bill anyone from the system at all.
 *
 * The total is computed from the lead meter and the frozen add-on terms, never
 * from anything a client self-reports.
 */
export default function Statements() {
  const [back, setBack] = useState(1);              // default: last complete month
  const [clients, setClients] = useState([]);
  const [leads, setLeads] = useState([]);
  const [addons, setAddons] = useState([]);
  const [issued, setIssued] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');

  const p = useMemo(() => period(back), [back]);

  async function load() {
    setLoading(true);
    const [c, l, a, b] = await Promise.all([
      supabase.from('sanaku_clients').select('*').eq('status', 'active').order('company_name'),
      supabase.from('sanaku_client_leads')
        .select('client_id, qualified, billable, captured_at')
        .gte('captured_at', p.start.toISOString())
        .lt('captured_at', new Date(p.end.getTime() + 86400000).toISOString()),
      supabase.from('sanaku_client_addons').select('client_id, monthly_fee, status').eq('status', 'active'),
      supabase.from('sanaku_billing').select('*').eq('period_start', iso(p.start)),
    ]);
    setClients(c.data || []);
    setLeads(l.data || []);
    setAddons(a.data || []);
    setIssued(b.data || []);
    setLoading(false);
  }
  useEffect(() => { load(); }, [back]);

  function figuresFor(c) {
    const mine = leads.filter((x) => x.client_id === c.id && x.billable !== false);
    const qualified = mine.filter((x) => x.qualified).length;
    const retainer = Number(c.monthly_retainer || 0);
    const cap = c.per_lead_monthly_cap == null ? Infinity : Number(c.per_lead_monthly_cap);
    const perLead = Math.min(Number(c.per_lead_fee || 0) * qualified, cap);
    const addon = addons.filter((x) => x.client_id === c.id)
      .reduce((s, x) => s + Number(x.monthly_fee || 0), 0);
    return {
      captured: mine.length, qualified, retainer, perLead, addon,
      total: retainer + perLead + addon,
      capped: Number(c.per_lead_fee || 0) * qualified > cap,
    };
  }

  const statementFor = (id) => issued.find((s) => s.client_id === id);

  async function issue(c) {
    const f = figuresFor(c);
    const msg =
      `Issue ${p.label} statement for ${c.company_name}?\n\n` +
      `Retainer        ${money(f.retainer)}\n` +
      `Qualified leads ${f.qualified} → ${money(f.perLead)}${f.capped ? ' (capped)' : ''}\n` +
      (f.addon ? `Add-ons         ${money(f.addon)}\n` : '') +
      `------------------------------\n` +
      `Total           ${money(f.total)}\n\n` +
      `It saves as a DRAFT. Nothing is sent and no card is charged — you still ` +
      `invoice them however you normally do.`;
    if (!window.confirm(msg)) return;

    setBusy(c.id);
    const { error } = await supabase.from('sanaku_billing').insert({
      client_id: c.id,
      period_start: iso(p.start),
      period_end: iso(p.end),
      retainer_due: f.retainer,
      leads_captured: f.captured,
      total_due: f.total,
      status: 'draft',
    });
    setBusy('');
    if (error) return alert('Could not save the statement: ' + error.message);
    load();
  }

  async function setStatus(s, status) {
    const patch = { status };
    if (status === 'paid') patch.paid_at = new Date().toISOString();
    const { error } = await supabase.from('sanaku_billing').update(patch).eq('id', s.id);
    if (error) return alert('Update failed: ' + error.message);
    load();
  }

  if (loading) return <div className="card"><div className="empty">Loading…</div></div>;

  const grand = clients.reduce((s, c) => s + figuresFor(c).total, 0);

  return (
    <div className="card">
      <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingRight: 16 }}>
        <span>Statements · {p.label} · {money(grand)}</span>
        <span>
          <button className={'rowbtn' + (back === 1 ? ' primary' : '')} onClick={() => setBack(1)}>Last month</button>
          <button className={'rowbtn' + (back === 0 ? ' primary' : '')} onClick={() => setBack(0)}>This month</button>
        </span>
      </h3>

      {clients.length === 0 ? (
        <div className="empty">No active clients yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Client</th><th className="hide-m">Leads</th><th className="hide-m">Qualified</th>
              <th>Retainer</th><th className="hide-m">Per lead</th><th className="hide-m">Add-ons</th>
              <th>Total</th><th>Statement</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => {
              const f = figuresFor(c);
              const s = statementFor(c.id);
              return (
                <tr key={c.id}>
                  <td><b>{c.company_name}</b></td>
                  <td className="hide-m num">{f.captured}</td>
                  <td className="hide-m num">{f.qualified}</td>
                  <td className="num">{money(f.retainer)}</td>
                  <td className="hide-m num">
                    {money(f.perLead)}
                    {f.capped && <div className="muted">at cap</div>}
                  </td>
                  <td className="hide-m num">{f.addon ? money(f.addon) : '—'}</td>
                  <td className="num"><b>{money(f.total)}</b></td>
                  <td>
                    {!s ? (
                      <button className="rowbtn primary" disabled={busy === c.id} onClick={() => issue(c)}>
                        {busy === c.id ? 'Saving…' : 'Issue'}
                      </button>
                    ) : (
                      <>
                        <span className={'pill status-' + (s.status === 'paid' ? 'won' : s.status === 'overdue' ? 'lost' : 'new')}>
                          {s.status}
                        </span>
                        {s.status === 'draft' && <button className="rowbtn" onClick={() => setStatus(s, 'sent')}>Mark sent</button>}
                        {s.status === 'sent' && <button className="rowbtn primary" onClick={() => setStatus(s, 'paid')}>Mark paid</button>}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p className="muted" style={{ padding: '12px 16px 14px' }}>
        Issuing writes the statement to their portal's Billing tab. It does not send
        an email and does not take payment — this is the record, not the invoice.
        Per-lead is counted from qualified leads only, and stops at the monthly cap.
      </p>
    </div>
  );
}
