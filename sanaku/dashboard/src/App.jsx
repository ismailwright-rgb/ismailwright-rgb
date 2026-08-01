import { useEffect, useState } from 'react';
import { supabase } from './supabase.js';
import Login from './Login.jsx';
import Pipeline from './Pipeline.jsx';
import Clients from './Clients.jsx';
import Earnings from './Earnings.jsx';

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = loading
  const [page, setPage] = useState('pipeline');

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) return null;
  if (!session) return <Login />;

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
        <button className="signout" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
      <div className="page">
        {page === 'pipeline' ? <Pipeline /> : page === 'clients' ? <Clients /> : <Earnings />}
      </div>
    </>
  );
}
