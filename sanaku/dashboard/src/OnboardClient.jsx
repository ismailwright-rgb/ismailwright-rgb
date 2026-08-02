import { useState } from 'react';
import { supabase } from './supabase.js';
import Branding from './Branding.jsx';
import { invitePortalUser, manualInviteSteps } from './invite.js';

// Pricing structures that survive review, by vertical. The database enforces
// this too (migration-002) - this is the friendly half of the same rule.
const ALLOWED = {
  home_services: [
    ['retainer_plus_per_lead', 'Retainer + per qualified lead (recommended)'],
    ['flat', 'Flat monthly'],
    ['retainer_plus_rev_share', 'Retainer + revenue share'],
  ],
  law_firm: [
    ['flat', 'Flat monthly (simplest to approve)'],
    ['retainer_plus_per_lead', 'Retainer + per lead delivered'],
  ],
  medical: [['flat', 'Flat monthly (required for healthcare)']],
};

const NOTE = {
  home_services: 'No restrictions — revenue share is available here if you want it.',
  law_firm: 'No share of fees or recoveries: most states bar fee-splitting with non-lawyers. Per-lead must be per lead DELIVERED, not per case signed.',
  medical: 'Flat fee only. Per-patient and percentage arrangements can implicate anti-kickback and fee-splitting rules.',
};

const DEFAULTS = {
  home_services: { retainer: 750, perLead: 50, cap: 1500, setup: 500 },
  law_firm: { retainer: 1500, perLead: 100, cap: 2000, setup: 500 },
  medical: { retainer: 800, perLead: 0, cap: 0, setup: 500 },
};

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

export default function OnboardClient({ onDone, onCancel }) {
  const [vertical, setVertical] = useState('home_services');
  const [f, setF] = useState({
    company_name: '',
    portal_email: '',
    brand_name: '',
    brand_primary_color: '',
    brand_logo_url: '',
    sending_number: '',
    pricing_model: 'retainer_plus_per_lead',
    setup_fee: DEFAULTS.home_services.setup,
    monthly_retainer: DEFAULTS.home_services.retainer,
    per_lead_fee: DEFAULTS.home_services.perLead,
    per_lead_monthly_cap: DEFAULTS.home_services.cap,
    rev_share_pct: '',
    pilot_ends_on: plusDays(30),
    billing_starts_on: plusDays(31),
    qualified_definition:
      'Working phone or email, expressed interest in service, not an existing scheduled customer, vendor, spam or wrong number.',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const set = (k, v) => setF((prev) => ({ ...prev, [k]: v }));

  function switchVertical(v) {
    setVertical(v);
    const d = DEFAULTS[v];
    setF((prev) => ({
      ...prev,
      pricing_model: ALLOWED[v][0][0],
      setup_fee: d.setup,
      monthly_retainer: d.retainer,
      per_lead_fee: d.perLead,
      per_lead_monthly_cap: d.cap,
      rev_share_pct: '',
    }));
  }

  const usesPerLead = f.pricing_model === 'retainer_plus_per_lead';
  const usesRevShare = f.pricing_model === 'retainer_plus_rev_share';

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (!f.company_name.trim()) return setErr('Company name is required.');
    setBusy(true);
    const num = (v) => (v === '' || v === null ? null : Number(v));
    const { data: created, error } = await supabase.from('sanaku_clients').insert({
      company_name: f.company_name.trim(),
      vertical,
      status: 'active',
      onboarded_at: today(),
      brand_name: f.brand_name.trim() || f.company_name.trim(),
      brand_primary_color: f.brand_primary_color.trim() || null,
      brand_logo_url: f.brand_logo_url.trim() || null,
      sending_number: f.sending_number.trim() || null,
      pricing_model: f.pricing_model,
      setup_fee: num(f.setup_fee),
      monthly_retainer: num(f.monthly_retainer),
      per_lead_fee: usesPerLead ? num(f.per_lead_fee) : null,
      per_lead_monthly_cap: usesPerLead ? num(f.per_lead_monthly_cap) : null,
      rev_share_pct: usesRevShare ? num(f.rev_share_pct) : null,
      pilot_ends_on: f.pilot_ends_on || null,
      billing_starts_on: f.billing_starts_on || null,
      qualified_definition: usesPerLead ? f.qualified_definition : null,
      workflow_enabled: true,
    }).select('id').single();

    if (error) { setBusy(false); return setErr(error.message); }

    // Onboarding without a way in is half a job, so the invite happens here
    // rather than being a separate hunt through the roster afterwards.
    const addr = f.portal_email.trim();
    if (!addr) { setBusy(false); return onDone(); }

    const res = await invitePortalUser({ email: addr, clientId: created.id });
    setBusy(false);
    if (res.ok) {
      alert(`${f.company_name.trim()} created. ${addr} has been emailed a link to set their password.`);
      return onDone();
    }
    // The client row saved either way - only the invite failed, and there is a
    // path that needs no n8n at all.
    alert(
      `${f.company_name.trim()} was created, but the invite could not be sent.\n\n${res.error}\n\n` +
      manualInviteSteps({ email: addr, clientId: created.id, company: f.company_name.trim() })
    );
    onDone();
  }

  return (
    <form className="onboard" onSubmit={submit}>
      <h3>Onboard a client</h3>

      <label>Vertical</label>
      <div className="seg">
        {Object.keys(ALLOWED).map((v) => (
          <button
            type="button"
            key={v}
            className={vertical === v ? 'on' : ''}
            onClick={() => switchVertical(v)}
          >
            {v === 'home_services' ? 'Home services' : v === 'law_firm' ? 'Law firm' : 'Medical'}
          </button>
        ))}
      </div>
      <p className="legalnote">{NOTE[vertical]}</p>

      <label>Business name</label>
      <input value={f.company_name} onChange={(e) => set('company_name', e.target.value)} required />

      <label>Their email, for the portal login</label>
      <input
        type="email"
        value={f.portal_email}
        placeholder="owner@valleyplumbing.com"
        onChange={(e) => set('portal_email', e.target.value)}
      />
      <p className="muted">
        They get an email with a link to set a password the moment this client is
        created. Leave blank to invite someone later from the roster.
      </p>

      <Branding value={f} onChange={(next) => setF(next)} />

      <label>Sending number (their number, E.164)</label>
      <input value={f.sending_number} placeholder="+16265551234" onChange={(e) => set('sending_number', e.target.value)} />

      <label>Pricing structure</label>
      <select value={f.pricing_model} onChange={(e) => set('pricing_model', e.target.value)}>
        {ALLOWED[vertical].map(([val, label]) => (
          <option key={val} value={val}>{label}</option>
        ))}
      </select>

      <div className="row2">
        <div>
          <label>Setup fee ($)</label>
          <input type="number" value={f.setup_fee} onChange={(e) => set('setup_fee', e.target.value)} />
        </div>
        <div>
          <label>Monthly retainer ($)</label>
          <input type="number" value={f.monthly_retainer} onChange={(e) => set('monthly_retainer', e.target.value)} />
        </div>
      </div>

      {usesPerLead && (
        <div className="row2">
          <div>
            <label>Per qualified lead ($)</label>
            <input type="number" value={f.per_lead_fee} onChange={(e) => set('per_lead_fee', e.target.value)} />
          </div>
          <div>
            <label>Monthly cap on lead fees ($)</label>
            <input type="number" value={f.per_lead_monthly_cap} onChange={(e) => set('per_lead_monthly_cap', e.target.value)} />
          </div>
        </div>
      )}

      {usesRevShare && (
        <>
          <label>Revenue share (%)</label>
          <input type="number" value={f.rev_share_pct} onChange={(e) => set('rev_share_pct', e.target.value)} />
          <p className="legalnote">
            Reminder: revenue share means they self-report closed revenue. Per-lead is auditable from your own meter.
          </p>
        </>
      )}

      {usesPerLead && (
        <>
          <label>What counts as "qualified" (goes in the agreement)</label>
          <textarea rows="3" value={f.qualified_definition} onChange={(e) => set('qualified_definition', e.target.value)} />
        </>
      )}

      <div className="row2">
        <div>
          <label>Free pilot ends</label>
          <input type="date" value={f.pilot_ends_on} onChange={(e) => set('pilot_ends_on', e.target.value)} />
        </div>
        <div>
          <label>First retainer charge</label>
          <input type="date" value={f.billing_starts_on} onChange={(e) => set('billing_starts_on', e.target.value)} />
        </div>
      </div>

      {err && <p className="formerr">{err}</p>}
      <div className="formactions">
        <button className="rowbtn primary" disabled={busy}>
          {busy ? 'Saving…' : f.portal_email.trim() ? 'Create client & send invite' : 'Create client'}
        </button>
        <button type="button" className="rowbtn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
