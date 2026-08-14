import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  server: {
    // `bun run dev` serves the SPA here and proxies data calls to `wrangler dev`.
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/invoice': 'http://127.0.0.1:8787',
    },
  },
});
