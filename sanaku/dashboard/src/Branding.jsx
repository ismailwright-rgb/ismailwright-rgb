import { useMemo, useRef, useState } from 'react';
import { supabase } from './supabase.js';

// --- contrast, so a client's brand colour never ships unreadable ------------
function luminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrastOnWhite(hex) {
  try {
    const l = luminance(hex);
    return Math.round(((1.05) / (l + 0.05)) * 100) / 100;
  } catch {
    return 0;
  }
}
/** Darken toward black until white text on it clears WCAG AA (4.5:1). */
export function darkenUntilReadable(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  let [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  for (let i = 0; i < 40; i++) {
    const cur = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    if (contrastOnWhite(cur) >= 4.5) return cur;
    r = Math.max(0, Math.round(r * 0.92));
    g = Math.max(0, Math.round(g * 0.92));
    b = Math.max(0, Math.round(b * 0.92));
  }
  return '#1a1a1a';
}

const isHex = (v) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);

/**
 * Set the colour and logo a client's portal wears. Used both while onboarding
 * and afterwards from the client roster.
 */
export default function Branding({ value, onChange, clientId }) {
  const { brand_name = '', brand_primary_color = '', brand_logo_url = '' } = value;
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef(null);

  const colorOk = isHex(brand_primary_color);
  const ratio = useMemo(() => (colorOk ? contrastOnWhite(brand_primary_color) : null), [brand_primary_color, colorOk]);
  const tooLight = ratio !== null && ratio < 4.5;
  const preview = colorOk ? brand_primary_color : '#0d6b42';

  const set = (k, v) => onChange({ ...value, [k]: v });

  async function uploadLogo(file) {
    if (!file) return;
    setErr('');
    if (file.size > 2 * 1024 * 1024) return setErr('That file is over 2MB — please use a smaller one.');
    setUploading(true);
    const ext = (file.name.split('.').pop() || 'png').toLowerCase();
    const path = `${clientId || 'pending'}-${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from('client-logos').upload(path, file, {
      cacheControl: '31536000',
      upsert: true,
    });
    if (error) {
      setUploading(false);
      return setErr(
        error.message.includes('Bucket not found')
          ? 'Storage is not set up yet — run migration-006-branding.sql in Supabase.'
          : error.message
      );
    }
    const { data } = supabase.storage.from('client-logos').getPublicUrl(path);
    set('brand_logo_url', data.publicUrl);
    setUploading(false);
  }

  return (
    <div className="branding">
      <label>Name shown to their customers</label>
      <input
        value={brand_name}
        placeholder="Valley Plumbing"
        onChange={(e) => set('brand_name', e.target.value)}
      />
      <p className="muted">Appears in every text their customers receive, and at the top of their portal.</p>

      <label>Brand colour</label>
      <div className="colorrow">
        <input
          type="color"
          className="swatch"
          value={colorOk ? brand_primary_color : '#0d6b42'}
          onChange={(e) => set('brand_primary_color', e.target.value)}
          aria-label="Pick brand colour"
        />
        <input
          value={brand_primary_color}
          placeholder="#1b5e8c"
          onChange={(e) => set('brand_primary_color', e.target.value.trim())}
          aria-label="Brand colour hex"
        />
        {colorOk && (
          <span className="muted num">{ratio}:1 on white</span>
        )}
      </div>

      {tooLight && (
        <div className="legalnote">
          White text on this colour is only {ratio}:1 — below the 4.5:1 readability
          threshold, so buttons will be hard to read.{' '}
          <button
            type="button"
            className="rowbtn"
            onClick={() => set('brand_primary_color', darkenUntilReadable(brand_primary_color))}
          >
            Darken it for me
          </button>
        </div>
      )}

      <label>Logo</label>
      <div className="colorrow">
        <button type="button" className="rowbtn" disabled={uploading} onClick={() => fileRef.current?.click()}>
          {uploading ? 'Uploading…' : brand_logo_url ? 'Replace logo' : 'Upload logo'}
        </button>
        {brand_logo_url && (
          <button type="button" className="rowbtn" onClick={() => set('brand_logo_url', '')}>Remove</button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,image/webp"
          style={{ display: 'none' }}
          onChange={(e) => uploadLogo(e.target.files?.[0])}
        />
      </div>
      <input
        value={brand_logo_url}
        placeholder="…or paste a URL to their logo"
        onChange={(e) => set('brand_logo_url', e.target.value.trim())}
        aria-label="Logo URL"
      />
      {err && <p className="formerr">{err}</p>}

      {/* what their portal header will actually look like */}
      <label>Their portal will look like this</label>
      <div className="brandpreview" style={{ '--brand': preview }}>
        <div className="bp-bar">
          {brand_logo_url
            ? <img src={brand_logo_url} alt="" />
            : <span className="bp-name">{brand_name || 'Their business name'}</span>}
          <span className="bp-tab on">Overview</span>
          <span className="bp-tab">Leads</span>
          <span className="bp-tab">Requests</span>
        </div>
        <div className="bp-body">
          <div className="bp-metric"><b>31</b><span>Leads this month</span></div>
          <div className="bp-metric"><b>12</b><span>After hours</span></div>
          <button type="button" className="bp-btn">Send request</button>
        </div>
      </div>
    </div>
  );
}
