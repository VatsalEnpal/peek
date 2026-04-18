import { describe, it, expect } from 'vitest';
import { detectSecrets } from '../../server/pipeline/secretlint-adapter';

describe('detectSecrets', () => {
  it('detects Anthropic + AWS keys in the same string, sorted by start', () => {
    const content =
      'aws=AKIAIOSFODNN7EXAMPLE and anthropic=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF end';
    const found = detectSecrets(content);
    expect(found).toHaveLength(2);
    // sorted ascending by start
    expect(found[0].start).toBeLessThan(found[1].start);
    const patterns = found.map((m) => m.pattern);
    expect(patterns).toContain('anthropic-api03');
    expect(patterns).toContain('aws-access-key-id');
  });

  it('detects AWS access key id AKIAIOSFODNN7EXAMPLE', () => {
    const content = 'ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE"';
    const found = detectSecrets(content);
    expect(found).toHaveLength(1);
    expect(found[0].pattern).toBe('aws-access-key-id');
    expect(found[0].matched).toBe('AKIAIOSFODNN7EXAMPLE');
  });

  it('returns no detections in a clean string', () => {
    const content = 'this text has no secrets, just AKIA and sk-ant prefixes.';
    expect(detectSecrets(content)).toEqual([]);
  });

  it('returns correct UTF-8 byte offsets when content contains multi-byte characters', () => {
    const prefix = '📎 ';
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';
    const content = `${prefix}${key}`;
    const found = detectSecrets(content);
    expect(found).toHaveLength(1);
    const prefixBytes = Buffer.byteLength(prefix, 'utf8'); // 4 bytes (📎) + 1 (space) = 5
    expect(found[0].start).toBe(prefixBytes);
    expect(found[0].end).toBe(prefixBytes + Buffer.byteLength(key, 'utf8'));
    // the start index is NOT the JS code-unit index (which is 3 for "📎 ")
    expect(found[0].start).not.toBe(content.indexOf(key));
  });
});
