import { describe, test, expect } from 'vitest';
import { createSessionSalt, hashSecret, sourceLineHash } from '../../server/pipeline/redactor';

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
