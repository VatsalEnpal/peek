/**
 * Fatal error handlers — prevents the daemon-zombie failure mode.
 *
 * Symptom observed during v0.3 pre-launch testing: after running
 * `peek serve --watch` against a real `~/.claude/projects/` tree for some
 * time, the process stays alive (`ps` shows it) but the HTTP listener is
 * gone (`lsof -iTCP:<port>` shows nothing, `curl` gets ECONNREFUSED).
 * Slash commands print "daemon not running" — but the process never
 * exited, so the user's next `peek serve` can't tell whether the old
 * instance is still going, and on fresh kill the behaviour recurs.
 *
 * Root cause is an uncaught error somewhere in the watcher / import
 * chain. Locally the watcher wraps `importFile` in try/catch, but
 * chokidar error events are not subscribed; long-running I/O in the
 * pipeline could also throw after the initial await boundary.
 *
 * Installing explicit process-level handlers guarantees that ANY error
 * reaching the top of the event loop kills the process with exit code
 * 1. Fresh start-up with a new pid is an acceptable recovery; a zombie
 * with no listener is not.
 *
 * This is pure defense-in-depth. Local try/catch blocks in the watcher
 * and pipeline continue to do their job; these handlers only fire when
 * something slipped past them.
 */

/** Log sink for fatal handler messages. Tests inject a capturing array. */
export type FatalLogger = (message: string) => void;

function defaultLogger(msg: string): void {
  // eslint-disable-next-line no-console
  console.error(msg);
}

function formatUnknownError(e: unknown): string {
  if (e instanceof Error) return e.stack ?? `${e.name}: ${e.message}`;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * Register process-level fatal handlers. Idempotent-ish: each call adds
 * one listener to each event — the CLI only calls this once at startup.
 * Tests clean up with `process.removeAllListeners` in afterEach.
 */
export function installFatalHandlers(logger: FatalLogger = defaultLogger): void {
  process.on('uncaughtException', (err: Error) => {
    logger(`peek: fatal uncaughtException — ${formatUnknownError(err)}`);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logger(`peek: fatal unhandledRejection — ${formatUnknownError(reason)}`);
    process.exit(1);
  });
}
