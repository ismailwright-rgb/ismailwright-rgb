import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { configError } from './supabase.js';
import './styles.css';

/**
 * The screen that used to be a blank page.
 *
 * Deliberately plain: no theme tokens, no shared components, no data. Whatever
 * is broken enough to land here may also be broken enough to take a fancier
 * component down with it, and a diagnostic that fails to render is worse than
 * no diagnostic. Inline styles for the same reason - this must survive even if
 * the stylesheet did not load.
 */
function ConfigError({ message }) {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center',
      justifyContent: 'center', padding: '24px',
      font: '16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      background: '#faf9f7', color: '#2a2724',
    }}>
      <div style={{ maxWidth: '34rem' }}>
        <div style={{
          fontSize: '.8rem', letterSpacing: '.08em', textTransform: 'uppercase',
          color: '#b4462f', fontWeight: 600, marginBottom: '.5rem',
        }}>
          Dashboard misconfigured
        </div>
        <h1 style={{ fontSize: '1.5rem', margin: '0 0 .75rem', fontWeight: 600 }}>
          This build cannot reach its database.
        </h1>
        <p style={{ margin: '0 0 1rem' }}>{message}</p>
        <p style={{ margin: 0, fontSize: '.9rem', color: '#6b655e' }}>
          Rebuild and redeploy with the variables set:
        </p>
        <pre style={{
          margin: '.5rem 0 0', padding: '.75rem .9rem', overflowX: 'auto',
          background: '#efece7', borderRadius: '6px', fontSize: '.85rem',
        }}>
{`cd sanaku/dashboard
VITE_SUPABASE_URL=... VITE_SUPABASE_ANON_KEY=... npm run build`}
        </pre>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {configError ? <ConfigError message={configError} /> : <App />}
  </React.StrictMode>
);
