/**
 * POST /api/unmask — re-reveal the plaintext bytes behind a redacted ledger
 * entry. The client MUST send `X-Unmask-Confirm: 1` to acknowledge the
 * auditing implication. Reads raw bytes from the source JSONL file using the
 * ledger entry's stored `sourceOffset`, optionally validates the line hash,
 * and responds with `Cache-Control: no-store` so proxies never see it.
 *
 * Body: { ledgerEntryId: string }
 * Errors:
 *   400  — missing header or missing body field.
 *   404  — ledger entry unknown, or sourceOffset absent.
 *   409  — line hash mismatch (source file mutated since import).
 *   500  — filesystem read failed.
 */

import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import * as fs from 'node:fs';

import { Router, type Request, type Response } from 'express';

import type { Store } from '../pipeline/store';

const router = Router();

router.post('/', (req: Request, res: Response) => {
  if (req.header('x-unmask-confirm') !== '1') {
    res.status(400).json({
      error: "missing 'X-Unmask-Confirm: 1' header — unmask requires explicit confirmation",
    });
    return;
  }
  const { ledgerEntryId } = (req.body ?? {}) as { ledgerEntryId?: string };
  if (typeof ledgerEntryId !== 'string' || ledgerEntryId.length === 0) {
    res.status(400).json({ error: "body must include 'ledgerEntryId'" });
    return;
  }

  const store = req.app.locals.store as Store;
  // No direct get-by-id on Store; scan the session indices via listSessions
  // then listEvents. Acceptable because /unmask is a low-frequency action.
  let found: {
    sessionId: string;
    sourceOffset?: { file: string; byteStart: number; byteEnd: number; sourceLineHash: string };
  } | null = null;
  for (const s of store.listSessions()) {
    const events = store.listEvents(s.id);
    for (const e of events) {
      if (e.kind !== 'ledger') continue;
      if (e.id !== ledgerEntryId) continue;
      found = { sessionId: s.id };
      if (e.sourceOffset) found.sourceOffset = e.sourceOffset;
      break;
    }
    if (found) break;
  }

  if (!found) {
    res.status(404).json({ error: 'ledger entry not found', id: ledgerEntryId });
    return;
  }
  if (!found.sourceOffset) {
    res.status(404).json({ error: 'ledger entry has no sourceOffset', id: ledgerEntryId });
    return;
  }

  const { file, byteStart, byteEnd, sourceLineHash } = found.sourceOffset;
  let plaintext = '';
  try {
    const st = statSync(file);
    const clampedEnd = Math.min(byteEnd, st.size);
    const clampedStart = Math.max(0, Math.min(byteStart, clampedEnd));
    const length = Math.max(0, clampedEnd - clampedStart);
    if (length > 0) {
      const fd = openSync(file, 'r');
      try {
        const buf = Buffer.alloc(length);
        readSync(fd, buf, 0, length, clampedStart);
        plaintext = buf.toString('utf8');
      } finally {
        closeSync(fd);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: 'source file read failed', message });
    return;
  }

  // Integrity check (BUG-7 fix): re-hash the FULL JSONL line that contains
  // `byteStart` and compare against the stored `sourceLineHash`. Any byte
  // mutation (even length-preserving) between import and unmask MUST produce
  // a 409 so a TOCTOU attacker cannot coax plaintext out of a rewritten file.
  if (sourceLineHash && sourceLineHash.length > 0) {
    try {
      const stat = fs.statSync(file);
      const size = stat.size;
      const MAX_LINE = 16 * 1024 * 1024;

      // Scan backward for the start of the line that owns byteStart.
      let lineStart = Math.max(0, byteStart);
      {
        const CHUNK = 65536;
        const fd = fs.openSync(file, 'r');
        try {
          while (lineStart > 0) {
            const readLen = Math.min(CHUNK, lineStart);
            const buf = Buffer.alloc(readLen);
            fs.readSync(fd, buf, 0, readLen, lineStart - readLen);
            const nl = buf.lastIndexOf(0x0a);
            if (nl >= 0) {
              lineStart = lineStart - readLen + nl + 1;
              break;
            }
            lineStart -= readLen;
            if (byteStart - lineStart > MAX_LINE) {
              fs.closeSync(fd);
              res.status(409).json({ error: 'source changed' });
              return;
            }
          }
        } finally {
          try {
            fs.closeSync(fd);
          } catch {
            /* already closed */
          }
        }
      }

      // Scan forward for the end of the line (exclusive of the trailing \n).
      let lineEnd = Math.max(byteStart, lineStart);
      {
        const CHUNK = 65536;
        const fd = fs.openSync(file, 'r');
        try {
          while (lineEnd < size) {
            const readLen = Math.min(CHUNK, size - lineEnd);
            const buf = Buffer.alloc(readLen);
            fs.readSync(fd, buf, 0, readLen, lineEnd);
            const nl = buf.indexOf(0x0a);
            if (nl >= 0) {
              lineEnd += nl;
              break;
            }
            lineEnd += readLen;
            if (lineEnd - lineStart > MAX_LINE) {
              fs.closeSync(fd);
              res.status(409).json({ error: 'source changed' });
              return;
            }
          }
        } finally {
          try {
            fs.closeSync(fd);
          } catch {
            /* already closed */
          }
        }
      }

      const lineBuf = Buffer.alloc(lineEnd - lineStart);
      const fd2 = fs.openSync(file, 'r');
      try {
        fs.readSync(fd2, lineBuf, 0, lineBuf.length, lineStart);
      } finally {
        fs.closeSync(fd2);
      }
      const actualLineHash = createHash('sha256').update(lineBuf).digest('hex');
      if (actualLineHash !== sourceLineHash) {
        res.status(409).json({ error: 'source changed' });
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'source file read failed', message });
      return;
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ledgerEntryId,
    sessionId: found.sessionId,
    plaintext,
    sourceFile: file,
    byteStart,
    byteEnd,
  });
});

export default router;
