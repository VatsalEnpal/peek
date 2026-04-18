import { describe, test, expect } from 'vitest';
import {
  createSessionSalt,
  hashSecret,
  sourceLineHash,
  detectEnvVars,
  redactBlock,
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

describe('redactor: redactBlock orchestration (Task 3.4)', () => {
  const SALT = 'a'.repeat(64);
  const ANTHROPIC_KEY = 'sk-ant-api03-' + 'A'.repeat(40);
  const ANTHROPIC_KEY2 = 'sk-ant-api03-' + 'B'.repeat(40);
  const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

  function makeLine(content: string): {
    lineBytes: Buffer;
    contentRange: { start: number; end: number };
  } {
    const prefix = '{"type":"user","text":"';
    const suffix = '"}';
    const full = prefix + content + suffix;
    const lineBytes = Buffer.from(full, 'utf8');
    const start = Buffer.byteLength(prefix, 'utf8');
    const end = start + Buffer.byteLength(content, 'utf8');
    return { lineBytes, contentRange: { start, end } };
  }

  test('redacts known Anthropic key and emits stable hash for same key twice', () => {
    const content = `first: ${ANTHROPIC_KEY} and again: ${ANTHROPIC_KEY}`;
    const { lineBytes, contentRange } = makeLine(content);
    const result = redactBlock(content, SALT, 'session.jsonl', lineBytes, contentRange);
    const expectedHash = hashSecret(ANTHROPIC_KEY, SALT);
    const token = `<secret:${expectedHash}>`;
    expect(result.redacted).toBe(`first: ${token} and again: ${token}`);
    expect(result.redacted).toMatch(/<secret:[a-f0-9]{8}>/);
    expect(result.detections).toHaveLength(2);
    expect(result.detections[0].hash).toBe(expectedHash);
    expect(result.detections[1].hash).toBe(expectedHash);
    expect(result.detections[0].pattern).toBe('anthropic-api03');
  });

  test('redacts AWS access key AKIAIOSFODNN7EXAMPLE', () => {
    const content = `aws key is ${AWS_KEY} here`;
    const { lineBytes, contentRange } = makeLine(content);
    const result = redactBlock(content, SALT, 'src.jsonl', lineBytes, contentRange);
    const expectedHash = hashSecret(AWS_KEY, SALT);
    expect(result.redacted).toBe(`aws key is <secret:${expectedHash}> here`);
    expect(result.detections).toHaveLength(1);
    expect(result.detections[0].pattern).toBe('aws-access-key-id');
    expect(result.detections[0].hash).toBe(expectedHash);
  });

  test('redacts env-var value', () => {
    const content = 'ANTHROPIC_API_KEY=sk-foo-bar in the env';
    const { lineBytes, contentRange } = makeLine(content);
    const result = redactBlock(content, SALT, 'src.jsonl', lineBytes, contentRange);
    const expectedHash = hashSecret('sk-foo-bar', SALT);
    expect(result.redacted).toBe(`ANTHROPIC_API_KEY=<secret:${expectedHash}> in the env`);
    expect(result.detections).toHaveLength(1);
    expect(result.detections[0].pattern).toBe('env:ANTHROPIC_API_KEY');
    expect(result.detections[0].hash).toBe(expectedHash);
  });

  test('passes through content with no secrets unchanged', () => {
    const content = 'totally benign content: result=42, note=ok';
    const { lineBytes, contentRange } = makeLine(content);
    const result = redactBlock(content, SALT, 'src.jsonl', lineBytes, contentRange);
    expect(result.redacted).toBe(content);
    expect(result.detections).toEqual([]);
  });

  test('sourceOffset populated from args and sourceLineHash is 64-char hex', () => {
    const content = 'hello world';
    const { lineBytes, contentRange } = makeLine(content);
    const result = redactBlock(content, SALT, 'my/session.jsonl', lineBytes, contentRange);
    expect(result.sourceOffset.file).toBe('my/session.jsonl');
    expect(result.sourceOffset.byteStart).toBe(contentRange.start);
    expect(result.sourceOffset.byteEnd).toBe(contentRange.end);
    expect(result.sourceOffset.sourceLineHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sourceOffset.sourceLineHash).toBe(sourceLineHash(lineBytes.toString('utf8')));
  });

  test('handles multi-byte (emoji) content with byte-accurate replacement', () => {
    const content = `📎 key=${ANTHROPIC_KEY} 🚀 and ${AWS_KEY} 🎉`;
    const { lineBytes, contentRange } = makeLine(content);
    const result = redactBlock(content, SALT, 'src.jsonl', lineBytes, contentRange);
    const hAnth = hashSecret(ANTHROPIC_KEY, SALT);
    const hAws = hashSecret(AWS_KEY, SALT);
    expect(result.redacted).toBe(`📎 key=<secret:${hAnth}> 🚀 and <secret:${hAws}> 🎉`);
    expect(result.detections).toHaveLength(2);
  });

  test('overlapping detections (env-var whose value contains an anthropic key) not double-replaced', () => {
    const content = `ANTHROPIC_API_KEY=${ANTHROPIC_KEY} rest`;
    const { lineBytes, contentRange } = makeLine(content);
    const result = redactBlock(content, SALT, 'src.jsonl', lineBytes, contentRange);
    // Only one replacement token should appear (no nested <secret:...>)
    const matches = result.redacted.match(/<secret:[a-f0-9]{8}>/g);
    expect(matches).toHaveLength(1);
    expect(result.detections).toHaveLength(1);
    // The detection must not leave behind part of the raw key
    expect(result.redacted).not.toContain('sk-ant-api03-');
    expect(result.redacted).not.toContain('AAAAA');
  });

  test('detections preserved in order of appearance with correct start/end byte offsets', () => {
    const content = `x ${ANTHROPIC_KEY2} y ${AWS_KEY} z`;
    const { lineBytes, contentRange } = makeLine(content);
    const result = redactBlock(content, SALT, 'src.jsonl', lineBytes, contentRange);
    expect(result.detections).toHaveLength(2);
    expect(result.detections[0].start).toBeLessThan(result.detections[1].start);
    const bytes = Buffer.from(content, 'utf8');
    expect(bytes.slice(result.detections[0].start, result.detections[0].end).toString('utf8')).toBe(
      ANTHROPIC_KEY2
    );
    expect(bytes.slice(result.detections[1].start, result.detections[1].end).toString('utf8')).toBe(
      AWS_KEY
    );
  });
});
