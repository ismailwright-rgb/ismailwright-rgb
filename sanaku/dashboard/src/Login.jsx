import { useState } from 'react';
import { supabase } from './supabase.js';

/**
 * Sign in, and — the part that was missing — get back in after forgetting a
 * password. Without a reset a client who forgets theirs is locked out with no
 * self-serve way back, and has to email you to be let into a product they pay
 * for every month.
 *
 * The copy stays neutral: this same screen is the front door for a plumbing
 * company's owner as well as for you, and "work the pipeline" means nothing
 * to them.
 */
export default function Login() {
  const [mode, setMode] = useState('in');        // 'in' | 'reset'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr('');

    if (mode === 'reset') {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: window.location.origin,
      });
      setBusy(false);
      // Never reveal whether an address has an account - that turns this form
      // into a way to enumerate your client list.
      if (error && !/rate|limit/i.test(error.message)) return setErr(error.message);
      if (error) return setErr('Too many attempts just now — try again in a few minutes.');
      return setSent(true);
    }

    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) {
      setErr(/invalid login/i.test(error.message)
        ? 'That email and password do not match.'
        : error.message);
    }
  }

  if (sent) {
    return (
      <div className="login">
        <h1>SANAKU<span className="dot">.</span></h1>
        <p>
          If there's an account for <b>{email.trim()}</b>, a link to set a new
          password is on its way. It expires in an hour.
        </p>
        <button type="button" onClick={() => { setSent(false); setMode('in'); }}>
          Back to sign in
        </button>
      </div>
    );
  }

  return (
    <form className="login" onSubmit={submit}>
      <h1>SANAKU<span className="dot">.</span></h1>
      <p>{mode === 'reset' ? 'Enter your email and we\'ll send you a link to set a new password.' : 'Sign in to your dashboard.'}</p>

      <label>Email</label>
      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />

      {mode === 'in' && (
        <>
          <label>Password</label>
          <input
            type="password" value={password} autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)} required
          />
        </>
      )}

      <button disabled={busy}>
        {busy ? 'Working…' : mode === 'reset' ? 'Send me a link' : 'Sign in'}
      </button>
      {err && <div className="err">{err}</div>}

      <button
        type="button" className="linkish"
        onClick={() => { setMode(mode === 'in' ? 'reset' : 'in'); setErr(''); }}
      >
        {mode === 'in' ? 'Forgot your password?' : 'Back to sign in'}
      </button>
    </form>
  );
}
