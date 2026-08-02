import { useEffect, useState } from 'react';
import { supabase } from './supabase.js';

const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

/**
 * What else a client can buy, priced up front. RLS shows them only their own
 * vertical's catalog; the request they submit cannot carry a price, because
 * the database overwrites every commercial field on insert.
 */
export default function AddOns({ client }) {
  const [catalog, setCatalog] = useState([]);
  const [mine, setMine] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(null);   // the add-on being requested
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function load() {
    setLoading(true);
    const [c, m] = await Promise.all([
      supabase.from('sanaku_addons').select('*').eq('active', true).order('sort'),
      supabase.from('sanaku_client_addons').select('*'),
    ]);
    setCatalog(c.data || []);
    setMine(m.data || []);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const statusOf = (code) => mine.find((m) => m.addon_code === code)?.status || null;

  async function request(addon) {
    setBusy(true);
    setErr('');
    const { error } = await supabase.from('sanaku_client_addons').insert({
      client_id: client.id,
      addon_code: addon.code,
      client_note: note.trim() || null,
    });
    setBusy(false);
    if (error) {
      return setErr(
        error.code === '23505'
          ? "You've already asked about this one — we'll be in touch."
          : error.message
      );
    }
    setOpen(null);
    setNote('');
    load();
  }

  if (loading) return <div className="card"><div className="empty">Loading…</div></div>;
  if (catalog.length === 0) {
    return <div className="card"><div className="empty">Nothing else to add just yet.</div></div>;
  }

  return (
    <>
      <div className="card highlight">
        <p>
          Anything here can be switched on for you. Ask, and we'll confirm the details
          and a start date before a penny is charged — <b>nothing bills automatically.</b>
        </p>
      </div>

      <div className="addons">
        {catalog.map((a) => {
          const status = statusOf(a.code);
          return (
            <div key={a.code} className={'addon' + (status === 'active' ? ' on' : '')}>
              <div className="addon-head">
                <h4>{a.name}</h4>
                {status && <span className={'pill status-' + (status === 'active' ? 'won' : status === 'declined' ? 'lost' : 'new')}>{status}</span>}
              </div>
              <p className="addon-blurb">{a.blurb}</p>

              <dl className="addon-price">
                <div><dt>Monthly</dt><dd>{money(a.monthly_fee)}</dd></div>
                <div><dt>One-off setup</dt><dd>{money(a.setup_fee)}</dd></div>
                {a.included_minutes != null && (
                  <div><dt>Included</dt><dd>{a.included_minutes} {a.unit_label || 'min'}</dd></div>
                )}
                {a.overage_per_minute != null && (
                  <div><dt>After that</dt><dd>${a.overage_per_minute}<span className="per">/{(a.unit_label || 'min').replace(/s$/, '')}</span></dd></div>
                )}
                {a.per_lead_fee != null && (
                  <div><dt>Per qualified lead</dt><dd>{money(a.per_lead_fee)}</dd></div>
                )}
              </dl>

              {a.detail && <p className="addon-detail">{a.detail}</p>}
              {a.requires_baa && (
                <p className="legalnote">
                  Healthcare: we sign a business associate agreement covering every
                  vendor in the call path before this goes live.
                </p>
              )}
              {a.compliance_note && <p className="addon-compliance">{a.compliance_note}</p>}

              {status ? (
                <p className="muted">
                  {status === 'requested' ? "Requested — we'll be in touch."
                    : status === 'approved' ? 'Approved, setup in progress.'
                    : status === 'active' ? 'Running.'
                    : status === 'declined' ? 'Not a fit right now — ask us why.'
                    : 'Cancelled.'}
                </p>
              ) : (
                <button className="bp-btn" onClick={() => { setOpen(a); setNote(''); setErr(''); }}>
                  Ask about this
                </button>
              )}
            </div>
          );
        })}
      </div>

      {open && (
        <div className="card">
          <h3>{open.name}</h3>
          <div className="form">
            <p className="muted">
              {money(open.monthly_fee)}/month
              {open.setup_fee > 0 && `, ${money(open.setup_fee)} one-off setup`}
              {open.included_minutes != null && `, ${open.included_minutes} ${open.unit_label || 'min'} included`}
              {open.per_lead_fee != null && `, ${money(open.per_lead_fee)} per qualified lead`}.
              We'll confirm everything in writing before starting.
            </p>
            <label>Anything we should know? (optional)</label>
            <textarea
              rows="3"
              value={note}
              placeholder="e.g. we're busiest evenings, and we don't take jobs outside the valley"
              onChange={(e) => setNote(e.target.value)}
            />
            {err && <p className="formerr">{err}</p>}
            <div className="formactions">
              <button className="rowbtn primary" disabled={busy} onClick={() => request(open)}>
                {busy ? 'Sending…' : 'Send request'}
              </button>
              <button className="rowbtn" onClick={() => setOpen(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
