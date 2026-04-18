import { createHash, createHmac, randomBytes } from 'node:crypto';

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
