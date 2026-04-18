import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    testTimeout: 60_000,
    hookTimeout: 30_000,
    include: ['tests/**/*.{test,spec}.{ts,tsx}', 'packages/**/tests/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules'],
    // Default env is node; UI tests opt-in via the `// @vitest-environment happy-dom`
    // pragma at the top of the spec file. Keeps server/unit tests running fast in node.
    environment: 'node',
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@server': resolve(__dirname, 'server'),
    },
  },
});
