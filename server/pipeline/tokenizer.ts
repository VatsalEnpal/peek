/**
 * Anthropic `/v1/messages/count_tokens` client with LRU cache, rolling-window
 * rate limiter, and exponential-backoff retries.
 *
 * This module never makes a network call unless invoked; in tests, pass a
 * `fetchImpl` (or stub `globalThis.fetch`) to mock the HTTP layer.
 *
 * Contract (see .peek-build/task-2.1-context.md):
 *   - Cache: Map-based LRU keyed by sha256(model + '\0' + content). Max 10k.
 *   - Rate limit: ≤10 requests per rolling 1000ms window.
 *   - Retries: 429 or 5xx → `250 * 2^attempt` ms backoff, capped at 5 attempts.
 *   - Non-429 4xx → throw with status + body.
 */

import { createHash } from 'node:crypto';

export type CountTokensOpts = {
  /** Model name. Defaults to 'claude-opus-4-5'. Used in cache key. */
  model?: string;
  /** Overrides process.env.ANTHROPIC_API_KEY when provided. */
  apiKey?: string;
  /** Fetch override — used in tests to mock HTTP. */
  fetchImpl?: typeof fetch;
};

const DEFAULT_MODEL = 'claude-opus-4-5';
const API_URL = 'https://api.anthropic.com/v1/messages/count_tokens';
const API_VERSION = '2023-06-01';
const CACHE_MAX = 10_000;
const RATE_LIMIT = 10; // requests per window
const RATE_WINDOW_MS = 1000;
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 250;

// ---------------------------------------------------------------------------
// LRU cache (Map preserves insertion order; re-insert on hit to bump recency).
// ---------------------------------------------------------------------------

const cache = new Map<string, number>();

function cacheKey(model: string, content: string): string {
  return createHash('sha256')
    .update(model + '\0' + content)
    .digest('hex');
}

function cacheGet(key: string): number | undefined {
  const v = cache.get(key);
  if (v === undefined) return undefined;
  // Bump recency: delete + re-insert moves it to the end.
  cache.delete(key);
  cache.set(key, v);
  return v;
}

function cacheSet(key: string, value: number): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function _clearTokenCache(): void {
  cache.clear();
}

export function _cacheSize(): number {
  return cache.size;
}

/** Test helper: reset rate-limiter state so tests don't leak timestamps. */
export function _resetRateLimiter(): void {
  sendTimestamps.length = 0;
  gateChain = Promise.resolve();
}

// ---------------------------------------------------------------------------
// Rate limiter: rolling 1-second window. Serialized through a single queue so
// concurrent callers don't all race past the limit check.
// ---------------------------------------------------------------------------

const sendTimestamps: number[] = [];
let gateChain: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Await until it is safe to dispatch another request under the rate limit. */
async function acquireRateLimitSlot(): Promise<void> {
  // Chain through a shared promise so callers resolve in FIFO order and the
  // timestamp-window check is serialized.
  const prev = gateChain;
  let release!: () => void;
  gateChain = new Promise<void>((r) => (release = r));

  try {
    await prev;

    // Drop timestamps outside the rolling window.
    const now = Date.now();
    while (sendTimestamps.length > 0 && now - sendTimestamps[0] >= RATE_WINDOW_MS) {
      sendTimestamps.shift();
    }

    if (sendTimestamps.length >= RATE_LIMIT) {
      const waitMs = RATE_WINDOW_MS - (now - sendTimestamps[0]);
      if (waitMs > 0) await sleep(waitMs);
      // Drop anything that aged out while we slept.
      const now2 = Date.now();
      while (sendTimestamps.length > 0 && now2 - sendTimestamps[0] >= RATE_WINDOW_MS) {
        sendTimestamps.shift();
      }
    }

    sendTimestamps.push(Date.now());
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Call Anthropic's `/v1/messages/count_tokens` endpoint for a single text
 * block, returning `input_tokens`. Caches results in-memory, throttles to
 * 10 rps, and retries on 429/5xx with exponential backoff (max 5 attempts).
 */
export async function countTokensViaAPI(
  content: string,
  opts: CountTokensOpts = {}
): Promise<number> {
  const model = opts.model ?? DEFAULT_MODEL;
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY missing');
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('No fetch implementation available');
  }

  const key = cacheKey(model, content);
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: content }] }],
  });

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await acquireRateLimitSlot();

    let res: Response;
    try {
      res = await fetchImpl(API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
          'content-type': 'application/json',
        },
        body,
      } as any);
    } catch (err) {
      // Network error → treat like a retryable failure.
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(BASE_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      throw lastErr;
    }

    if (res.ok) {
      const json: any = await res.json();
      const n = json?.input_tokens;
      if (typeof n !== 'number') {
        throw new Error(
          `Anthropic count_tokens: malformed response (missing input_tokens): ${JSON.stringify(json)}`
        );
      }
      cacheSet(key, n);
      return n;
    }

    const status = res.status;
    const retryable = status === 429 || (status >= 500 && status < 600);
    const bodyText = await safeReadText(res);
    lastErr = new Error(`Anthropic count_tokens HTTP ${status}: ${bodyText}`);

    if (!retryable) throw lastErr;
    if (attempt >= MAX_ATTEMPTS - 1) break;

    await sleep(BASE_BACKOFF_MS * 2 ** attempt);
  }

  throw lastErr ?? new Error('Anthropic count_tokens: exhausted retries');
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<no body>';
  }
}

// ---------------------------------------------------------------------------
// Offline tokenizer fallback
//
// Uses `@anthropic-ai/tokenizer` (tiktoken-backed Claude BPE) when available.
// On any init/runtime failure (e.g. WASM load error), falls through to a
// coarse char-estimate `Math.ceil(content.length / 3.5)` — good enough to
// keep the pipeline moving when A2's 2% drift gate is known to fail anyway.
// ---------------------------------------------------------------------------

type OfflineCounter = (text: string) => number;

let _offlineCounterCache: OfflineCounter | null = null;
let _offlineCounterLoaded = false;

function getOfflineCounter(): OfflineCounter {
  if (_offlineCounterLoaded) {
    return _offlineCounterCache ?? charEstimate;
  }
  _offlineCounterLoaded = true;
  try {
    // Use a dynamic require to avoid ESM/CJS headaches and so a module-load
    // failure (missing WASM, etc.) degrades gracefully instead of crashing.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@anthropic-ai/tokenizer') as { countTokens?: (t: string) => number };
    if (typeof mod.countTokens === 'function') {
      // Smoke-test once so a runtime WASM issue surfaces here and we fall back.
      const probe = mod.countTokens('hi');
      if (typeof probe === 'number' && probe >= 0) {
        _offlineCounterCache = (text: string) => (text.length === 0 ? 0 : mod.countTokens!(text));
        return _offlineCounterCache;
      }
    }
  } catch {
    // fall through to char-estimate
  }
  _offlineCounterCache = charEstimate;
  return _offlineCounterCache;
}

function charEstimate(text: string): number {
  if (text.length === 0) return 0;
  // Claude rough char-per-token ratio ~3.5 (see task-2.2 context pack).
  return Math.ceil(text.length / 3.5);
}

/** Test helper: reset the offline tokenizer cache (re-probes on next call). */
export function _resetOfflineCounter(): void {
  _offlineCounterCache = null;
  _offlineCounterLoaded = false;
}

/**
 * Count tokens offline. Never throws on tokenizer init — falls through to a
 * character-based approximation if the real tokenizer is unavailable.
 */
export async function countTokensOffline(content: string): Promise<number> {
  if (content.length === 0) return 0;
  const counter = getOfflineCounter();
  try {
    const n = counter(content);
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) {
      return Math.ceil(n);
    }
  } catch {
    // tokenizer blew up at runtime — fall back.
  }
  return charEstimate(content);
}

// ---------------------------------------------------------------------------
// Top-level dispatcher
// ---------------------------------------------------------------------------

export type TokenResult = {
  tokens: number;
  method: 'api' | 'offline';
  /** True when method === 'offline' — UI surfaces a drift warning. */
  driftDisclaimer: boolean;
};

export type DispatcherOpts = CountTokensOpts & {
  /** Skip the API path entirely and use the offline tokenizer. */
  forceOffline?: boolean;
};

/**
 * Top-level token count dispatcher.
 *
 * - If `forceOffline` is true → offline.
 * - Else if an API key is available (via `opts.apiKey` or `ANTHROPIC_API_KEY`)
 *   AND a fetch implementation is reachable → try the API. On any failure,
 *   gracefully degrade to offline.
 * - Else → offline.
 *
 * Always resolves; never throws on network errors.
 */
export async function countTokens(
  content: string,
  opts: DispatcherOpts = {}
): Promise<TokenResult> {
  const offlineResult = async (): Promise<TokenResult> => ({
    tokens: await countTokensOffline(content),
    method: 'offline',
    driftDisclaimer: true,
  });

  if (opts.forceOffline) return offlineResult();

  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!apiKey || !fetchImpl) return offlineResult();

  try {
    const n = await countTokensViaAPI(content, {
      ...opts,
      apiKey,
      fetchImpl,
    });
    return { tokens: n, method: 'api', driftDisclaimer: false };
  } catch {
    // Any API failure (network, 4xx, retries exhausted) → offline fallback.
    return offlineResult();
  }
}
