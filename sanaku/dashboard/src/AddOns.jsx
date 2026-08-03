import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase.js';

const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

/**
 * What else a client can buy. A dropdown picks the service; the three numbers
 * that decide it - start-up, monthly, per captured lead - are stated before
 * anything else.
 *
 * RLS shows them only their own vertical's catalog, and the request they submit
 * cannot carry a price: the database overwrites every commercial field on
 * insert, so a hand-crafted POST cannot arrive pre-approved or priced at zero.
 */
export default function AddOns({ client, preview }) {
  const [catalog, setCatalog] = useState([]);
  const [mine, setMine] = useState([]);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sent, setSent] = useState('');

  async function load() {
    setLoading(true);
    // Staff previewing a portal are not filtered by RLS: without these two
    // narrowings they would see every vertical's catalog and every client's
    // subscriptions inside one client's portal. A client's own session is
    // scoped by policy either way, so this only ever tightens.
    let cq = supabase.from('sanaku_addons').select('*').eq('active', true).order('sort');
    let mq = supabase.from('sanaku_client_addons').select('*');
    if (preview) {
      if (client.vertical) cq = cq.contains('allowed_verticals', [client.vertical]);
      mq = mq.eq('client_id', client.id);
    }
    const [c, m] = await Promise.all([cq, mq]);
    setCatalog(c.data || []);
    setMine(m.data || []);
    setLoading(false);
  }
  useEffect(() => { load(); }, [preview, client.id, client.vertical]);

  const statusOf = (c) => mine.find((m) => m.addon_code === c)?.status || null;
  const selected = useMemo(() => catalog.find((a) => a.code === code) || null, [catalog, code]);
  const alreadyHave = selected ? statusOf(selected.code) : null;

  async function request() {
    if (!selected) return;
    // In a preview the insert would succeed under staff RLS and drop a real
    // request into your own queue, from a demo you were only showing someone.
    if (preview) return setErr('Preview only — a request from here would land in your own queue.');
    setBusy(true);
    setErr('');
    const { error } = await supabase.from('sanaku_client_addons').insert({
      client_id: client.id,
      addon_code: selected.code,
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
    setSent(selected.name);
    setCode('');
    setNote('');
    load();
  }

  if (loading) return <div className="card"><div className="empty">Loading…</div></div>;
  if (catalog.length === 0) {
    return <div className="card"><div className="empty">Nothing else to add just yet.</div></div>;
  }

  const unit = (a) => (a.unit_label || 'min');

  return (
    <>
      {sent && (
        <div className="card highlight">
          <p><b>Request sent — {sent}.</b> We'll confirm the details and a start date
          before anything is charged.</p>
        </div>
      )}

      {/* ---- the picker: choose a service, see what it costs ---- */}
      <div className="card">
        <h3>Add a service</h3>
        <div className="form">
          <label>Which service would you like to add?</label>
          <select value={code} onChange={(e) => { setCode(e.target.value); setErr(''); setSent(''); }}>
            <option value="">Choose a service…</option>
            {catalog.map((a) => (
              <option key={a.code} value={a.code}>
                {a.name} — {money(a.monthly_fee)}/mo
                {statusOf(a.code) ? ` (${statusOf(a.code)})` : ''}
              </option>
            ))}
          </select>

          {!selected && (
            <p className="muted" style={{ marginTop: 12 }}>
              Pick one and you'll see the start-up cost, the monthly, and anything
              charged per captured lead — before you commit to anything.
            </p>
          )}

          {selected && (
            <>
              <p className="addon-blurb" style={{ marginTop: 16 }}>{selected.blurb}</p>

              {/* The three numbers that actually decide it. */}
              <div className="quote">
                <div className="q">
                  <span className="q-l">Initial start-up cost</span>
                  <span className="q-v">{money(selected.setup_fee)}</span>
                  <span className="q-n">one-off</span>
                </div>
                <div className="q">
                  <span className="q-l">Ongoing</span>
                  <span className="q-v">{money(selected.monthly_fee)}</span>
                  <span className="q-n">per month</span>
                </div>
                <div className="q">
                  <span className="q-l">Per captured lead</span>
                  <span className="q-v">
                    {selected.per_lead_fee == null ? 'None' : money(selected.per_lead_fee)}
                  </span>
                  <span className="q-n">
                    {selected.per_lead_fee == null
                      ? 'not charged on this service'
                      : 'only for leads that qualify'}
                  </span>
                </div>
              </div>

              {selected.included_minutes != null && (
                <p className="muted">
                  Includes {selected.included_minutes} {unit(selected)} a month.
                  {selected.overage_per_minute != null &&
                    ` Beyond that, $${selected.overage_per_minute} per ${unit(selected).replace(/s$/, '')}.`}
                </p>
              )}

              {selected.detail && <p className="addon-detail">{selected.detail}</p>}

              {selected.requires_baa && (
                <p className="legalnote">
                  Healthcare: we sign a business associate agreement covering every vendor
                  in the path before this goes live.
                </p>
              )}
              {selected.compliance_note && (
                <p className="addon-compliance">{selected.compliance_note}</p>
              )}

              {alreadyHave ? (
                <p className="muted" style={{ marginTop: 14 }}>
                  {alreadyHave === 'requested' ? "You've already asked about this — we'll be in touch."
                    : alreadyHave === 'approved' ? 'Approved. Setup is in progress.'
                    : alreadyHave === 'active' ? 'This one is already running for you.'
                    : alreadyHave === 'declined' ? "We didn't think this was a fit — ask us why."
                    : 'Cancelled.'}
                </p>
              ) : (
                <>
                  <label>Anything we should know? (optional)</label>
                  <textarea
                    rows="3"
                    value={note}
                    placeholder="e.g. we're busiest evenings, and we don't take jobs outside the valley"
                    onChange={(e) => setNote(e.target.value)}
                  />
                  {err && <p className="formerr">{err}</p>}
                  <div className="formactions">
                    <button className="rowbtn primary" disabled={busy} onClick={request}>
                      {busy ? 'Sending…' : `Request ${selected.name}`}
                    </button>
                    <button className="rowbtn" onClick={() => setCode('')}>Cancel</button>
                  </div>
                  <p className="muted" style={{ marginTop: 10 }}>
                    Nothing is charged until we've confirmed the details and a start date
                    with you in writing.
                  </p>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* ---- the full menu, so the range of what we do is visible ---- */}
      <h3 className="sectionhead">Everything we offer</h3>
      <div className="addons">
        {catalog.map((a) => {
          const status = statusOf(a.code);
          return (
            <div key={a.code} className={'addon' + (status === 'active' ? ' on' : '')}>
              <div className="addon-head">
                <h4>{a.name}</h4>
                {status && (
                  <span className={'pill status-' + (status === 'active' ? 'won' : status === 'declined' ? 'lost' : 'new')}>
                    {status}
                  </span>
                )}
              </div>
              <p className="addon-blurb">{a.blurb}</p>

              <dl className="addon-price">
                <div><dt>Start-up</dt><dd>{money(a.setup_fee)}</dd></div>
                <div><dt>Monthly</dt><dd>{money(a.monthly_fee)}</dd></div>
                <div>
                  <dt>Per lead</dt>
                  <dd>{a.per_lead_fee == null ? '—' : money(a.per_lead_fee)}</dd>
                </div>
                {a.included_minutes != null && (
                  <div><dt>Included</dt><dd>{a.included_minutes} <span className="per">{unit(a)}</span></dd></div>
                )}
              </dl>

              {!status && (
                <button className="bp-btn" onClick={() => { setCode(a.code); setSent(''); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                  Add this
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
