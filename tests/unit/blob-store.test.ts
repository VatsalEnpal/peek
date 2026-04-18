/**
 * Unit tests for the content-addressable BlobStore.
 *
 * Blobs are keyed by SHA-256 of their (raw) content. Content under 1024 bytes
 * is kept inline (no file written); content at/above the threshold is gzipped
 * and atomically written to `<rootDir>/<sha>`. Duplicate puts short-circuit,
 * and tmp files are renamed into place (never left behind on success).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import { BlobStore } from '../../server/pipeline/blob-store';

describe('BlobStore', () => {
  let root: string;
  let store: BlobStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'peek-blob-store-'));
    store = new BlobStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

  it('round-trips small (<1KB) content inline without writing a file', () => {
    const content = 'hello world';
    const result = store.put(content);

    expect(result.inline).toBe(true);
    expect(result.sha).toBe(sha256(Buffer.from(content, 'utf8')));

    // No file should exist on disk for inline content.
    expect(existsSync(join(root, result.sha))).toBe(false);

    // get() with inlineContent hint round-trips.
    const got = store.get(result.sha, content);
    expect(got).toBeInstanceOf(Buffer);
    expect(got.toString('utf8')).toBe(content);
  });

  it('round-trips large (>=1KB) content gzipped to disk', () => {
    const content = 'A'.repeat(4096);
    const result = store.put(content);

    expect(result.inline).toBe(false);
    expect(result.sha).toBe(sha256(Buffer.from(content, 'utf8')));

    const filePath = join(root, result.sha);
    expect(existsSync(filePath)).toBe(true);

    // get() should read + gunzip the file, returning raw content.
    const got = store.get(result.sha);
    expect(got.toString('utf8')).toBe(content);
  });

  it('dedups identical content — second put is a no-op, one file on disk', () => {
    const content = Buffer.alloc(2048, 0x42);

    const first = store.put(content);
    const second = store.put(content);

    expect(second.sha).toBe(first.sha);
    expect(second.inline).toBe(false);

    const files = readdirSync(root).filter((f) => !f.includes('.tmp.'));
    expect(files).toEqual([first.sha]);
  });

  it('produces different shas for different content', () => {
    const a = store.put('A'.repeat(2000));
    const b = store.put('B'.repeat(2000));

    expect(a.sha).not.toBe(b.sha);
    expect(existsSync(join(root, a.sha))).toBe(true);
    expect(existsSync(join(root, b.sha))).toBe(true);
  });

  it('writes gzip-framed files (magic bytes 1f 8b) to disk', () => {
    const content = 'Z'.repeat(2048);
    const result = store.put(content);

    const raw = readFileSync(join(root, result.sha));
    expect(raw[0]).toBe(0x1f);
    expect(raw[1]).toBe(0x8b);

    // And it actually decompresses back to the original bytes.
    expect(gunzipSync(raw).toString('utf8')).toBe(content);
  });

  it('has() reflects existence correctly for inline vs on-disk content', () => {
    const small = store.put('tiny');
    const large = store.put('X'.repeat(2048));

    // Inline content is not on disk, so has() is false for the inline sha.
    expect(store.has(small.sha)).toBe(false);
    expect(store.has(large.sha)).toBe(true);
    expect(store.has('0'.repeat(64))).toBe(false);
  });

  it('leaves no .tmp files in rootDir after a successful put', () => {
    store.put('Y'.repeat(2048));

    const leftovers = readdirSync(root).filter((f) => f.includes('.tmp.'));
    expect(leftovers).toEqual([]);
  });

  it('creates the root directory if it does not already exist', () => {
    const nested = join(root, 'does', 'not', 'exist', 'yet');
    const s = new BlobStore(nested);
    const result = s.put('W'.repeat(2048));

    expect(existsSync(nested)).toBe(true);
    expect(existsSync(join(nested, result.sha))).toBe(true);
  });
});
