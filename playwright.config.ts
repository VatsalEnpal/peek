import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: '.peek-build/e2e/playwright-report.json' }]],
  use: {
    baseURL: 'http://localhost:7334',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
