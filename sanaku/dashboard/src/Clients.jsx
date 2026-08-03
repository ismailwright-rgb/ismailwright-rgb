import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase.js';
import OnboardClient from './OnboardClient.jsx';
import Branding from './Branding.jsx';
import AddOnRequests from './AddOnRequests.jsx';
import StaffRequests from './StaffRequests.jsx';
import { invitePortalUser, manualInviteSteps } from './invite.js';

// Branding is set at onboarding, but onboarding happens once and logos change.
// This is the same component, saving straight back to the row.
function EditBranding({ client, onDone, onCancel }) {
  const [f, setF] = useState({
    brand_name: client.brand_name || '',
    brand_primary_color: client.brand_primary_color || '',
    brand_logo_url: client.brand_logo_url || '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    setBusy(true);
    setErr('');
    const { error } = await supabase
      .from('sanaku_clients')
      .update({
        brand_name: f.brand_name.trim() || client.company_name,
        brand_primary_color: f.brand_primary_color.trim() || null,
        brand_logo_url: f.brand_logo_url.trim() || null,
      })
      .eq('id', client.id);
    setBusy(false);
    if (error) return setErr(error.message);
    onDone();
  }

  return (
    <div className="onboard">
      <h3>Branding — {client.company_name}</h3>
      <Branding value={f} onChange={setF} clientId={client.id} />
      {err && <p className="formerr">{err}</p>}
      <div className="formactions">
        <button className="rowbtn primary" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Save branding'}
        </button>
        <button className="rowbtn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

const fmtMoney = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString('en-US'));

// Page 2 v1: roster, this-month lead performance, and the kill switch.
// Billing statements + change-request queue + health alerts land after
// client #1 exists (per the build order - "everything else can wait").
export default function Clients({ onPreview }) {
  const [clients, setClients] = useState([]);
  const [leadStats, setLeadStats] = useState({});
  const [loading, setLoading] = useState(true);
  const [onboarding, setOnboarding] = useState(false);
  const [branding, setBranding] = useState(null);
  const [notice, setNotice] = useState(null);   // { bad, text }

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

  async function inviteToPortal(client) {
    const email = window.prompt(
      `Invite someone at ${client.company_name} to their portal.\n\n` +
      `They get an email with a link to set a password, and see only their own ` +
      `leads, requests and statements — never your pricing or another client.`,
      ''
    );
    if (!email) return;
    setNotice({ bad: false, text: `Sending invite to ${email.trim()}…` });
    const res = await invitePortalUser({ email, clientId: client.id });
    if (res.ok) return setNotice({ bad: false, text: `Invite sent to ${email.trim()}.` });
    setNotice({
      bad: true,
      text: `Could not send the invite.\n\n${res.error}\n\n` +
        manualInviteSteps({ email: email.trim(), clientId: client.id, company: client.company_name }),
    });
  }


  // Churn keeps the record: leads, statements and history stay, the client
  // stops counting toward active clients and MRR, workflows stop, and portal
  // logins are revoked. This is what "they cancelled" actually means.
  async function endClient(client) {
    const going = client.status !== 'churned';
    if (!going) {
      const { error } = await supabase.from('sanaku_clients')
        .update({ status: 'active' }).eq('id', client.id);
      if (error) return setNotice({ bad: true, text: error.message });
      return load();
    }
    if (!window.confirm(
      `Close out ${client.company_name}?\n\n` +
      `· Workflows stop immediately\n` +
      `· Their portal logins are revoked\n` +
      `· They stop counting toward active clients and monthly retainers\n\n` +
      `Leads, statements and notes are KEPT — you can still bill for work already done, ` +
      `and you can reactivate them later.`
    )) return;

    const { error } = await supabase.from('sanaku_clients')
      .update({ status: 'churned', workflow_enabled: false }).eq('id', client.id);
    if (error) return setNotice({ bad: true, text: 'Could not close them out: ' + error.message });
    // Revoke portal access separately - leaving it is how an ex-client keeps
    // reading their dashboard for months after they stopped paying.
    const { error: e2 } = await supabase.from('sanaku_client_users')
      .delete().eq('client_id', client.id);
    setNotice({
      bad: !!e2,
      text: e2
        ? `${client.company_name} is closed out, but their portal logins could not be revoked: ${e2.message}`
        : `${client.company_name} closed out. Workflows stopped, portal access revoked, history kept.`,
    });
    load();
  }

  // Hard delete, for rows created by mistake. Refused once there is anything
  // worth keeping, because the cascade would take the leads and statements
  // with it and there is no undo.
  async function deleteClient(client) {
    const s = leadStats[client.id] || { total: 0 };
    const { count } = await supabase.from('sanaku_billing')
      .select('id', { count: 'exact', head: true }).eq('client_id', client.id);
    if (s.total > 0 || (count || 0) > 0) {
      return setNotice({
        bad: true,
        text: `${client.company_name} has ${s.total} lead(s) and ${count || 0} statement(s), so deleting `
            + `would destroy billing history that cannot be recovered.\n\n`
            + `Use "Close out" instead — it stops everything and revokes access but keeps the record.`,
      });
    }
    const typed = window.prompt(
      `Permanently delete ${client.company_name}? This cannot be undone.\n\n` +
      `Type the company name to confirm:`, '');
    if (typed?.trim() !== client.company_name) return;

    const { error } = await supabase.from('sanaku_clients').delete().eq('id', client.id);
    if (error) return setNotice({ bad: true, text: 'Delete failed: ' + error.message });
    setNotice({ bad: false, text: `${client.company_name} deleted.` });
    load();
  }

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
    // The demo client stays visible in the roster - you have to be able to
    // reset it - but it is a prop, so it counts toward nothing.
    const demo = new Set(clients.filter((c) => c.is_demo).map((c) => c.id));
    const active = clients.filter((c) => c.status === 'active' && !c.is_demo);
    const retainers = active.reduce((s, c) => s + Number(c.monthly_retainer || 0), 0);
    const leads = Object.entries(leadStats)
      .filter(([id]) => !demo.has(id))
      .reduce((s, [, x]) => s + x.total, 0);
    return { active: active.length, retainers, leads };
  }, [clients, leadStats]);

  return (
    <>
      <div className="metrics">
        <div className="metric"><div className="v">{totals.active}</div><div className="l">Active clients</div></div>
        <div className="metric"><div className="v">{fmtMoney(totals.retainers)}</div><div className="l">Monthly retainers</div></div>
        <div className="metric"><div className="v">{totals.leads}</div><div className="l">Leads captured this month</div></div>
      </div>

      {notice && (
        <div className={'card ' + (notice.bad ? 'warn' : 'highlight')}>
          <pre className="notice">{notice.text}</pre>
          <div className="formactions" style={{ padding: '0 18px 16px' }}>
            <button className="rowbtn" onClick={() => navigator.clipboard?.writeText(notice.text)}>
              Copy
            </button>
            <button className="rowbtn" onClick={() => setNotice(null)}>Dismiss</button>
          </div>
        </div>
      )}

      <StaffRequests clients={clients} onChanged={load} />

      <AddOnRequests clients={clients} onChanged={load} />

      {onboarding && (
        <div className="card" style={{ padding: 0 }}>
          <OnboardClient
            onDone={() => { setOnboarding(false); load(); }}
            onCancel={() => setOnboarding(false)}
          />
        </div>
      )}

      {branding && (
        <div className="card" style={{ padding: 0 }}>
          <EditBranding
            client={branding}
            onDone={() => { setBranding(null); load(); }}
            onCancel={() => setBranding(null)}
          />
        </div>
      )}

      <div className="card">
        <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingRight: 16 }}>
          <span>Client roster</span>
          {!onboarding && (
            <button className="rowbtn primary" onClick={() => setOnboarding(true)}>+ Onboard client</button>
          )}
        </h3>
        {loading ? <div className="empty">Loading…</div> : clients.length === 0 ? (
          <div className="empty">
            No clients yet — close the first demo, then hit <b>Onboard client</b>.
            Pricing rules for each vertical are enforced for you.
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
                      <b>
                        <i
                          className="brandchip"
                          style={{ background: c.brand_primary_color || 'var(--accent)' }}
                          title={c.brand_primary_color ? `Portal colour ${c.brand_primary_color}` : 'No brand colour set — portal uses Sanaku green'}
                        />
                        {c.company_name}
                      </b>
                      {c.is_demo && <span className="pill t2" style={{ marginLeft: 8 }}>demo</span>}
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
                      <button className="rowbtn" onClick={() => inviteToPortal(c)}>Invite</button>
                      {/* Shows exactly what they see - no second login needed,
                          which is also how the demo client gets filmed. */}
                      <button className="rowbtn" onClick={() => onPreview?.(c.id)}>Portal</button>
                      <button className="rowbtn" onClick={() => setBranding(c)}>Branding</button>
                      <button className="rowbtn" onClick={() => endClient(c)}>
                        {c.status === 'churned' ? 'Reactivate' : 'Close out'}
                      </button>
                      {c.status === 'churned' && (
                        <button className="rowbtn" onClick={() => deleteClient(c)}>Delete</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className="muted">
        Client requests appear above as they arrive. Statements are issued from the
        <b> Earnings</b> tab.
      </p>
    </>
  );
}
