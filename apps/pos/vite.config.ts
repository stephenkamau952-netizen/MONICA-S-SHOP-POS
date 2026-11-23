import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Build output goes to the repo-root ./dist, which wrangler.jsonc serves as
// static assets. In development, /api is proxied to `wrangler dev` (port 8787).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
});
