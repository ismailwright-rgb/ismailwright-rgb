import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase.js';
import { monthPeriod } from './dates.js';

const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
/**
 * First and last day of the month `back` months ago (0 = this month), in the
 * BUSINESS timezone — see dates.js. This used to build a local Date and then
 * read its UTC date back out, which shifted the whole period a day earlier
 * whenever the statement was pulled from a UTC+ timezone.
 */
function period(back) {
  const p = monthPeriod(back);
  return { start: p.startISO, end: p.endISO, label: p.label, startAt: p.startAt, endAt: p.endAt };
}

// start/end are already YYYY-MM-DD strings now; kept as a named step so the
// call sites still read as "the iso date of the period boundary".
const iso = (d) => d;

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
  const [rows, setRows] = useState([]);
  const [issued, setIssued] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const p = useMemo(() => period(back), [back]);

  async function load() {
    setLoading(true);
    // One question - "what does this client owe" - deserves one answer. The
    // arithmetic used to live here in JS AND in migration-002's SQL, which is
    // two implementations that can drift on the number a client is charged.
    // sanaku_statements_for_period() is now the only one, and it is the same
    // function the database itself uses. Demo clients are excluded inside it.
    const [f, b] = await Promise.all([
      supabase.rpc('sanaku_statements_for_period', { _start: iso(p.start), _end: iso(p.end) }),
      supabase.from('sanaku_billing').select('*').eq('period_start', iso(p.start)),
    ]);
    if (f.error) { setErr(f.error.message); setRows([]); }
    else { setErr(''); setRows(f.data || []); }
    setIssued(b.data || []);
    setLoading(false);
  }
  useEffect(() => { load(); }, [back]);

  const statementFor = (id) => issued.find((s) => s.client_id === id);

  async function issue(f) {
    const line = (label, amount) => `${label.padEnd(16)}${money(amount)}\n`;
    const msg =
      `Issue ${p.label} statement for ${f.company_name}?\n\n` +
      (f.retainer_due ? line('Retainer', f.retainer_due) : '') +
      (f.setup_due ? line('Setup (one-off)', f.setup_due) : '') +
      (f.addons_due ? line('Services', f.addons_due) : '') +
      (f.in_trial ? `Services        ${money(0)} — still in trial\n` : '') +
      (f.per_lead_due ? line(`Leads (${f.leads_qualified})`, f.per_lead_due) + (f.capped ? '                at monthly cap\n' : '') : '') +
      (f.overage_due ? line('Voice overage', f.overage_due) : '') +
      `------------------------------\n` +
      line('Total', f.total_due) + '\n' +
      (f.setup_due
        ? `The setup fee is billed ONCE — issuing this marks it charged so it ` +
          `cannot appear again next month.\n\n`
        : '') +
      `It saves as a DRAFT. Nothing is sent and no card is charged — you still ` +
      `invoice them however you normally do.`;
    if (!window.confirm(msg)) return;

    setBusy(f.client_id);
    const { error } = await supabase.from('sanaku_billing').insert({
      client_id: f.client_id,
      period_start: iso(p.start),
      period_end: iso(p.end),
      retainer_due: f.retainer_due,
      setup_due: f.setup_due,
      addons_due: f.addons_due,
      per_lead_due: f.per_lead_due,
      overage_due: f.overage_due,
      leads_captured: f.leads_captured,
      total_due: f.total_due,
      status: 'draft',
    });
    if (error) { setBusy(''); return alert('Could not save the statement: ' + error.message); }

    // Stamp the setup fee as charged. Without this it is due again every month
    // for the life of the subscription - the statement above would be right and
    // every one after it wrong.
    if (Number(f.setup_due) > 0) {
      const { error: stampErr } = await supabase
        .from('sanaku_client_addons')
        .update({ setup_billed_on: iso(p.end) })
        .eq('client_id', f.client_id)
        .eq('status', 'active')
        .is('setup_billed_on', null)
        .not('live_on', 'is', null)
        .lte('live_on', iso(p.end));
      if (stampErr) {
        setBusy('');
        return alert(
          'The statement saved, but the setup fee could not be marked as charged:\n\n' +
          stampErr.message +
          '\n\nIt will appear on next month\'s statement too. Fix it before issuing again.'
        );
      }
    }
    setBusy('');
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

  const grand = rows.reduce((s, r) => s + Number(r.total_due || 0), 0);

  return (
    <div className="card">
      <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingRight: 16 }}>
        <span>Statements · {p.label} · {money(grand)}</span>
        <span>
          <button className={'rowbtn' + (back === 1 ? ' primary' : '')} onClick={() => setBack(1)}>Last month</button>
          <button className={'rowbtn' + (back === 0 ? ' primary' : '')} onClick={() => setBack(0)}>This month</button>
        </span>
      </h3>

      {err && <div className="empty">Could not work out this period: {err}</div>}

      {!err && rows.length === 0 ? (
        <div className="empty">No active clients yet.</div>
      ) : !err && (
        <table>
          <thead>
            <tr>
              <th>Client</th><th className="hide-m">Qualified</th>
              <th className="hide-m">Retainer</th><th className="hide-m">Setup</th>
              <th className="hide-m">Services</th><th className="hide-m">Per lead</th>
              <th className="hide-m">Overage</th>
              <th>Total</th><th>Statement</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => {
              const c = { id: f.client_id, company_name: f.company_name };
              const s = statementFor(c.id);
              const cell = (n) => (Number(n) ? money(n) : '—');
              return (
                <tr key={c.id}>
                  <td>
                    <b>{c.company_name}</b>
                    {f.in_trial && <div className="muted">in trial — services not billed</div>}
                  </td>
                  <td className="hide-m num">{f.leads_qualified}</td>
                  <td className="hide-m num">{cell(f.retainer_due)}</td>
                  {/* A one-off. It shows once, on the first statement after the
                      service goes live, and never again. */}
                  <td className="hide-m num">{cell(f.setup_due)}</td>
                  <td className="hide-m num">{cell(f.addons_due)}</td>
                  <td className="hide-m num">
                    {cell(f.per_lead_due)}
                    {f.capped && <div className="muted">at cap</div>}
                  </td>
                  <td className="hide-m num">{cell(f.overage_due)}</td>
                  <td className="num"><b>{money(f.total_due)}</b></td>
                  <td>
                    {!s ? (
                      <button className="rowbtn primary" disabled={busy === c.id} onClick={() => issue(f)}>
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
        Per-lead counts qualified leads only, charges each one once at whichever rate
        covers its channel, and stops at the monthly cap. A setup fee appears on the
        first statement after a service goes live and never again. A service still
        inside its trial bills nothing.
      </p>
    </div>
  );
}
