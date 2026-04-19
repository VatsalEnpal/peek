import { test, expect } from '@playwright/test';

const API = 'http://localhost:7334';

test('9.5 Session picker shows 3 distinguishable sessions', async ({ page }) => {
  const sessions = await (await fetch(`${API}/api/sessions`)).json();
  expect(sessions.length).toBe(3);
  await page.goto('/');
  await page.waitForSelector('[data-testid="session-picker"] select');
  const options = await page
    .locator('[data-testid="session-picker"] select option')
    .allTextContents();
  const nonEmpty = options.filter((o) => o.trim().length > 0);
  expect(nonEmpty.length).toBe(3);

  // First 40 chars of each should be distinct
  const first40 = new Set(nonEmpty.map((o) => o.slice(0, 40)));
  expect(first40.size).toBe(3);

  await page.screenshot({ path: '.peek-build/e2e/screenshots/9.5-identity-labels.png' });
});
