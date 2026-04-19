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
    // tests/e2e/live-flow.spec.ts is Playwright-only; run it with
    // `npx playwright test tests/e2e/live-flow.spec.ts`. The pre-existing
    // tests/e2e/phase*.spec.ts have a known Playwright-under-vitest
    // misconfig documented in docs/plans/v0.2.1-live-mode.md — leave
    // those alone for now (they're ignored by consumers via the
    // `test:unit` / `test:integration` / `test:acceptance` scripts).
    exclude: ['node_modules', 'tests/e2e/live-flow.spec.ts'],
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
