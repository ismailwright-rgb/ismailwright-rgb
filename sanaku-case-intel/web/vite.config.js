import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxies /theme, /cases, /ask, /transcribe, /speak, /branding-assets to
// the FastAPI backend (api/main.py, port 8000 by default) during `npm
// run dev`, so the app code always calls same-origin paths - no API base
// URL hardcoded into the client bundle, and no CORS involved once this
// is built and served for real. The '/ask' entry is a prefix match (Vite's
// proxy keys match by startsWith, not exact path) so it already covers
// POST /ask/stream too - verified directly, not assumed, after the
// earlier /transcribe-missing bug taught not to guess about this file.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/theme': 'http://localhost:8000',
      '/cases': 'http://localhost:8000',
      '/ask': 'http://localhost:8000',
      '/transcribe': 'http://localhost:8000',
      '/speak': 'http://localhost:8000',
      '/branding-assets': 'http://localhost:8000',
    },
  },
});
