import { createHash, createHmac, randomBytes } from 'node:crypto';
import { detectSecrets } from './secretlint-adapter';

/** 64-char hex random salt per session. */
export function createSessionSalt(): string {
  return randomBytes(32).toString('hex');
}

/** 8-char hex prefix of HMAC-SHA256(salt, value). Deterministic within a session. */
export function hashSecret(value: string, salt: string): string {
  return createHmac('sha256', salt).update(value).digest('hex').slice(0, 8);
}

/** SHA-256 of a full JSONL source line (used for sourceLineHash integrity). */
export function sourceLineHash(line: string): string {
  return createHash('sha256').update(line, 'utf8').digest('hex');
}

/**
 * Env-var-name heuristic: redacts values after `NAME_KEY=`, `NAME_TOKEN=`,
 * `NAME_SECRET=`, `NAME_PASSWORD=`, `NAME_PWD=` where NAME is SCREAMING_SNAKE_CASE.
 * Example: `ANTHROPIC_API_KEY=sk-foo` → `ANTHROPIC_API_KEY=<env-redacted>`.
 * Unquoted values end at whitespace or ", ', ` . Quoted values span to the matching quote.
 */
export type EnvVarMatch = { start: number; end: number; varName: string; value: string };

const ENV_VAR_REGEX =
  /([A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD|PWD))=(?:"([^"]*)"|'([^']*)'|`([^`]*)`|([^\s"'`]+))/g;

export function detectEnvVars(content: string): EnvVarMatch[] {
  const out: EnvVarMatch[] = [];
  for (const m of content.matchAll(ENV_VAR_REGEX)) {
    const varName = m[1];
    const quoted = m[2] ?? m[3] ?? m[4];
    const unquoted = m[5];
    const value = (quoted ?? unquoted) as string;
    if (!value) continue;
    const valueStart = (m.index as number) + m[0].indexOf('=') + 1;
    const valueOffset = quoted !== undefined ? 1 : 0;
    const byteStart = Buffer.byteLength(content.slice(0, valueStart + valueOffset), 'utf8');
    const byteEnd = byteStart + Buffer.byteLength(value, 'utf8');
    out.push({ start: byteStart, end: byteEnd, varName, value });
  }
  return out;
}

/**
 * Unified detection emitted by {@link redactBlock}. `start`/`end` are UTF-8
 * byte offsets within the *content* string that was passed in. `hash` is the
 * 8-char HMAC prefix of the matched value (see {@link hashSecret}).
 */
export type Detection = {
  start: number;
  end: number;
  hash: string;
  pattern: string;
};

/**
 * Location of a redacted block within its source JSONL line.
 * `byteStart`/`byteEnd` describe where the raw (pre-redaction) content lived
 * inside `lineBytes`; `sourceLineHash` is SHA-256 of the whole line and lets
 * downstream consumers verify the block came from an unchanged source.
 */
export type SourceOffset = {
  file: string;
  byteStart: number;
  byteEnd: number;
  sourceLineHash: string;
};

export type RedactResult = {
  redacted: string;
  detections: Detection[];
  sourceOffset: SourceOffset;
};

type RawDetection = {
  start: number;
  end: number;
  matched: string;
  pattern: string;
};

/**
 * Orchestrate all detectors over `content`, emitting a redacted copy where
 * every secret byte range has been replaced with `<secret:<8hex>>`.
 *
 * - Runs {@link detectSecrets} (Anthropic + AWS) and {@link detectEnvVars}.
 * - Overlapping hits are deduped (earliest start wins; ties break by longest).
 * - Byte-accurate replacement via Buffer slicing so multi-byte (emoji) input
 *   is preserved exactly.
 * - `sourceOffset.sourceLineHash` = SHA-256 of the full source JSONL line.
 */
export function redactBlock(
  content: string,
  salt: string,
  sourceFile: string,
  lineBytes: Buffer,
  contentByteRangeInLine: { start: number; end: number }
): RedactResult {
  const secrets = detectSecrets(content).map<RawDetection>((s) => ({
    start: s.start,
    end: s.end,
    matched: s.matched,
    pattern: s.pattern,
  }));
  const envVars = detectEnvVars(content).map<RawDetection>((e) => ({
    start: e.start,
    end: e.end,
    matched: e.value,
    pattern: `env:${e.varName}`,
  }));

  // Sort by start asc, length desc; drop any whose start falls inside the
  // previous kept range so overlapping hits don't get redacted twice.
  const merged = [...secrets, ...envVars].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - a.end;
  });
  const deduped: RawDetection[] = [];
  let prevEnd = -1;
  for (const d of merged) {
    if (d.start < prevEnd) continue;
    deduped.push(d);
    prevEnd = d.end;
  }

  // Walk byte-by-byte, splicing `<secret:<hash>>` in place of each matched range.
  const contentBuf = Buffer.from(content, 'utf8');
  const parts: Buffer[] = [];
  const detections: Detection[] = [];
  let cursor = 0;
  for (const d of deduped) {
    const hash = hashSecret(d.matched, salt);
    parts.push(contentBuf.subarray(cursor, d.start));
    parts.push(Buffer.from(`<secret:${hash}>`, 'utf8'));
    cursor = d.end;
    detections.push({ start: d.start, end: d.end, hash, pattern: d.pattern });
  }
  parts.push(contentBuf.subarray(cursor));
  const redacted = Buffer.concat(parts).toString('utf8');

  return {
    redacted,
    detections,
    sourceOffset: {
      file: sourceFile,
      byteStart: contentByteRangeInLine.start,
      byteEnd: contentByteRangeInLine.end,
      sourceLineHash: sourceLineHash(lineBytes.toString('utf8')),
    },
  };
}
