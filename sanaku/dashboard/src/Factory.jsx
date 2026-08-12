/**
 * Factory — onboard a new client onto the privacy-first build.
 *
 * This is the operator side of the local-AI product: the config it produces is
 * handed to `sanaku-launch` in ~/sanaku-factory, which assembles the package
 * that installs on the client's own hardware.
 *
 * Distinct from OnboardClient.jsx, which onboards an agency-services client
 * (retainer/per-lead outreach). Same console, two different products.
 *
 * Nothing on this page ever touches client data — it produces a build spec.
 */

import { useMemo, useState } from 'react';
import library from './factory-library.js';

const money = (n) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 41);

/* §3 of the build brief, as the operator needs to see it: always on, never a
   checkbox. The real enforcement is in the launcher and its verifier. */
const FOUNDATION = [
  ['Local model via Ollama', 'Runs on their hardware. No build ships without one.'],
  ['Self-hosted Supabase, on their machine', 'Every piece of client data stays local. Never cloud.'],
  ['Routing layer', 'Classifies every task. Private stays local; default is local.'],
  ['Egress guard', 'One choke point, re-scanning the exact bytes before anything leaves.'],
  ['Grounding', 'Answers only from firm documents you approved. No source, no answer.'],
  ['Confidence limits', 'Says "I don’t know" and hands to a human rather than guessing.'],
  ['Human review gate', 'Anything resembling legal advice waits for a person.'],
];

const AUDIT_TOOLS = [
  ['chatgpt', 'ChatGPT / consumer AI'],
  ['cloud_intake', 'Cloud intake or chat widget'],
  ['otter', 'Meeting transcription'],
  ['zapier', 'Zapier / Make'],
  ['copilot', 'Microsoft Copilot'],
  ['gemini', 'Google Gemini'],
  ['crm_cloud', 'Cloud practice management'],
  ['dropbox', 'Consumer file sync'],
];

export default function Factory() {
  const [started, setStarted] = useState(false);
  const [clientName, setName] = useState('');
  const [clientId, setId] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const [vertical, setVertical] = useState('law');
  const [tierId, setTier] = useState('sweet_spot');
  const [model, setModel] = useState(null);
  const [picked, setPicked] = useState([]);
  const [mission, setMission] = useState('');
  const [tone, setTone] = useState('');
  const [priorities, setPriorities] = useState('');
  const [intakeScript, setScript] = useState('');
  const [auditTools, setAuditTools] = useState([]);
  const [copied, setCopied] = useState('');

  const tier = library.hardware_tiers.find((t) => t.id === tierId);
  const effectiveModel = model || tier.model;

  const available = useMemo(
    () => library.workflows.filter((w) => !w.verticals || w.verticals.includes(vertical)),
    [vertical],
  );

  /* First selected workflow is included in the base; each one after is an
     add-on. Selection order is the billing order, so it is not sorted. */
  const pricing = useMemo(() => {
    const base = library.pricing.base;
    const chosen = picked.map((c) => library.workflows.find((w) => w.code === c)).filter(Boolean);
    const addons = chosen.slice(base.includes_workflows);
    return {
      base,
      included: chosen.slice(0, base.includes_workflows),
      addons,
      setup: base.setup_fee + addons.reduce((n, w) => n + w.setup_fee, 0),
      monthly: base.monthly_fee + addons.reduce((n, w) => n + w.monthly_fee, 0),
    };
  }, [picked]);

  const id = clientId || slug(clientName);

  const config = useMemo(() => {
    const c = {
      clientId: id,
      clientName,
      vertical,
      hardwareTier: tierId,
      model: effectiveModel,
      workflows: picked,
      targetOS: 'both',
      personalization: {
        branding: tone ? { tone } : {},
        mission,
        priorities: priorities.split('\n').map((s) => s.trim()).filter(Boolean),
        businessData: intakeScript ? { intakeScript } : {},
      },
    };
    if (auditTools.length) c.audit = { currentTools: auditTools };
    return c;
  }, [id, clientName, vertical, tierId, effectiveModel, picked, tone, mission, priorities, intakeScript, auditTools]);

  const ready = clientName.trim().length > 1 && /^[a-z0-9][a-z0-9-]{1,40}$/.test(id) && picked.length > 0;
  const mayEgress = picked
    .map((c) => library.workflows.find((w) => w.code === c))
    .some((w) => w?.privacy_class === 'may_egress');

  const copy = (text, what) => {
    navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(''), 1600);
  };

  const setNameAndId = (v) => {
    setName(v);
    if (!idTouched) setId(slug(v));
  };

  const toggle = (code) =>
    setPicked((p) => (p.includes(code) ? p.filter((x) => x !== code) : [...p, code]));

  if (!started) {
    return (
      <>
        <div className="card highlight">
          <h3>Privacy-first build</h3>
          <p>
            The local-AI product: a model, a database and the firm&rsquo;s workflows, installed on
            hardware they own. Privileged client data never leaves their building &mdash; enforced
            by the launcher, which refuses to bundle a package that breaks it.
          </p>
        </div>
        <div className="card">
          <h3>Start</h3>
          <div className="form">
            <div className="formactions">
              <button className="btn" onClick={() => setStarted(true)}>Onboard New Client</button>
            </div>
            <p className="legalnote" style={{ marginTop: 14 }}>
              Produces a build spec. Run it through <code>sanaku-launch</code> to assemble the
              package. Nothing here touches client data.
            </p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {/* -------------------------------------------------- locked foundation */}
      <div className="card fx-locked">
        <h3>Privacy foundation &mdash; always included</h3>
        <div className="form">
          <p className="legalnote" style={{ marginBottom: 12 }}>
            The base of every build. Not a package you selected and not removable &mdash; a config
            that tries to disable it is corrected, and the verifier fails any package missing a
            piece of it.
          </p>
          <ul className="fx-foundation">
            {FOUNDATION.map(([t, d]) => (
              <li key={t}><b>{t}</b><span>{d}</span></li>
            ))}
          </ul>
          <p className="legalnote">
            Included in {money(library.pricing.base.setup_fee)} setup and{' '}
            {money(library.pricing.base.monthly_fee)}/month, along with their first workflow.
          </p>
        </div>
      </div>

      {/* ------------------------------------------------------------ client */}
      <div className="card">
        <h3>Who is this for?</h3>
        <div className="form">
          <label>Firm name
            <input value={clientName} onChange={(e) => setNameAndId(e.target.value)}
              placeholder="Halloran &amp; Reyes LLP" />
          </label>
          <label>Identifier &mdash; used for folders and containers
            <input value={clientId} onChange={(e) => { setIdTouched(true); setId(slug(e.target.value)); }}
              placeholder="halloran-reyes" />
          </label>
          <label>Vertical
            <select value={vertical} onChange={(e) => { setVertical(e.target.value); setPicked([]); }}>
              {['law', 'medical', 'accounting', 'insurance', 'mortgage', 'property'].map((v) => (
                <option key={v} value={v}>{v[0].toUpperCase() + v.slice(1)}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* ------------------------------------------------------------- model */}
      <div className="card">
        <h3>Which model fits their machine?</h3>
        <div className="form">
          <p className="legalnote" style={{ marginBottom: 12 }}>
            Match the model to hardware they actually own. Selling one their computer cannot run
            is how a firm decides the whole product is slow.
          </p>
          {library.hardware_tiers.map((t) => (
            <button key={t.id} type="button"
              className={`fx-card ${tierId === t.id ? 'sel' : ''}`}
              onClick={() => { setTier(t.id); setModel(t.model); }}>
              <span className="fx-head">
                <b>{t.label}{t.recommended && <em className="fx-pill rec">Most firms</em>}</b>
                <code>{t.model}</code>
              </span>
              <span className="fx-sub">{t.hardware}</span>
              <span className="fx-detail">{t.strengths}</span>
              <span className="fx-trade">Trade-off &mdash; {t.tradeoff}</span>
            </button>
          ))}
          {tier.alternates?.length > 0 && (
            <label style={{ marginTop: 14 }}>Model for the {tier.label} tier
              <select value={effectiveModel} onChange={(e) => setModel(e.target.value)}>
                {[tier.model, ...tier.alternates].map((m) => (
                  <option key={m} value={m}>{m}{m === tier.model ? ' — default' : ''}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      {/* --------------------------------------------------------- workflows */}
      <div className="card">
        <h3>What should it do?</h3>
        <div className="form">
          <p className="legalnote" style={{ marginBottom: 12 }}>
            The first one you pick is included in the base. Each one after that is an add-on and
            shows on their monthly bill.
          </p>
          {available.map((w) => {
            const i = picked.indexOf(w.code);
            const planned = w.template_status === 'planned';
            return (
              <button key={w.code} type="button" disabled={planned}
                className={`fx-card ${i >= 0 ? 'sel' : ''} ${planned ? 'off' : ''}`}
                onClick={() => !planned && toggle(w.code)}>
                <span className="fx-head">
                  <b>
                    {w.name}
                    {planned && <em className="fx-pill">Not built yet</em>}
                    {!planned && i === 0 && <em className="fx-pill inc">Included</em>}
                    {!planned && i > 0 && <em className="fx-pill add">+{money(w.monthly_fee)}/mo</em>}
                  </b>
                  <em className={`fx-pill ${w.privacy_class === 'may_egress' ? 'out' : 'loc'}`}>
                    {w.privacy_class === 'may_egress' ? 'May leave' : 'Always local'}
                  </em>
                </span>
                <span className="fx-sub">{w.blurb}</span>
                <span className="fx-detail">{w.detail}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ---------------------------------------------------- personalization */}
      <div className="card">
        <h3>Make it theirs</h3>
        <div className="form">
          <label>Mission &mdash; in their words, not marketing
            <textarea rows={2} value={mission} onChange={(e) => setMission(e.target.value)}
              placeholder="Plain answers for people having the worst month of their life." />
          </label>
          <label>Tone the assistant should take
            <input value={tone} onChange={(e) => setTone(e.target.value)} placeholder="warm, direct, no legalese" />
          </label>
          <label>Intake script reference
            <input value={intakeScript} onChange={(e) => setScript(e.target.value)} placeholder="personal-injury-v3" />
          </label>
          <label>Priorities &mdash; one per line
            <textarea rows={3} value={priorities} onChange={(e) => setPriorities(e.target.value)}
              placeholder={'capture every enquiry\nnever guess at advice'} />
          </label>
        </div>
      </div>

      {/* -------------------------------------------------------- risk audit */}
      <div className="card">
        <h3>Privacy Risk Audit</h3>
        <div className="form">
          <p className="legalnote" style={{ marginBottom: 12 }}>
            Tick only what they told you they use. This report goes to a managing partner with our
            name on it &mdash; one invented finding costs more than the deal.
          </p>
          <div className="fx-chips">
            {AUDIT_TOOLS.map(([tid, label]) => (
              <button key={tid} type="button"
                className={`fx-chip ${auditTools.includes(tid) ? 'sel' : ''}`}
                onClick={() => setAuditTools((t) => (t.includes(tid) ? t.filter((x) => x !== tid) : [...t, tid]))}>
                {label}
              </button>
            ))}
          </div>
          {auditTools.length > 0 && (
            <p className="legalnote" style={{ marginTop: 12 }}>
              Generate with <code>sanaku-launch audit {id || 'client'}.json</code>
            </p>
          )}
        </div>
      </div>

      {/* ----------------------------------------------------------- execute */}
      <div className={`card ${mayEgress ? 'warn' : 'highlight'}`}>
        <h3>{mayEgress ? 'This build may use a public model' : 'This build is provably local'}</h3>
        <p>
          {mayEgress
            ? 'One selected workflow may call a public model for generic tasks. The build allowlists a single host, and every request still passes the classifier and the egress guard. Everything else stays local.'
            : 'No selected workflow needs a public model, so this build ships with an empty egress allowlist. There is no outbound path at all.'}
        </p>
      </div>

      <div className="card">
        <h3>Execute</h3>
        <div className="form">
          {!ready && (
            <p className="formerr">
              {picked.length === 0 ? 'Pick at least one workflow.' : 'A firm name is needed.'}
            </p>
          )}
          <pre className="fx-spec">{JSON.stringify(config, null, 2)}</pre>
          <div className="formactions">
            <button className="btn" disabled={!ready}
              onClick={() => copy(JSON.stringify(config, null, 2), 'spec')}>
              {copied === 'spec' ? 'Copied' : 'Copy build spec'}
            </button>
            <button className="btn" disabled={!ready} onClick={() => {
              const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = `${id}.json`;
              a.click();
              URL.revokeObjectURL(a.href);
            }}>Download {id || 'client'}.json</button>
            <button className="btn" onClick={() => setStarted(false)}>Cancel</button>
          </div>
          <p className="legalnote" style={{ marginTop: 14 }}>
            Then run <code>sanaku-launch build {id || 'client'}.json</code>. It assembles, verifies
            and bundles &mdash; and verification is a gate, so a build that fails it is never bundled.
          </p>
        </div>
      </div>

      {/* ----------------------------------------------------------- pricing */}
      <div className="card">
        <h3>What they pay</h3>
        <table>
          <tbody>
            <tr>
              <td>{pricing.base.name} <span className="legalnote">includes the first workflow</span></td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                {money(pricing.base.setup_fee)} setup &middot; {money(pricing.base.monthly_fee)}/mo
              </td>
            </tr>
            {pricing.addons.map((w) => (
              <tr key={w.code}>
                <td>{w.name} <span className="legalnote">add-on</span></td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {money(w.setup_fee)} setup &middot; {money(w.monthly_fee)}/mo
                </td>
              </tr>
            ))}
            <tr>
              <td><b>Total</b></td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <b>{money(pricing.setup)} setup &middot; {money(pricing.monthly)}/mo</b>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="legalnote" style={{ padding: '0 18px 16px' }}>
          Every figure comes from the factory&rsquo;s pricing library, synced into this dashboard.
          Nothing here is typed by hand.
        </p>
      </div>
    </>
  );
}
