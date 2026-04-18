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
