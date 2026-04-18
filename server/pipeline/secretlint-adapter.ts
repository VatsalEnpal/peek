/**
 * Secretlint-style detection adapter.
 *
 * Runs the custom @peek/secretlint-rule-anthropic rule plus a built-in
 * AWS access-key-id regex, and returns UTF-8 *byte* offsets sorted by
 * start. Byte offsets (rather than JS code-unit indices) are what the
 * downstream redactor needs so ranges line up with files written via
 * fs.writeFile(..., 'utf8').
 *
 * Overlapping matches are de-duplicated: after sorting by start, any
 * match whose start falls inside the previous match's [start, end)
 * range is dropped. Longer / earlier matches win.
 */

import {
  anthropicRule,
  type DetectionMatch,
} from '../../packages/secretlint-rule-anthropic/src/index';

export type Detection = {
  start: number;
  end: number;
  pattern: string;
  matched: string;
};

const AWS_ACCESS_KEY_ID = /AKIA[0-9A-Z]{16}/g;

type CharOffsetMatch = {
  charStart: number;
  charEnd: number;
  pattern: string;
  matched: string;
};

function runAwsRule(content: string): CharOffsetMatch[] {
  const out: CharOffsetMatch[] = [];
  for (const m of content.matchAll(AWS_ACCESS_KEY_ID)) {
    if (m.index === undefined) continue;
    out.push({
      charStart: m.index,
      charEnd: m.index + m[0].length,
      pattern: 'aws-access-key-id',
      matched: m[0],
    });
  }
  return out;
}

function toCharMatch(m: DetectionMatch): CharOffsetMatch {
  return {
    charStart: m.start,
    charEnd: m.end,
    pattern: m.pattern,
    matched: m.matched,
  };
}

/**
 * Detect secrets in `content`. Returns UTF-8 byte offsets (start/end)
 * sorted ascending by start, with overlapping hits removed.
 */
export function detectSecrets(content: string): Detection[] {
  const raw: CharOffsetMatch[] = [
    ...anthropicRule.detect(content).map(toCharMatch),
    ...runAwsRule(content),
  ];

  // Sort by char start ascending, then by length descending so that
  // when two matches start at the same position the longer one wins.
  raw.sort((a, b) => {
    if (a.charStart !== b.charStart) return a.charStart - b.charStart;
    return b.charEnd - a.charEnd;
  });

  // Dedupe overlapping matches.
  const deduped: CharOffsetMatch[] = [];
  let prevEnd = -1;
  for (const m of raw) {
    if (m.charStart < prevEnd) continue;
    deduped.push(m);
    prevEnd = m.charEnd;
  }

  // Convert code-unit offsets to UTF-8 byte offsets.
  return deduped.map((m) => {
    const start = Buffer.byteLength(content.slice(0, m.charStart), 'utf8');
    const end = start + Buffer.byteLength(m.matched, 'utf8');
    return {
      start,
      end,
      pattern: m.pattern,
      matched: m.matched,
    };
  });
}
