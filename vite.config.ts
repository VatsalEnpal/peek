import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    port: 7334,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:7334',
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    // Drop source maps from production builds (I6 from code review). They
    // leak absolute file paths from the build host and add ~1.6MB to the
    // shipped bundle with no end-user benefit. Kept in dev mode only.
    sourcemap: mode === 'development',
  },
}));
