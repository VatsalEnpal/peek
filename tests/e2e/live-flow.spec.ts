/**
 * L5.4 — Playwright E2E: live flow under `peek` bare daemon.
 *
 * Contract (from v0.2.1 plan §L5):
 *   1. Start `peek` bare (watch + serve on one port) using a tmp claudeDir.
 *   2. Drop a JSONL under the tmp claudeDir containing /peek_start + a
 *      tool_use + /peek_end.
 *   3. Navigate the UI to the session detail page.
 *   4. Assert the tool_use row is rendered in the timeline.
 *
 * Purpose: exercise the FULL loop — file watcher → importer → marker
 * detector → session/span persistence → SPA fetch → timeline render —
 * without any Vitest harness in the middle. If any of these steps
 * regresses silently, this test fails loudly.
 *
 * Why a dedicated file (rather than augmenting tests/e2e/phase*.spec.ts):
 * the phase* suites were written against Playwright-inside-Vitest (a known
 * misconfig that we're not touching in v0.2.1). We run this one directly
 * under `npx playwright test tests/e2e/live-flow.spec.ts` so its fixture
 * owns the daemon lifecycle explicitly.
 *
 * How to run:
 *   npm run build                                    # compile dist/
 *   npx playwright test tests/e2e/live-flow.spec.ts
 */

import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

type Fixture = {
  port: number;
  dataDir: string;
  claudeDir: string;
  proc: ChildProcess;
};

/**
 * Spawn `node dist/bin/peek.js` (bare) on a random port with the claudeDir
 * and dataDir both pointing at temp directories. Wait until /api/healthz
 * returns 200, then return a handle the test can kill.
 *
 * We pick the port rather than using 0 because `peek` bare doesn't expose
 * the bound port — it logs a fixed line. Random port in the user range
 * avoids CI collisions.
 */
async function spawnPeekBare(): Promise<Fixture> {
  const port = 7337 + Math.floor(Math.random() * 200);
  const dataDir = mkdtempSync(join(tmpdir(), 'peek-e2e-data-'));
  const claudeDir = mkdtempSync(join(tmpdir(), 'peek-e2e-claude-'));

  const proc = spawn(process.execPath, ['dist/bin/peek.js'], {
    env: {
      ...process.env,
      PEEK_PORT: String(port),
      // Overriding HOME is the only way the bare CLI knows where to look.
      HOME: dataDir,
      // dataDir is derived from HOME in bare mode (HOME/.peek). We point
      // HOME at our dataDir so HOME/.peek doesn't collide with the user's.
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Bare peek resolves claudeDir from HOME/.claude/projects, so we wire
  // the claudeDir symlink. We materialise a real dir under HOME/.claude/
  // rather than symlinking to keep fs.watch / chokidar happy.
  const homeClaudeProjects = join(dataDir, '.claude', 'projects');
  mkdirSync(homeClaudeProjects, { recursive: true });
  // Redirect our claudeDir variable so the test writes into the path the
  // daemon is actually watching.
  const resolvedClaudeDir = homeClaudeProjects;

  // Wait for healthz 200.
  const started = Date.now();
  let ready = false;
  while (Date.now() - started < 10_000) {
    try {
      const r = await fetch(`http://localhost:${port}/api/healthz`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {
      // connection refused — daemon still booting
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) {
    proc.kill('SIGTERM');
    throw new Error(`peek daemon did not become ready on port ${port}`);
  }

  return { port, dataDir, claudeDir: resolvedClaudeDir, proc };
}

async function teardown(fx: Fixture): Promise<void> {
  fx.proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 250));
  rmSync(fx.dataDir, { recursive: true, force: true });
  rmSync(fx.claudeDir, { recursive: true, force: true });
}

test.describe('L5.4 — live flow E2E', () => {
  let fx: Fixture;

  test.beforeAll(async () => {
    fx = await spawnPeekBare();
  });

  test.afterAll(async () => {
    await teardown(fx);
  });

  test('drop a JSONL with /peek_start + tool_use → timeline shows the tool_use row', async ({
    page,
  }) => {
    const sessionId = `e2e-live-${Date.now()}`;
    const projectDir = join(fx.claudeDir, 'e2e-project');
    mkdirSync(projectDir, { recursive: true });
    const jsonl = join(projectDir, `${sessionId}.jsonl`);

    const events = [
      {
        type: 'user',
        uuid: 'e2e-u1',
        sessionId,
        cwd: '/tmp',
        gitBranch: 'main',
        version: '1.0.0',
        entrypoint: 'cli',
        timestamp: '2026-04-19T21:00:00Z',
        message: { role: 'user', content: '/peek_start e2e-run' },
      },
      {
        type: 'assistant',
        uuid: 'e2e-a1',
        parentUuid: 'e2e-u1',
        sessionId,
        timestamp: '2026-04-19T21:00:01Z',
        message: {
          role: 'assistant',
          id: 'msg-e2e-1',
          model: 'claude-opus-4-7',
          content: [
            {
              type: 'tool_use',
              id: 'toolu-e2e-1',
              name: 'Bash',
              input: { command: 'ls' },
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 5150,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
      {
        type: 'user',
        uuid: 'e2e-u2',
        parentUuid: 'e2e-a1',
        sessionId,
        timestamp: '2026-04-19T21:00:05Z',
        message: { role: 'user', content: '/peek_end' },
      },
    ];
    writeFileSync(jsonl, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    // Wait for the importer to catch up via the live API. We poll until
    // /api/sessions/<id>/events contains the tool_use span. Upper-bound
    // 5s — chokidar debounce is 100ms, importer is synchronous.
    const start = Date.now();
    let hasToolUse = false;
    while (Date.now() - start < 5000) {
      const r = await fetch(`http://localhost:${fx.port}/api/sessions/${sessionId}/events`);
      if (r.ok) {
        const body = await r.json();
        if (
          Array.isArray(body) &&
          body.some(
            (e: { kind?: string; type?: string }) =>
              e.kind === 'span' && e.type === 'tool_call'
          )
        ) {
          hasToolUse = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(hasToolUse, 'tool_use span should land in API within 5s').toBe(true);

    // Navigate the SPA. The SPA shell comes from the same peek daemon (it
    // serves dist/web/index.html).
    await page.goto(`http://localhost:${fx.port}/session/${sessionId}`);

    // The timeline always renders; its row count depends on what the
    // importer persisted. Assert at least one row, and that a Bash
    // tool_call row is present.
    await page.waitForSelector('[data-testid="timeline"]', { timeout: 5000 });
    const rows = page.locator('[data-testid="timeline-row"]');
    await expect.poll(async () => await rows.count(), { timeout: 5000 }).toBeGreaterThan(0);

    // Look for Bash tool_call row. Timeline rows surface the span type +
    // name; a Bash tool_call should include "Bash" in its row text.
    const pageText = await page.textContent('[data-testid="timeline"]');
    expect(pageText ?? '').toMatch(/Bash/i);

    // Also verify the marker bookmark ('e2e-run' label) is on /api/bookmarks.
    const bmRes = await fetch(`http://localhost:${fx.port}/api/bookmarks`);
    const bms = await bmRes.json();
    expect(
      Array.isArray(bms) && bms.some((b: { label?: string }) => b.label === 'e2e-run')
    ).toBe(true);
  });
});
