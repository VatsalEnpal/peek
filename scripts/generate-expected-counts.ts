#!/usr/bin/env -S node --import tsx/esm
/**
 * Generate expected-counts.json from real-session.jsonl.
 * Script only — the current tests/fixtures/expected-counts.json was hand-seeded
 * and is protected by protect-files.sh. Re-running this script regenerates it
 * when the fixture is updated.
 *
 * Usage: npx tsx scripts/generate-expected-counts.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseJsonl } from '../server/pipeline/parser';

const FIXTURE = resolve('tests/fixtures/isolated-claude-projects/real-session.jsonl');
const OUT = resolve('tests/fixtures/expected-counts.json');

type AssistantEvent = {
  type: 'assistant';
  sessionId?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    content?: Array<{ type: string; text?: string }>;
  };
};

function main(): void {
  const raw = readFileSync(FIXTURE, 'utf8');
  const { events } = parseJsonl(raw);
  const assistants = events.filter((e: AssistantEvent) => e.type === 'assistant');

  const sessionId =
    (events.find((e: any) => e.sessionId)?.sessionId as string | undefined) ?? 'unknown';

  const turnSample = assistants.slice(0, 5).map((e: AssistantEvent) => ({
    model: e.message?.model ?? 'unknown',
    input_tokens: e.message?.usage?.input_tokens ?? 0,
    cache_creation_input_tokens: e.message?.usage?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: e.message?.usage?.cache_read_input_tokens ?? 0,
    output_tokens: e.message?.usage?.output_tokens ?? 0,
  }));

  let maxInput = 0;
  let maxCacheCreation = 0;
  let sumOutput = 0;
  for (const e of assistants as AssistantEvent[]) {
    const u = e.message?.usage;
    if (!u) continue;
    maxInput = Math.max(maxInput, u.input_tokens ?? 0);
    maxCacheCreation = Math.max(maxCacheCreation, u.cache_creation_input_tokens ?? 0);
    sumOutput += u.output_tokens ?? 0;
  }

  const out = {
    sessionId,
    source: 'real-session.jsonl',
    note: 'Extracted from real Claude Code session. Ground truth for A2 acceptance test.',
    totalAssistantTurns: assistants.length,
    turnSample,
    maxInputTokens: maxInput,
    maxCacheCreation,
    sumOutputTokens: sumOutput,
  };

  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
  // eslint-disable-next-line no-console
  console.log(`generated ${OUT}: ${assistants.length} assistant turns, sumOutput=${sumOutput}`);
}

main();
