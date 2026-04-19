import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const SHOT_DIR = path.join(process.cwd(), '.peek-build/e2e/screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const shot = (page: Page, name: string): Promise<Buffer> =>
  page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: false });

const API = 'http://localhost:7334';

type ApiEvent = {
  id: string;
  kind: 'span' | 'ledger';
  introducedBySpanId?: string;
  contentRedacted?: string;
};

async function api<T>(p: string): Promise<T> {
  const r = await fetch(`${API}${p}`);
  return (await r.json()) as T;
}

async function openSession(page: Page): Promise<string> {
  const sessions = await api<{ id: string }[]>('/api/sessions');
  const sid = sessions[0].id;
  await page.goto('/');
  await page.waitForSelector('[data-testid="session-picker"] select');
  await page.locator('[data-testid="session-picker"] select').selectOption(sid);
  await page.waitForSelector('[data-testid="timeline-row"]', { timeout: 10000 });
  return sid;
}

async function clickRowWithRedactedLedger(page: Page, sid: string): Promise<void> {
  const events = await api<ApiEvent[]>(`/api/sessions/${sid}/events`);
  const redactedLedger = events.find(
    (e) => e.kind === 'ledger' && e.contentRedacted?.includes('<secret:')
  );
  expect(redactedLedger, 'a redacted ledger entry must exist').toBeDefined();
  const spanId = redactedLedger!.introducedBySpanId;
  expect(spanId, 'ledger must link to a span').toBeDefined();
  const sel = `[data-testid="timeline-row"][data-span-id="${spanId}"]`;
  // Scroll into view
  for (let i = 0; i < 15; i++) {
    if ((await page.locator(sel).count()) > 0) break;
    await page.locator('[data-testid="timeline"]').evaluate((el) => el.scrollBy(0, 600));
    await page.waitForTimeout(80);
  }
  await page.locator(sel).first().click();
  await page.waitForSelector('[data-testid="inspector"][data-open="true"]', { timeout: 5000 });
  // Expand the collapsed 'context ledger' <details> so unmask-text becomes visible
  const ledgerSummary = page.locator('summary', { hasText: /context ledger/i }).first();
  if ((await ledgerSummary.count()) > 0) {
    await ledgerSummary.click();
    await page.waitForTimeout(200);
  }
}

test.describe.configure({ mode: 'serial' });

test.describe('Phase 8 Unmask + redaction (UI)', () => {
  test('8.6 Inspector shows <secret:…> for redacted entry', async ({ page }) => {
    const sid = await openSession(page);
    await clickRowWithRedactedLedger(page, sid);
    const unmaskText = page.locator('[data-testid="unmask-text"]').first();
    await expect(unmaskText).toBeVisible();
    const text = (await unmaskText.textContent()) ?? '';
    expect(text).toMatch(/<secret:[a-f0-9]{8}>/);
    expect(text).not.toContain('sk-ant-api03-TEST-SECRET-');
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    await shot(page, '8.6-redacted-ui');
  });

  test('8.7 Click unmask → POST /api/unmask + plaintext in DOM', async ({ page }) => {
    const sid = await openSession(page);
    await clickRowWithRedactedLedger(page, sid);
    const requests: { url: string; headers: Record<string, string> }[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/unmask')) {
        requests.push({ url: req.url(), headers: req.headers() });
      }
    });
    const responses: { url: string; headers: Record<string, string>; status: number }[] = [];
    page.on('response', (res) => {
      if (res.url().includes('/api/unmask')) {
        responses.push({ url: res.url(), headers: res.headers(), status: res.status() });
      }
    });
    // find the first unmask button in inspector
    const unmaskBtn = page
      .locator('[data-testid="unmask-container"]')
      .first()
      .locator('button')
      .first();
    await expect(unmaskBtn).toBeVisible();
    await unmaskBtn.click();
    await page.waitForTimeout(800);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0].headers['x-unmask-confirm']).toBe('1');
    expect(responses.length).toBeGreaterThan(0);
    expect(responses[0].status).toBe(200);
    expect((responses[0].headers['cache-control'] ?? '').toLowerCase()).toContain('no-store');
    const unmaskText = page.locator('[data-testid="unmask-text"]').first();
    const text = (await unmaskText.textContent()) ?? '';
    // Plaintext reveal: one of the seeded secrets should now appear
    expect(
      text.includes('sk-ant-api03-TEST-SECRET-') || text.includes('AKIAIOSFODNN7EXAMPLE')
    ).toBe(true);
    await shot(page, '8.7-unmask-shown');
  });

  test('8.8 Close + reopen → redacted again (no cached plaintext)', async ({ page }) => {
    const sid = await openSession(page);
    await clickRowWithRedactedLedger(page, sid);
    // Unmask first
    await page.locator('[data-testid="unmask-container"] button').first().click();
    await page.waitForTimeout(500);
    // Close drawer via Esc
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    // Re-click same row
    const events = await api<ApiEvent[]>(`/api/sessions/${sid}/events`);
    const rl = events.find((e) => e.kind === 'ledger' && e.contentRedacted?.includes('<secret:'));
    const sel = `[data-testid="timeline-row"][data-span-id="${rl!.introducedBySpanId}"]`;
    await page.locator(sel).first().click();
    await page.waitForSelector('[data-testid="inspector"][data-open="true"]');
    const text = (await page.locator('[data-testid="unmask-text"]').first().textContent()) ?? '';
    expect(text).toMatch(/<secret:[a-f0-9]{8}>/);
    expect(text).not.toContain('sk-ant-api03-TEST-SECRET-');
  });
});
