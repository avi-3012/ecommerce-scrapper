import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Dev-only: the API serves the built SPA itself in staging/production, so
      // there Origin and Host match naturally. Behind this proxy they don't —
      // the browser's Origin is :5173 while the request reaches the API as
      // :3000 — which trips the API's same-origin CSRF guard on every mutating
      // request. Rewrite the Origin to the target so Origin host === Host.
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('origin', 'http://localhost:3000');
          });
        },
      },
    },
  },
});
