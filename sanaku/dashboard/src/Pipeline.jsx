import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase.js';
import { WORKFLOWS, recommendWorkflow, buildScript, scriptToText } from './playbook.js';
import ProspectDrawer from './ProspectDrawer.jsx';

const VERTICALS = { law_firm: 'Law firm', medical: 'Medical', home_services: 'Home services' };
const fmtMoney = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString('en-US'));
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');

export default function Pipeline() {
  const [prospects, setProspects] = useState([]);
  const [demos, setDemos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fVertical, setFVertical] = useState('all');
  const [fTier, setFTier] = useState('all');
  const [fStatus, setFStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: 'intent_score', dir: 'desc' });
  const [expanded, setExpanded] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [openProspect, setOpenProspect] = useState(null);  // row open in the CRM drawer
  const [followups, setFollowups] = useState([]);

  async function load() {
    setLoading(true);
    const [p, d, f] = await Promise.all([
      supabase.from('sanaku_prospects').select('*').order('intent_score', { ascending: false }).limit(1000),
      supabase
        .from('sanaku_demos')
        .select('*, sanaku_prospects(company_name, vertical, contact_name, contact_phone)')
        .gte('scheduled_for', new Date(Date.now() - 86400000).toISOString())
        .order('scheduled_for', { ascending: true }),
      supabase.from('v_followups_due').select('*').limit(25),
    ]);
    setFollowups(f.data || []);
    setProspects(p.data || []);
    setDemos(d.data || []);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const metrics = useMemo(() => {
    const weekAgo = Date.now() - 7 * 86400000;
    const scrapedThisWeek = prospects.filter((p) => new Date(p.first_seen).getTime() > weekAgo).length;
    const contacted = prospects.filter((p) => ['contacted', 'replied', 'demo_booked', 'won', 'lost'].includes(p.status)).length;
    const replied = prospects.filter((p) => ['replied', 'demo_booked', 'won'].includes(p.status)).length;
    const demosBooked = prospects.filter((p) => ['demo_booked', 'won'].includes(p.status)).length;
    const won = prospects.filter((p) => p.status === 'won').length;
    return {
      scrapedThisWeek,
      contacted,
      replyRate: contacted ? Math.round((replied / contacted) * 100) + '%' : '—',
      demosBooked,
      demoConv: demosBooked ? Math.round((won / demosBooked) * 100) + '%' : '—',
    };
  }, [prospects]);

  const rows = useMemo(() => {
    let r = prospects;
    if (fVertical !== 'all') r = r.filter((p) => p.vertical === fVertical);
    if (fTier !== 'all') r = r.filter((p) => String(p.tier) === fTier);
    if (fStatus !== 'all') r = r.filter((p) => p.status === fStatus);
    if (search.trim()) {
      const q = search.toLowerCase();
      r = r.filter((p) => (p.company_name || '').toLowerCase().includes(q) || (p.domain || '').toLowerCase().includes(q));
    }
    const { key, dir } = sort;
    r = [...r].sort((a, b) => {
      const av = a[key] ?? '';
      const bv = b[key] ?? '';
      const c = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return dir === 'asc' ? c : -c;
    });
    return r;
  }, [prospects, fVertical, fTier, fStatus, search, sort]);

  function toggleSort(key) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));
  }

  async function approve(ids) {
    if (!ids.length) return;
    const { error } = await supabase
      .from('sanaku_prospects')
      .update({ status: 'queued' })
      .in('id', ids)
      .eq('status', 'new'); // the gate only releases prospects still in 'new'
    if (error) alert('Approve failed: ' + error.message);
    setSelected(new Set());
    load();
  }


  const approvable = rows.filter((p) => p.status === 'new' && p.contact_email);
  const selectedApprovable = [...selected].filter((id) => approvable.some((p) => p.id === id));

  return (
    <>
      <div className="metrics">
        <div className="metric"><div className="v">{metrics.scrapedThisWeek}</div><div className="l">Scraped this week</div></div>
        <div className="metric"><div className="v">{metrics.contacted}</div><div className="l">Contacted</div></div>
        <div className="metric"><div className="v">{metrics.replyRate}</div><div className="l">Reply rate</div></div>
        <div className="metric"><div className="v">{metrics.demosBooked}</div><div className="l">Demos booked</div></div>
        <div className="metric"><div className="v">{metrics.demoConv}</div><div className="l">Demo → client</div></div>
      </div>

      {demos.length > 0 && (
        <div className="card">
          <h3>Upcoming demos</h3>
          <table>
            <thead>
              <tr><th>When</th><th>Company</th><th className="hide-m">Stated pain</th><th>Est. monthly loss</th></tr>
            </thead>
            <tbody>
              {demos.map((d) => (
                <tr key={d.id}>
                  <td>{new Date(d.scheduled_for).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                  <td>
                    {d.sanaku_prospects?.company_name || '—'}
                    <div className="muted">{d.sanaku_prospects?.contact_name} · {d.sanaku_prospects?.contact_phone}</div>
                  </td>
                  <td className="hide-m">{d.stated_pain || '—'}</td>
                  <td><span className="loss-big">{fmtMoney(d.est_monthly_loss)}</span><div className="muted">{d.monthly_lead_volume} leads × 25% × {fmtMoney(d.est_lead_value)}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {followups.length > 0 && (
        <div className="card followups">
          <h3>Follow-ups due ({followups.length})</h3>
          <table>
            <tbody>
              {followups.map((f) => (
                <tr key={f.id}>
                  <td>
                    <b>{f.company_name}</b>
                    <div className="muted">{f.next_action || 'follow up'}</div>
                  </td>
                  <td className="hide-m">
                    {f.contact_phone && <a href={`tel:${f.contact_phone.replace(/[^\d+]/g, '')}`}>{f.contact_phone}</a>}
                  </td>
                  <td className="num muted">{new Date(f.next_action_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="rowbtn primary"
                      onClick={() => setOpenProspect(prospects.find((p) => p.id === f.id) || f)}
                    >Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="controls">
        <select value={fVertical} onChange={(e) => setFVertical(e.target.value)}>
          <option value="all">All verticals</option>
          {Object.entries(VERTICALS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={fTier} onChange={(e) => setFTier(e.target.value)}>
          <option value="all">All tiers</option>
          <option value="1">Tier 1</option><option value="2">Tier 2</option><option value="3">Tier 3</option>
        </select>
        <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          <option value="all">All statuses</option>
          {['new', 'queued', 'contacted', 'replied', 'demo_booked', 'won', 'lost', 'dnc'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input placeholder="Search company / domain…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button
          className="bulk"
          disabled={!selectedApprovable.length}
          onClick={() => approve(selectedApprovable)}
          title="Releases the selected prospects to the outreach sequencer"
        >
          Approve &amp; send ({selectedApprovable.length})
        </button>
      </div>

      <div className="card">
        {loading ? <div className="empty">Loading…</div> : rows.length === 0 ? (
          <div className="empty">No prospects match. Run W1 (the scraper) in n8n, then refresh.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th />
                <th onClick={() => toggleSort('company_name')}>Company</th>
                <th onClick={() => toggleSort('vertical')} className="hide-m">Vertical</th>
                <th onClick={() => toggleSort('tier')}>Tier</th>
                <th className="hide-m">Best fit</th>
                <th onClick={() => toggleSort('intent_score')}>Intent</th>
                <th onClick={() => toggleSort('status')}>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <Row
                  key={p.id}
                  p={p}
                  expanded={expanded === p.id}
                  onExpand={() => setExpanded(expanded === p.id ? null : p.id)}
                  checked={selected.has(p.id)}
                  onCheck={(on) => {
                    const next = new Set(selected);
                    on ? next.add(p.id) : next.delete(p.id);
                    setSelected(next);
                  }}
                  onApprove={() => approve([p.id])}
                  onThread={() => setOpenProspect(p)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {openProspect && (
        <ProspectDrawer
          prospect={openProspect}
          onClose={() => setOpenProspect(null)}
          onChanged={load}
        />
      )}
    </>
  );
}

function Row({ p, expanded, onExpand, checked, onCheck, onApprove, onThread }) {
  const sig = p.signals || {};
  const rec = useMemo(() => recommendWorkflow(p), [p]);
  const script = useMemo(() => buildScript(p, rec), [p, rec]);
  const [copied, setCopied] = useState(false);

  async function copyScript() {
    try {
      await navigator.clipboard.writeText(scriptToText(p, rec, script));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      <tr>
        <td>
          <input
            type="checkbox"
            checked={checked}
            disabled={p.status !== 'new' || !p.contact_email}
            onChange={(e) => onCheck(e.target.checked)}
          />
        </td>
        <td>
          <b>{p.company_name}</b>
          <div className="muted">
            <a href={p.website_url || `https://${p.domain}`} target="_blank" rel="noreferrer">{p.domain}</a>
            {p.contact_name
              ? <> · <b className={'who-in' + (p.decision_maker ? ' decides' : '')}>{p.contact_name}</b>
                  {p.contact_title ? ` (${p.contact_title})` : ''}</>
              : <> · <span className="who-none">no decision maker — business line only</span></>}
            {p.contact_phone
              ? <> · <a href={`tel:${p.contact_phone.replace(/[^\d+]/g, '')}`}>{p.contact_phone}</a>
                  <span className={'phtag' + (p.contact_phone_source === 'apollo_direct' ? ' direct' : '')}>
                    {p.contact_phone_source === 'apollo_direct' ? 'direct' : 'main line'}
                  </span></>
              : ''}
            {p.contact_email
              ? <> · <a href={`mailto:${p.contact_email}`}>{p.contact_email}</a></>
              : ' · no email yet'}
          </div>
        </td>
        <td className="hide-m">{VERTICALS[p.vertical] || p.vertical}</td>
        <td>
          {p.tier ? <span className={'pill t' + p.tier}>T{p.tier}</span> : <span className="pill t3" title="Site blocked our scan">?</span>}
        </td>
        <td className="hide-m">
          <span className="fit" title={rec.why}>{WORKFLOWS[rec.key].name}</span>
          <div className="muted">{rec.confidence} confidence</div>
        </td>
        <td className="num"><b>{p.intent_score ?? '—'}</b></td>
        <td><span className={'pill status-' + p.status}>{p.status}</span></td>
        <td style={{ whiteSpace: 'nowrap' }}>
          <button className="rowbtn" onClick={onExpand}>{expanded ? 'Hide' : 'Signals'}</button>
          <button className="rowbtn" onClick={onThread}>Open</button>
          {p.status === 'new' && p.contact_email && (
            <button className="rowbtn primary" onClick={onApprove}>Approve</button>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="expand">
          <td colSpan={8}>
            <div className="fitbox">
              <div className="fitbox-head">
                <div>
                  <span className="k">Best fit</span>
                  <div className="fitname">{WORKFLOWS[rec.key].name} <span className="fittag">{WORKFLOWS[rec.key].tag}</span></div>
                </div>
                <button className="rowbtn primary" onClick={copyScript}>
                  {copied ? 'Copied ✓' : 'Copy call script'}
                </button>
              </div>
              <p className="fitwhy">{rec.why}</p>
              <p className="muted">{WORKFLOWS[rec.key].blurb}</p>
              {rec.secondary && (
                <p className="muted">Second option: <b>{WORKFLOWS[rec.secondary].name}</b></p>
              )}

              <div className="script">
                <div className="sline"><span>OPEN</span><p>{script.opener}</p></div>
                <div className="sline"><span>ASK</span><p><b>{script.question}</b></p></div>
                <div className="sline"><span>STAKES</span><p>{script.stakes}</p></div>
                <div className="sline"><span>MATH</span><p>{script.math}</p></div>
                <div className="sline"><span>OFFER</span><p>{script.solution}</p></div>
                <div className="sline"><span>CLOSE</span><p>{script.close}</p></div>
                <details className="objections">
                  <summary>Objection handling</summary>
                  {script.objections.map((o, i) => (
                    <p key={i}><b>{o.q}</b><br />{o.a}</p>
                  ))}
                </details>
              </div>
            </div>

            <div className="signal-grid">
              <div><div className="k">Detected tools</div>{p.tech_stack?.length ? p.tech_stack.join(', ') : 'None — that is the pitch'}</div>
              <div><div className="k">Running ads</div>{sig.detected?.ads ? sig.detected.ads.join(', ') : 'No'}</div>
              <div><div className="k">Contact form / phone</div>{(sig.has_contact_form ? 'Form' : 'No form') + ' · ' + (sig.phone_visible ? 'phone visible' : 'no phone')}</div>
              <div><div className="k">Reviews</div>{sig.review_count ? `${sig.review_count} at ${sig.rating}` : '—'}</div>
              <div><div className="k">Site freshness</div>{sig.fresh_site ? `Fresh (© ${sig.copyright_year || '?'})` : 'Stale'}</div>
              <div><div className="k">Staff</div>{p.employee_count ?? '—'}</div>
              <div><div className="k">Source</div>{p.source} · first seen {fmtDate(p.first_seen)}</div>
              <div><div className="k">Last contacted</div>{fmtDate(p.last_contacted)}</div>
            </div>
            {sig.reason && <div className="reason"><b>Why this score:</b> {sig.reason}</div>}
          </td>
        </tr>
      )}
    </>
  );
}
