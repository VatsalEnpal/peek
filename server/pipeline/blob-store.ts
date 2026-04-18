/**
 * Content-addressable blob store for peek-trace.
 *
 * Blobs are keyed by the SHA-256 of their raw (pre-gzip) content. Content
 * below `INLINE_THRESHOLD` bytes is considered small enough to embed verbatim
 * in the caller's SQLite row (`inline:true`, no file written). Larger content
 * is gzipped and atomically written to `<rootDir>/<sha>` via a tmp-file +
 * rename, so a crash mid-write never leaves a partial `<sha>` visible.
 *
 * Duplicate puts short-circuit: if `<rootDir>/<sha>` already exists, the
 * existing file is trusted and no rewrite happens.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

/** Threshold at which content is gzipped + written to disk rather than inlined. */
export const INLINE_THRESHOLD = 1024;

export type PutResult = { sha: string; inline: boolean };

export class BlobStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    mkdirSync(rootDir, { recursive: true });
  }

  /**
   * Store content addressed by SHA-256.
   *
   * - Content shorter than INLINE_THRESHOLD bytes returns `inline: true` and
   *   is NOT persisted; the caller is expected to embed it verbatim alongside
   *   the returned sha.
   * - Otherwise the content is gzipped and atomically written to
   *   `<rootDir>/<sha>`. If that file already exists the write is skipped
   *   (content-addressable dedup).
   */
  put(content: string | Buffer): PutResult {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const sha = createHash('sha256').update(buf).digest('hex');

    if (buf.byteLength < INLINE_THRESHOLD) {
      return { sha, inline: true };
    }

    const finalPath = join(this.rootDir, sha);
    if (existsSync(finalPath)) {
      return { sha, inline: false };
    }

    const gzipped = gzipSync(buf);
    const tmpName = `${sha}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
    const tmpPath = join(this.rootDir, tmpName);

    writeFileSync(tmpPath, gzipped);
    renameSync(tmpPath, finalPath);

    return { sha, inline: false };
  }

  /**
   * Retrieve content by sha. When `inlineContent` is supplied (for blobs the
   * caller stored inline), it is returned directly as a Buffer — no disk read.
   * Otherwise the gzipped file at `<rootDir>/<sha>` is read and gunzipped.
   */
  get(sha: string, inlineContent?: string | Buffer): Buffer {
    if (inlineContent !== undefined) {
      return typeof inlineContent === 'string' ? Buffer.from(inlineContent, 'utf8') : inlineContent;
    }
    const raw = readFileSync(join(this.rootDir, sha));
    return gunzipSync(raw);
  }

  /** True iff a blob file exists at `<rootDir>/<sha>`. Inline shas return false. */
  has(sha: string): boolean {
    return existsSync(join(this.rootDir, sha));
  }
}
