import { useEffect, useState } from 'react';
import { supabase } from './supabase.js';
import Login from './Login.jsx';
import Pipeline from './Pipeline.jsx';
import Clients from './Clients.jsx';
import Earnings from './Earnings.jsx';
import Portal from './Portal.jsx';

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = still loading
  const [isStaff, setIsStaff] = useState(null);      // null = not yet resolved
  const [page, setPage] = useState('pipeline');

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      setIsStaff(null);
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
  if (isStaff === null) return null;
  if (!isStaff) return <Portal onSignOut={signOut} />;

  return (
    <>
      <div className="topbar">
        <span className="brand">SANAKU</span>
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
        <button className="signout" onClick={signOut}>Sign out</button>
      </div>
      <div className="page">
        {page === 'pipeline' ? <Pipeline /> : page === 'clients' ? <Clients /> : <Earnings />}
      </div>
    </>
  );
}
