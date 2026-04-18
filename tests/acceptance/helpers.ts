// Karpathy acceptance test helpers. DO NOT edit during overnight /loop run.
// This file is part of tests/acceptance/** which is protected by protect-files.sh.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function sha256OfFile(path: string): string {
  const content = readFileSync(path);
  return createHash('sha256').update(content).digest('hex');
}

export function sha256OfDirectory(dir: string): string {
  const entries = readdirSync(dir).sort();
  const hasher = createHash('sha256');
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    hasher.update(entry);
    if (st.isDirectory()) {
      hasher.update(sha256OfDirectory(full));
    } else {
      hasher.update(sha256OfFile(full));
    }
  }
  return hasher.digest('hex');
}

// Placeholders — these import from server/pipeline once those modules exist.
// Until then, tests should fail with "module not found" (that's the Karpathy baseline).

export async function importFromDirectory(path: string): Promise<void> {
  const { importPath } = await import('../../server/pipeline/import');
  await importPath(path, { dataDir: process.env.PEEK_TEST_DATA_DIR ?? '/tmp/peek-test-data' });
}

export async function importFixture(path: string): Promise<any> {
  const { importPath } = await import('../../server/pipeline/import');
  return await importPath(path, { dataDir: process.env.PEEK_TEST_DATA_DIR ?? '/tmp/peek-test-data', returnAssembled: true });
}

export async function countImportedSessions(): Promise<number> {
  const { Store } = await import('../../server/pipeline/store');
  const store = new Store(process.env.PEEK_TEST_DATA_DIR ?? '/tmp/peek-test-data');
  return store.listSessions().length;
}

export async function anthropicCountTokens(content: string): Promise<number> {
  const { countTokensViaAPI } = await import('../../server/pipeline/tokenizer');
  return await countTokensViaAPI(content, 'claude-opus-4-7');
}

export async function readDbAsText(): Promise<string> {
  const { Store } = await import('../../server/pipeline/store');
  const store = new Store(process.env.PEEK_TEST_DATA_DIR ?? '/tmp/peek-test-data');
  return store.dumpAsText();
}

export async function findRedactedHash(dbText: string, marker: string): Promise<string | null> {
  const m = dbText.match(new RegExp(`${marker}.{0,50}<secret:([a-f0-9]{8})>`, 's'));
  return m ? m[1] : null;
}

export function sumChildTokens(span: any, session: any): number {
  let total = 0;
  function walk(spanId: string) {
    const s = session.spans.find((x: any) => x.id === spanId);
    if (!s) return;
    total += s.tokensConsumed ?? 0;
    for (const childId of s.childSpanIds ?? []) walk(childId);
  }
  for (const childId of span.childSpanIds ?? []) walk(childId);
  return total;
}

export async function dockerBuild(dockerfile: string): Promise<void> {
  const { execSync } = await import('node:child_process');
  execSync(`docker build -t peek-verify -f ${dockerfile} .`, { stdio: 'inherit' });
}

export async function dockerRun(opts: { cmd: string[]; volumes?: Record<string, string> }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { execSync } = await import('node:child_process');
  const volumeArgs = Object.entries(opts.volumes ?? {})
    .map(([host, container]) => `-v "${process.cwd()}/${host}:${container}"`)
    .join(' ');
  try {
    const stdout = execSync(`docker run --rm ${volumeArgs} peek-verify ${opts.cmd.join(' ')}`, { encoding: 'utf8' });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (e: any) {
    return { exitCode: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
  }
}
