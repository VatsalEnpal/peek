import { describe, test, expect } from 'vitest';
import {
  createSessionSalt,
  hashSecret,
  sourceLineHash,
  detectEnvVars,
} from '../../server/pipeline/redactor';

describe('redactor: session salt + hashing (Task 3.1)', () => {
  test('createSessionSalt returns 64-char hex', () => {
    const salt = createSessionSalt();
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
  });

  test('createSessionSalt is non-deterministic across calls', () => {
    const a = createSessionSalt();
    const b = createSessionSalt();
    expect(a).not.toEqual(b);
  });

  test('hashSecret returns 8-char hex', () => {
    const salt = '0'.repeat(64);
    const h = hashSecret('my-secret', salt);
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  test('hashSecret is deterministic for same (value, salt)', () => {
    const salt = 'abcd'.repeat(16);
    expect(hashSecret('x', salt)).toEqual(hashSecret('x', salt));
  });

  test('hashSecret differs across salts', () => {
    expect(hashSecret('x', '0'.repeat(64))).not.toEqual(hashSecret('x', '1'.repeat(64)));
  });

  test('sourceLineHash returns 64-char hex, deterministic', () => {
    const h = sourceLineHash('{"type":"user"}');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toEqual(sourceLineHash('{"type":"user"}'));
  });
});

describe('redactor: env-var heuristic (Task 3.3)', () => {
  test('detects ANTHROPIC_API_KEY=... value', () => {
    const content = 'set ANTHROPIC_API_KEY=sk-foo-bar here';
    const matches = detectEnvVars(content);
    expect(matches).toHaveLength(1);
    expect(matches[0].varName).toBe('ANTHROPIC_API_KEY');
    expect(matches[0].value).toBe('sk-foo-bar');
    expect(content.slice(matches[0].start, matches[0].end)).toBe('sk-foo-bar');
  });

  test('detects *_TOKEN, *_SECRET, *_PASSWORD, *_PWD', () => {
    const content = 'GITHUB_TOKEN=ghp_123 DB_PASSWORD=p@ss AWS_SECRET=abc PG_PWD=xyz';
    const ms = detectEnvVars(content);
    expect(ms.map((m) => m.varName).sort()).toEqual([
      'AWS_SECRET',
      'DB_PASSWORD',
      'GITHUB_TOKEN',
      'PG_PWD',
    ]);
  });

  test('ignores unrelated assignments like BAR=safe or result: 42', () => {
    expect(detectEnvVars('BAR=safe result: 42')).toEqual([]);
  });

  test('handles quoted values (double, single, backtick)', () => {
    const ms = detectEnvVars(
      `API_KEY="quoted-value" MY_TOKEN='single-quoted' RAW_SECRET=\`tick-quoted\``
    );
    expect(ms.map((m) => m.value)).toEqual(['quoted-value', 'single-quoted', 'tick-quoted']);
  });

  test('non-matching prefix (lowercase name) is ignored', () => {
    expect(detectEnvVars('api_key=sk-foo')).toEqual([]);
  });

  test('byte offsets are correct for multi-byte content', () => {
    const content = '📎 ANTHROPIC_API_KEY=sk-foo';
    const ms = detectEnvVars(content);
    expect(ms).toHaveLength(1);
    const bytes = Buffer.from(content, 'utf8');
    expect(bytes.slice(ms[0].start, ms[0].end).toString('utf8')).toBe('sk-foo');
  });
});
