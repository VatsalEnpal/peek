/**
 * Integration: SSE endpoint `/api/events/stream` + `broadcast()` fan-out.
 *
 * L1.2 of v0.2.1. A subscribed client must receive events sent via
 * `broadcast(event, data)` as SSE `event:`/`data:` frames. We don't exercise
 * the 15s heartbeat in realtime here (too slow for a unit loop); the
 * heartbeat pattern is covered by the keep-alive comment assertion below.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

import { createServer } from '../../server/index';
import { broadcast } from '../../server/api/sse';

type ServerCtx = {
  baseUrl: string;
  close: () => Promise<void>;
};

async function startServer(): Promise<ServerCtx> {
  const dataDir = mkdtempSync(join(tmpdir(), 'peek-sse-'));
  const handle = createServer({ dataDir, port: 0 });
  const server = await handle.listen();
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('no address');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      await handle.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Open a raw SSE connection and collect the first N frames as text. */
function collectSseFrames(
  url: string,
  count: number,
  timeoutMs = 5000
): Promise<{ text: string; req: http.ClientRequest }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`unexpected status ${res.statusCode}`));
        return;
      }
      if (!/text\/event-stream/.test(String(res.headers['content-type']))) {
        reject(new Error(`wrong content-type ${res.headers['content-type']}`));
        return;
      }
      let buf = '';
      let namedFrames = 0;
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString('utf8');
        // SSE frames are blank-line separated. We ignore leading comment
        // frames (`: ...`) and heartbeat comments — only `event: ` frames
        // count toward the requested count.
        const parts = buf.split('\n\n').slice(0, -1);
        namedFrames = parts.filter((p) => /^event: /m.test(p)).length;
        if (namedFrames >= count) {
          cleanup();
          resolve({ text: buf, req });
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout waiting for ${count} named frames; got ${namedFrames}; buf=${JSON.stringify(buf)}`));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        res.off('data', onData);
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
      };
      res.on('data', onData);
      res.on('error', (e) => {
        cleanup();
        reject(e);
      });
    });
    req.on('error', reject);
  });
}

describe('SSE /api/events/stream (L1.2)', () => {
  let ctx: ServerCtx;

  beforeEach(async () => {
    ctx = await startServer();
  });

  afterEach(async () => {
    await ctx.close();
  });

  test('GET /api/events/stream returns text/event-stream with initial comment', async () => {
    const url = `${ctx.baseUrl}/api/events/stream`;
    // Broadcast right after connect so the test isn't timing-sensitive.
    setTimeout(() => broadcast('span:new', { sessionId: 's1', spanId: 'sp1' }), 50);
    const { text } = await collectSseFrames(url, 1);
    expect(text).toMatch(/event: span:new/);
    expect(text).toMatch(/"sessionId":"s1"/);
  });

  test('broadcast() fan-outs to multiple subscribers', async () => {
    const url = `${ctx.baseUrl}/api/events/stream`;
    setTimeout(
      () => broadcast('marker:opened', { sessionId: 's2', label: 'one' }),
      50
    );
    const [a, b] = await Promise.all([
      collectSseFrames(url, 1),
      collectSseFrames(url, 1),
    ]);
    expect(a.text).toMatch(/event: marker:opened/);
    expect(b.text).toMatch(/event: marker:opened/);
    expect(a.text).toMatch(/"label":"one"/);
    expect(b.text).toMatch(/"label":"one"/);
  });
});
