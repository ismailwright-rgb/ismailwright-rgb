import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxies /theme, /cases, /ask, /transcribe, /speak, /manual-entries,
// /branding-assets to the FastAPI backend (api/main.py, port 8001 by
// default) during `npm run dev`, so the app code always calls same-origin
// paths - no API base URL hardcoded into the client bundle, and no CORS
// involved once this is built and served for real. The '/ask' entry is a
// prefix match (Vite's proxy keys match by startsWith, not exact path) so
// it already covers POST /ask/stream too - verified directly, not
// assumed, after the earlier /transcribe-missing bug taught not to guess
// about this file. '/manual-entries' needs its own explicit entry, not
// covered by any existing prefix.
//
// Port is 8001, not the more conventional 8000 - moved here after a real
// port collision on a real Mac: an unrelated program already listening on
// 8000 (nothing to do with this project) silently intercepted every API
// call, returning its own 404 page for everything - no case list, no
// transcription, nothing worked, and every symptom looked like a bug in
// this app until `lsof -i :8000` identified the real process. 8001 avoids
// fighting over a commonly-used port; change both this file and the
// `uvicorn --port` flag together if 8001 ever collides on your own
// machine too.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/theme': 'http://localhost:8001',
      '/cases': 'http://localhost:8001',
      '/ask': 'http://localhost:8001',
      '/transcribe': 'http://localhost:8001',
      '/speak': 'http://localhost:8001',
      '/manual-entries': 'http://localhost:8001',
      '/branding-assets': 'http://localhost:8001',
    },
  },
});
