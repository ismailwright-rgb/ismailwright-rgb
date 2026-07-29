import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase.js';

const fmtMoney = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString('en-US'));

// Page 2 v1: roster, this-month lead performance, and the kill switch.
// Billing statements + change-request queue + health alerts land after
// client #1 exists (per the build order - "everything else can wait").
export default function Clients() {
  const [clients, setClients] = useState([]);
  const [leadStats, setLeadStats] = useState({});
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const [c, l] = await Promise.all([
      supabase.from('sanaku_clients').select('*').order('onboarded_at', { ascending: true }),
      supabase.from('sanaku_client_leads').select('client_id, after_hours, qualified, reported_value, billable, captured_at')
        .gte('captured_at', monthStart.toISOString()),
    ]);
    setClients(c.data || []);
    const stats = {};
    for (const lead of l.data || []) {
      const s = stats[lead.client_id] || { total: 0, afterHours: 0, qualified: 0, value: 0 };
      s.total++;
      if (lead.after_hours) s.afterHours++;
      if (lead.qualified) s.qualified++;
      s.value += Number(lead.reported_value || 0);
      stats[lead.client_id] = s;
    }
    setLeadStats(stats);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function toggleKillSwitch(client) {
    const turningOff = client.workflow_enabled;
    const msg = turningOff
      ? `PAUSE all workflows for ${client.company_name}?\n\nTheir automations stop immediately. No data is deleted.`
      : `Re-enable workflows for ${client.company_name}?`;
    if (!window.confirm(msg)) return;
    const { error } = await supabase
      .from('sanaku_clients')
      .update({ workflow_enabled: !client.workflow_enabled })
      .eq('id', client.id);
    if (error) alert('Update failed: ' + error.message);
    load();
  }

  const totals = useMemo(() => {
    const active = clients.filter((c) => c.status === 'active');
    const retainers = active.reduce((s, c) => s + Number(c.monthly_retainer || 0), 0);
    const leads = Object.values(leadStats).reduce((s, x) => s + x.total, 0);
    return { active: active.length, retainers, leads };
  }, [clients, leadStats]);

  return (
    <>
      <div className="metrics">
        <div className="metric"><div className="v">{totals.active}</div><div className="l">Active clients</div></div>
        <div className="metric"><div className="v">{fmtMoney(totals.retainers)}</div><div className="l">Monthly retainers</div></div>
        <div className="metric"><div className="v">{totals.leads}</div><div className="l">Leads captured this month</div></div>
      </div>

      <div className="card">
        <h3>Client roster</h3>
        {loading ? <div className="empty">Loading…</div> : clients.length === 0 ? (
          <div className="empty">
            No clients yet. Close the first demo, insert a row in <code>sanaku_clients</code>, and this page comes alive.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Client</th><th className="hide-m">Pricing</th><th>Leads (mo)</th>
                <th className="hide-m">After-hours</th><th className="hide-m">Qualified</th>
                <th>Status</th><th>Workflows</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => {
                const s = leadStats[c.id] || { total: 0, afterHours: 0, qualified: 0, value: 0 };
                return (
                  <tr key={c.id}>
                    <td>
                      <b>{c.company_name}</b>
                      <div className="muted">{c.vertical} · since {c.onboarded_at || '—'}</div>
                    </td>
                    <td className="hide-m">
                      {c.pricing_model || '—'}
                      <div className="muted">
                        {fmtMoney(c.monthly_retainer)}/mo
                        {c.per_lead_fee ? ` + ${fmtMoney(c.per_lead_fee)}/lead` : ''}
                        {c.rev_share_pct ? ` + ${c.rev_share_pct}% rev share` : ''}
                      </div>
                    </td>
                    <td className="num"><b>{s.total}</b></td>
                    <td className="hide-m num">{s.afterHours}</td>
                    <td className="hide-m num">{s.total ? Math.round((s.qualified / s.total) * 100) + '%' : '—'}</td>
                    <td><span className={'pill ' + (c.status === 'active' ? 'status-replied' : 'status-lost')}>{c.status}</span></td>
                    <td>
                      <button
                        className={'rowbtn' + (c.workflow_enabled ? '' : ' primary')}
                        onClick={() => toggleKillSwitch(c)}
                      >
                        {c.workflow_enabled ? 'Pause' : 'Enable'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className="muted">
        Billing statements, the change-request queue, and health alerts ship once the first
        client is live — the tables (<code>sanaku_billing</code>, <code>sanaku_change_requests</code>) already exist.
      </p>
    </>
  );
}
