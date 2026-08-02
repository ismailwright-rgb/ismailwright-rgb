import { useState } from 'react';
import { supabase } from './supabase.js';

/**
 * Where an invite link and a password-reset link both have to land.
 *
 * Supabase signs the person in when they click either one, which looks like
 * success and is not: without this screen an invited client is signed in
 * having never chosen a password, so the next time they visit they cannot get
 * back in and nothing tells them why.
 */
export default function SetPassword({ onDone }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (pw.length < 8) return setErr('Use at least 8 characters.');
    if (pw !== pw2) return setErr('The two passwords do not match.');

    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) return setErr(error.message);

    // Drop the token out of the address bar so a refresh - or a shared link -
    // does not drop them back here.
    window.history.replaceState({}, '', window.location.pathname);
    onDone();
  }

  return (
    <form className="login" onSubmit={submit}>
      <h1>SANAKU<span className="dot">.</span></h1>
      <p>Choose a password. You'll use it with your email address from now on.</p>

      <label>New password</label>
      <input type="password" value={pw} autoComplete="new-password"
             onChange={(e) => setPw(e.target.value)} required />

      <label>Again, to be sure</label>
      <input type="password" value={pw2} autoComplete="new-password"
             onChange={(e) => setPw2(e.target.value)} required />

      <button disabled={busy}>{busy ? 'Saving…' : 'Save and continue'}</button>
      {err && <div className="err">{err}</div>}
    </form>
  );
}
