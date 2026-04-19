import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const SHOT_DIR = path.join(process.cwd(), '.peek-build/e2e/screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const shot = (page: Page, name: string): Promise<Buffer> =>
  page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: false });

const API = 'http://localhost:7334';

async function api<T>(p: string): Promise<T> {
  const r = await fetch(`${API}${p}`);
  return (await r.json()) as T;
}

test('7.5 UI shows marker bookmark in session picker', async ({ page }) => {
  const sessions = await api<{ id: string }[]>('/api/sessions');
  expect(sessions.length).toBeGreaterThan(0);
  const sid = sessions[0].id;
  await page.goto('/');
  await page.waitForSelector('[data-testid="session-picker"] select');
  await page.locator('[data-testid="session-picker"] select').selectOption(sid);
  await page.waitForTimeout(400);
  await page.locator(`[data-testid="session-expand-${sid}"]`).click();
  await page.waitForSelector(`[data-testid="bookmarks-${sid}"]`, { timeout: 3000 });
  const labels = await page.locator(`[data-testid^="bookmark-"]`).allTextContents();
  expect(labels.some((t) => t.includes('do something'))).toBe(true);
  await shot(page, '7.5-marker-bookmark');
});
