import { describe, it, expect } from 'vitest';
import { anthropicRule } from '../src/index';

describe('anthropicRule', () => {
  it('detects sk-ant-api03 keys with pattern anthropic-api03', () => {
    const content = 'token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF more text';
    const matches = anthropicRule.detect(content);
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern).toBe('anthropic-api03');
    expect(matches[0].matched.startsWith('sk-ant-api03-')).toBe(true);
    // start is the index of 's' in 'sk-ant-api03-...'
    expect(content.slice(matches[0].start, matches[0].end)).toBe(matches[0].matched);
  });

  it('detects sk-ant-admin01 keys with pattern anthropic-admin01', () => {
    const content = 'ADMIN=sk-ant-admin01-ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210_foo';
    const matches = anthropicRule.detect(content);
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern).toBe('anthropic-admin01');
    expect(matches[0].matched.startsWith('sk-ant-admin01-')).toBe(true);
  });

  it('does not false-positive on short sk-ant-abc prefix', () => {
    const content = 'this is just a short sk-ant-abc literal, not a key';
    const matches = anthropicRule.detect(content);
    expect(matches).toHaveLength(0);
  });
});
