/**
 * POST /api/open — open a source file in the user's default application.
 *
 * Body: { path: string }
 *
 * Security:
 *   - The path MUST resolve (after normalisation) to a location under the
 *     user's home directory. Anything else → 403. This prevents a compromised
 *     UI (or a misbehaving integration) from pointing the opener at `/etc/…`
 *     or a sibling user's home.
 *   - The resolved path is passed to `child_process.spawn` as an argv element,
 *     never interpolated into a shell. `spawn('open', [path])` cannot be
 *     tricked into running arbitrary commands even if `path` contains shell
 *     metacharacters.
 *
 * Platform:
 *   - darwin  → `open <file>`
 *   - linux   → `xdg-open <file>`
 *   - else    → 501 (unsupported)
 */

import { spawn } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { homedir, platform } from 'node:os';

import { Router, type Request, type Response } from 'express';

const router = Router();

router.post('/', (req: Request, res: Response) => {
  const { path } = (req.body ?? {}) as { path?: string };
  if (typeof path !== 'string' || path.length === 0) {
    res.status(400).json({ ok: false, error: "body must include string 'path'" });
    return;
  }

  // Normalise to an absolute, symlink-free-ish path. We don't call realpath
  // here — a symlink under $HOME pointing outside $HOME is still considered
  // user-owned intent; we only block explicit escapes via `..` or absolute
  // paths that resolve outside $HOME.
  const abs = resolvePath(path);
  const home = homedir();
  // Tolerate a trailing slash on either side.
  const homePrefix = home.endsWith('/') ? home : `${home}/`;
  if (abs !== home && !abs.startsWith(homePrefix)) {
    res.status(403).json({ ok: false, error: 'path is outside home directory' });
    return;
  }

  const plat = platform();
  let cmd: string;
  if (plat === 'darwin') cmd = 'open';
  else if (plat === 'linux') cmd = 'xdg-open';
  else {
    res.status(501).json({ ok: false, error: `unsupported platform: ${plat}` });
    return;
  }

  try {
    const child = spawn(cmd, [abs], {
      detached: true,
      stdio: 'ignore',
      // Never use a shell — argv stays an argv, not a command line.
      shell: false,
    });
    child.on('error', () => {
      // Error is async; we've already responded by then. The client's
      // toast-on-success is a best-effort signal: the OS opener may still
      // fail silently. Logging is enough here.
    });
    child.unref();
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

export default router;
