/**
 * Unit tests for `installFatalHandlers` — defense against the
 * daemon-zombie failure mode observed in v0.3 pre-launch testing.
 *
 * Zombie symptom: `node dist/bin/peek.js serve --watch` runs long enough
 * that `ps` shows the process alive, but `lsof -iTCP:<port> -sTCP:LISTEN`
 * shows no bound listener and `curl` gets ECONNREFUSED. Slash commands
 * print "daemon not running" — but the process never exited, so the
 * user's next `peek serve` attempt collides with a half-dead pid.
 *
 * Root cause is either chokidar or some async chain throwing an error
 * that isn't caught. Node 22's default `uncaughtException` behavior IS
 * to kill the process — but if the exception is SWALLOWED by an
 * intervening handler (or is an `unhandledRejection` on older configs)
 * the process can keep running with its listener socket closed.
 *
 * `installFatalHandlers` is defense-in-depth: explicitly register
 * handlers for both events that log the error and call `process.exit(1)`.
 * If anything slips past the local try/catch blocks in the watcher /
 * import pipeline, the process dies cleanly instead of becoming a zombie.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';

// Must import via the alias used elsewhere in the repo (see vitest.config).
import { installFatalHandlers } from '@server/cli/fatal-handlers';

describe('installFatalHandlers', () => {
  afterEach(() => {
    // Clean up any listeners the test registered; other suites assume a
    // clean slate on these process events.
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
  });

  test('registers a listener on uncaughtException', () => {
    const before = process.listenerCount('uncaughtException');
    installFatalHandlers(() => {});
    const after = process.listenerCount('uncaughtException');
    expect(after).toBe(before + 1);
  });

  test('registers a listener on unhandledRejection', () => {
    const before = process.listenerCount('unhandledRejection');
    installFatalHandlers(() => {});
    const after = process.listenerCount('unhandledRejection');
    expect(after).toBe(before + 1);
  });

  test('forwards uncaughtException message + stack to the supplied logger', () => {
    const messages: string[] = [];
    const originalExit = process.exit;
    let exitCode: number | null = null;
    // Intercept process.exit so the test itself doesn't terminate when the
    // handler fires. We assert the exit code was 1.
    (process as unknown as { exit: (code?: number) => void }).exit = (code?: number) => {
      exitCode = code ?? 0;
    };
    try {
      installFatalHandlers((m) => messages.push(m));
      const err = new Error('boom');
      process.emit('uncaughtException', err);
      expect(messages.length).toBe(1);
      expect(messages[0]).toContain('fatal');
      expect(messages[0]).toContain('boom');
      expect(exitCode).toBe(1);
    } finally {
      (process as unknown as { exit: typeof originalExit }).exit = originalExit;
    }
  });

  test('forwards unhandledRejection reason to the supplied logger and exits non-zero', () => {
    const messages: string[] = [];
    const originalExit = process.exit;
    let exitCode: number | null = null;
    (process as unknown as { exit: (code?: number) => void }).exit = (code?: number) => {
      exitCode = code ?? 0;
    };
    try {
      installFatalHandlers((m) => messages.push(m));
      // Emit a synthetic unhandledRejection — same shape Node sends when a
      // promise rejects without a .catch().
      const reason = new Error('rejected');
      const p = Promise.reject(reason);
      // Suppress the actual unhandled rejection warning during the test.
      p.catch(() => {});
      process.emit('unhandledRejection', reason, p);
      expect(messages.length).toBe(1);
      expect(messages[0]).toContain('rejected');
      expect(exitCode).toBe(1);
    } finally {
      (process as unknown as { exit: typeof originalExit }).exit = originalExit;
    }
  });

  test('uses console.error as the default logger when none is supplied', () => {
    const originalExit = process.exit;
    (process as unknown as { exit: (code?: number) => void }).exit = () => {};
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      installFatalHandlers();
      process.emit('uncaughtException', new Error('default-logger-check'));
      expect(spy).toHaveBeenCalled();
      const joined = spy.mock.calls.map((c) => String(c[0])).join(' | ');
      expect(joined).toContain('default-logger-check');
    } finally {
      spy.mockRestore();
      (process as unknown as { exit: typeof originalExit }).exit = originalExit;
    }
  });
});
