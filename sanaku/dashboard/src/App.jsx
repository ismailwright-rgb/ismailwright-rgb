import { useEffect, useState } from 'react';
import { supabase } from './supabase.js';
import Login from './Login.jsx';
import Pipeline from './Pipeline.jsx';
import Clients from './Clients.jsx';
import Earnings from './Earnings.jsx';
import Portal from './Portal.jsx';
import SetPassword from './SetPassword.jsx';

function ThemeToggle() {
  const [theme, setTheme] = useState(() => localStorage.getItem('sanaku-theme') || 'auto');

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    localStorage.setItem('sanaku-theme', theme);
  }, [theme]);

  // auto -> light -> dark -> auto. 'auto' follows the operating system.
  const next = { auto: 'light', light: 'dark', dark: 'auto' }[theme];
  const label = { auto: 'Auto', light: 'Light', dark: 'Dark' }[theme];
  return (
    <button
      className="signout"
      onClick={() => setTheme(next)}
      title={`Theme: ${label}. Click for ${next}.`}
      aria-label={`Theme: ${label}`}
    >
      {label}
    </button>
  );
}

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = still loading
  const [isStaff, setIsStaff] = useState(null);      // null = not yet resolved
  const [page, setPage] = useState('pipeline');
  // An invite or reset link signs the person in and drops a type= marker in
  // the URL fragment. Both have to end at "choose a password", or an invited
  // client never has one and cannot return.
  const [needsPassword, setNeedsPassword] = useState(
    () => /type=(invite|recovery|signup)/.test(window.location.hash || '')
  );

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      setIsStaff(null);
      if (event === 'PASSWORD_RECOVERY') setNeedsPassword(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // One round trip decides which application this person sees. RLS enforces the
  // split regardless; this only keeps a client from staring at empty operator UI.
  useEffect(() => {
    if (!session) { setIsStaff(null); return; }
    let cancelled = false;
    supabase.rpc('sanaku_is_staff').then(({ data, error }) => {
      if (cancelled) return;
      // Before migration-004 the function doesn't exist yet - assume operator,
      // since the only account that can exist at that point is yours.
      setIsStaff(error ? true : data === true);
    });
    return () => { cancelled = true; };
  }, [session]);

  const signOut = () => supabase.auth.signOut();

  if (session === undefined) return null;
  if (!session) return <Login />;
  if (needsPassword) return <SetPassword onDone={() => setNeedsPassword(false)} />;
  if (isStaff === null) return null;
  if (!isStaff) return <Portal onSignOut={signOut} />;

  return (
    <>
      <div className="topbar">
        <span className="brand">SANAKU<span className="dot">.</span></span>
        <nav>
          <button className={page === 'pipeline' ? 'active' : ''} onClick={() => setPage('pipeline')}>
            Pipeline
          </button>
          <button className={page === 'clients' ? 'active' : ''} onClick={() => setPage('clients')}>
            Clients
          </button>
          <button className={page === 'earnings' ? 'active' : ''} onClick={() => setPage('earnings')}>
            Earnings
          </button>
        </nav>
        <span className="spacer" />
        <ThemeToggle />
        <button className="signout" onClick={signOut}>Sign out</button>
      </div>
      <div className="page">
        {page === 'pipeline' ? <Pipeline /> : page === 'clients' ? <Clients /> : <Earnings />}
      </div>
    </>
  );
}
