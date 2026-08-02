import { useEffect, useState } from 'react';
import { supabase } from './supabase.js';

const money = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString('en-US'));
const day = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');

/**
 * Pending add-on requests. Approving freezes the catalog terms onto the row
 * (the database does that), so a later price change cannot re-price a client
 * who signed up today.
 */
export default function AddOnRequests({ clients, onChanged }) {
  const [rows, setRows] = useState([]);
  const [catalog, setCatalog] = useState({});
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const [r, c] = await Promise.all([
      supabase.from('sanaku_client_addons').select('*').order('requested_at', { ascending: false }),
      supabase.from('sanaku_addons').select('*'),
    ]);
    setRows(r.data || []);
    setCatalog(Object.fromEntries((c.data || []).map((a) => [a.code, a])));
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const nameOf = (id) => clients.find((c) => c.id === id)?.company_name || 'Unknown client';

  async function decide(row, status) {
    const a = catalog[row.addon_code] || {};
    if (status === 'approved') {
      const msg =
        `Approve ${a.name || row.addon_code} for ${nameOf(row.client_id)}?\n\n` +
        `${money(a.monthly_fee)}/month` +
        (a.setup_fee ? ` plus ${money(a.setup_fee)} setup` : '') +
        (a.included_minutes != null ? `, ${a.included_minutes} min included` : '') +
        (a.per_lead_fee != null ? `, ${money(a.per_lead_fee)}/qualified lead` : '') +
        `\n\nThese terms get frozen onto their account. Amend the agreement before you provision anything.`;
      if (!window.confirm(msg)) return;
    }
    const note = status === 'declined' ? window.prompt('Reason (they see nothing, this is for you):', '') : null;
    const { error } = await supabase
      .from('sanaku_client_addons')
      .update({ status, staff_note: note, decided_at: new Date().toISOString() })
      .eq('id', row.id);
    if (error) return alert('Update failed: ' + error.message);
    load();
    onChanged?.();
  }

  const pending = rows.filter((r) => r.status === 'requested');
  const live = rows.filter((r) => r.status === 'approved' || r.status === 'active');

  const mrr = live.reduce((s, r) => s + Number(r.monthly_fee || 0), 0);

  if (loading) return null;
  if (rows.length === 0) return null;

  return (
    <>
      {pending.length > 0 && (
        <div className="card warn">
          <h3>Add-on requests ({pending.length})</h3>
          <table>
            <thead>
              <tr><th>Client</th><th>Wants</th><th className="hide-m">Asked</th><th className="hide-m">Their note</th><th>Worth</th><th></th></tr>
            </thead>
            <tbody>
              {pending.map((r) => {
                const a = catalog[r.addon_code] || {};
                return (
                  <tr key={r.id}>
                    <td><b>{nameOf(r.client_id)}</b></td>
                    <td>{a.name || r.addon_code}</td>
                    <td className="hide-m muted">{day(r.requested_at)}</td>
                    <td className="hide-m muted">{r.client_note || '—'}</td>
                    <td className="num">
                      <b>{money(a.monthly_fee)}</b>
                      <div className="muted">+{money(a.setup_fee)} setup</div>
                    </td>
                    <td>
                      <button className="rowbtn primary" onClick={() => decide(r, 'approved')}>Approve</button>
                      <button className="rowbtn" onClick={() => decide(r, 'declined')}>Decline</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {live.length > 0 && (
        <div className="card">
          <h3>Add-ons running · {money(mrr)}/mo</h3>
          <table>
            <thead>
              <tr><th>Client</th><th>Add-on</th><th className="hide-m">Since</th><th>Monthly</th><th className="hide-m">Included</th><th>Status</th></tr>
            </thead>
            <tbody>
              {live.map((r) => (
                <tr key={r.id}>
                  <td><b>{nameOf(r.client_id)}</b></td>
                  <td>{catalog[r.addon_code]?.name || r.addon_code}</td>
                  <td className="hide-m muted">{day(r.starts_on)}</td>
                  <td className="num"><b>{money(r.monthly_fee)}</b></td>
                  <td className="hide-m num">{r.included_minutes ?? '—'}</td>
                  <td>
                    <span className={'pill status-' + (r.status === 'active' ? 'won' : 'new')}>{r.status}</span>
                    {r.status === 'approved' && (
                      <button className="rowbtn" onClick={() => decide(r, 'active')}>Mark live</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
