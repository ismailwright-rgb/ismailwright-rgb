import { useState } from 'react';
import { supabase } from './supabase.js';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setErr(error.message);
    setBusy(false);
  }

  return (
    <form className="login" onSubmit={submit}>
      <h1>SANAKU<span className="dot">.</span></h1>
      <p>Command center. Sign in to work the pipeline.</p>
      <label>Email</label>
      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <label>Password</label>
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      {err && <div className="err">{err}</div>}
    </form>
  );
}
