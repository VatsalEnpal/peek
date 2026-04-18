import { describe, test, expect } from 'vitest';
import { reconcileSubagentTokens } from '../../server/pipeline/self-check';

describe('reconcileSubagentTokens', () => {
  test('zero drift → match: true with drift 0', () => {
    const result = reconcileSubagentTokens({
      parentReported: 1000,
      childTokens: [400, 600],
    });
    expect(result.match).toBe(true);
    expect(result.drift).toBe(0);
  });

  test('drift 0.1% (within default 0.5% threshold) → match: true', () => {
    // parent=1000, childSum=1001 → drift = 0.001 = 0.1%
    const result = reconcileSubagentTokens({
      parentReported: 1000,
      childTokens: [500, 501],
    });
    expect(result.match).toBe(true);
    expect(result.drift).toBeCloseTo(0.001, 6);
  });

  test('drift 1% (exceeds default 0.5% threshold) → match: false with descriptive loud message', () => {
    // parent=1000, childSum=1010 → drift = 0.01 = 1%
    const result = reconcileSubagentTokens({
      parentReported: 1000,
      childTokens: [500, 510],
    });
    expect(result.match).toBe(false);
    expect(result.drift).toBeCloseTo(0.01, 6);
    if (result.match === false) {
      expect(result.loud.toLowerCase()).toContain('drift');
      // Must include parent reported total and child sum
      expect(result.loud).toContain('1000');
      expect(result.loud).toContain('1010');
    }
  });

  test('parentReported = 0 and childSum = 0 → match: true', () => {
    const result = reconcileSubagentTokens({
      parentReported: 0,
      childTokens: [],
    });
    expect(result.match).toBe(true);
    expect(result.drift).toBe(0);
  });

  test('parentReported = 0 and childSum = 5 → match: false with Infinity drift', () => {
    const result = reconcileSubagentTokens({
      parentReported: 0,
      childTokens: [2, 3],
    });
    expect(result.match).toBe(false);
    expect(result.drift).toBe(Infinity);
    if (result.match === false) {
      expect(result.loud.toLowerCase()).toContain('drift');
      expect(result.loud).toContain('0');
      expect(result.loud).toContain('5');
    }
  });

  test('custom threshold 0.02 (2%) allows 1.5% drift as match', () => {
    // parent=1000, childSum=1015 → drift = 0.015 = 1.5%
    const result = reconcileSubagentTokens(
      {
        parentReported: 1000,
        childTokens: [500, 515],
      },
      0.02
    );
    expect(result.match).toBe(true);
    expect(result.drift).toBeCloseTo(0.015, 6);
  });

  test('loud message format includes drift %, parent total, child sum, and threshold', () => {
    const result = reconcileSubagentTokens({
      parentReported: 1000,
      childTokens: [1012],
    });
    expect(result.match).toBe(false);
    if (result.match === false) {
      // Should mention the percentages/thresholds
      expect(result.loud).toMatch(/1\.2/); // 1.2% drift
      expect(result.loud).toContain('1000');
      expect(result.loud).toContain('1012');
      expect(result.loud).toMatch(/0\.50/); // 0.50% threshold
    }
  });
});
