import { useEffect, useState } from 'react';
import { supabase } from './supabase.js';

const when = (d) => {
  if (!d) return '—';
  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
};

/**
 * What clients have asked for. Without this the portal's request form writes
 * into a table nobody ever looks at - the client sees "submitted" and nothing
 * happens, which is worse than not offering the form at all.
 */
export default function StaffRequests({ clients, onChanged }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from('sanaku_change_requests')
      .select('*')
      .neq('status', 'done')
      .order('submitted_at', { ascending: true });   // oldest first: it has waited longest
    setRows(data || []);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const nameOf = (id) => clients.find((c) => c.id === id)?.company_name || 'Unknown client';

  async function move(row, status) {
    const patch = { status };
    if (status === 'done') patch.resolved_at = new Date().toISOString();
    const { error } = await supabase.from('sanaku_change_requests').update(patch).eq('id', row.id);
    if (error) return alert('Update failed: ' + error.message);
    load();
    onChanged?.();
  }

  if (loading || rows.length === 0) return null;

  const urgent = rows.filter((r) => r.priority === 'urgent').length;

  return (
    <div className={'card ' + (urgent ? 'warn' : '')}>
      <h3>
        Client requests ({rows.length}){urgent ? ` · ${urgent} urgent` : ''}
      </h3>
      <table>
        <thead>
          <tr>
            <th>Client</th><th>Asked for</th><th className="hide-m">Waiting</th>
            <th>Priority</th><th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><b>{nameOf(r.client_id)}</b></td>
              <td>{r.request}</td>
              <td className="hide-m muted">{when(r.submitted_at)}</td>
              <td>
                <span className={'pill ' + (r.priority === 'urgent' ? 't2' : 't3')}>
                  {r.priority || 'normal'}
                </span>
                {r.status === 'in_progress' && <div className="muted">in progress</div>}
              </td>
              <td>
                {r.status === 'open' && (
                  <button className="rowbtn" onClick={() => move(r, 'in_progress')}>Start</button>
                )}
                <button className="rowbtn primary" onClick={() => move(r, 'done')}>Done</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ padding: '0 16px 14px' }}>
        Marking one done shows it as resolved in their portal. They are not emailed —
        tell them yourself; that is the part worth doing by hand.
      </p>
    </div>
  );
}
