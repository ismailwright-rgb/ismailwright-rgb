import { useEffect, useState } from 'react';
import { supabase } from './supabase.js';
import Login from './Login.jsx';
import Pipeline from './Pipeline.jsx';
import Clients from './Clients.jsx';
import Earnings from './Earnings.jsx';
import Marketing from './Marketing.jsx';
import OutreachDrafts from './OutreachDrafts.jsx';
import Portal from './Portal.jsx';
import Factory from './Factory.jsx';
import { BUSINESS_TZ, tzLabel, isAwayFromBusinessTz } from './dates.js';
import SetPassword from './SetPassword.jsx';

/**
 * Two things the operator needs to know when working from somewhere else, and
 * nowhere else in the UI would tell them.
 *
 * Offline: the dashboard is read-mostly and the fetch layer retries GETs, so a
 * brief drop is survivable — but a write attempted while offline will fail, and
 * silently sitting on a stale screen is worse than a line of text saying so.
 *
 * Timezone: every date in here is business time (see dates.js). If you are
 * reading it from Tokyo, "Aug 12" means Aug 12 in California. Without the
 * label, a figure looks like it disagrees with your watch.
 */
function ConnectionBanner() {
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  const [away] = useState(() => isAwayFromBusinessTz());

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  if (!online) {
    return (
      <div className="netbanner off" role="status">
        <b>No connection.</b> Reading will resume on its own; anything you save right now will not go through.
      </div>
    );
  }
  if (away) {
    return (
      <div className="netbanner tz" role="status">
        Dates and totals are shown in business time ({tzLabel()}, {BUSINESS_TZ.split('/')[1].replace('_', ' ')}),
        not your current timezone — so month-end matches the books.
      </div>
    );
  }
  return null;
}

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
  const [preview, setPreview] = useState(null);   // client id, when previewing their portal
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

  // Staff looking at a client's own portal - for a sales call, or to film the
  // demo client. Takes over the whole screen, because half of the point is
  // that the operator chrome is not in the shot.
  if (preview) {
    return (
      <Portal
        previewClientId={preview}
        onSignOut={signOut}
        onExitPreview={() => setPreview(null)}
      />
    );
  }

  return (
    <>
      <ConnectionBanner />
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
          <button className={page === 'outreach' ? 'active' : ''} onClick={() => setPage('outreach')}>
            Outreach
          </button>
          <button className={page === 'marketing' ? 'active' : ''} onClick={() => setPage('marketing')}>
            Marketing
          </button>
          <button className={page === 'factory' ? 'active' : ''} onClick={() => setPage('factory')}>
            Factory
          </button>
        </nav>
        <span className="spacer" />
        <ThemeToggle />
        <button className="signout" onClick={signOut}>Sign out</button>
      </div>
      <div className="page">
        {page === 'pipeline' ? <Pipeline />
          : page === 'clients' ? <Clients onPreview={setPreview} />
          : page === 'outreach' ? <OutreachDrafts />
          : page === 'marketing' ? <Marketing />
          : page === 'factory' ? <Factory />
          : <Earnings />}
      </div>
    </>
  );
}
