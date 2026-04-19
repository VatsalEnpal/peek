/**
 * `peek install` — L3.3.
 *
 * Copies the `/peek_start` and `/peek_end` slash-command bodies into the
 * user's Claude Code config. Two layouts are supported:
 *
 *   1. `~/.claude/commands/peek_start.md` + `peek_end.md`   (preferred;
 *      matches Claude Code's project-level slash command convention where
 *      every `.md` in `commands/` is a `/<name>` command).
 *   2. `~/.claude/skills/peek_start/SKILL.md` + `peek_end/SKILL.md`
 *      (fallback for hosts that only support skill-style plugins).
 *
 * Selection rule: if `commands/` exists → commands layout. Else if `skills/`
 * exists → skills layout. Else if `~/.claude/` itself exists → create
 * `commands/` and install there. If `~/.claude/` does not exist at all,
 * surface a `no-claude-dir` error so the CLI can print manual instructions.
 *
 * Existing files are preserved unless `--force` is passed. The source of
 * truth is the repo's own `skills/peek_start/SKILL.md` and
 * `skills/peek_end/SKILL.md` — we read those and write them as-is into the
 * target (the frontmatter + body is valid for both the commands/ and
 * skills/ layouts).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type InstallTarget = 'commands' | 'skills';

export type InstallResult = {
  ok: boolean;
  /** Which layout was used, when `ok` is true. */
  target?: InstallTarget;
  /** Failure reason, when `ok` is false. */
  reason?: 'no-claude-dir' | 'exists' | 'permission' | 'missing-source';
  /** Absolute paths of files written, in the order they were written. */
  written?: string[];
  /** Absolute path of the first conflicting file, when reason === 'exists'. */
  conflict?: string;
  /** Human-readable message for CLI output. */
  message?: string;
};

export type RunInstallOpts = {
  /** Root of the Claude Code config, e.g. `/Users/foo/.claude`. */
  claudeDir: string;
  /** Directory containing `peek_start/SKILL.md` and `peek_end/SKILL.md`. */
  skillsSourceDir: string;
  /** Overwrite existing files when true. */
  force?: boolean;
};

/**
 * Default resolver for the repo-local `skills/` dir when the CLI is running
 * from source (tsx) or from the compiled dist layout.
 */
export function defaultSkillsSourceDir(): string {
  // From `dist/server/cli/install.js` → repo root is four levels up.
  // From `server/cli/install.ts` (tsx)  → repo root is three levels up.
  const fromDist = path.resolve(__dirname, '..', '..', '..', 'skills');
  if (existsSync(path.join(fromDist, 'peek_start', 'SKILL.md'))) return fromDist;
  const fromSrc = path.resolve(__dirname, '..', '..', 'skills');
  return fromSrc;
}

export function defaultClaudeConfigDir(): string {
  return path.join(os.homedir(), '.claude');
}

export function runInstall(opts: RunInstallOpts): InstallResult {
  const { claudeDir, skillsSourceDir, force = false } = opts;

  if (!existsSync(claudeDir)) {
    return {
      ok: false,
      reason: 'no-claude-dir',
      message: `~/.claude/ not found at ${claudeDir}. Is Claude Code installed?`,
    };
  }

  const startSource = path.join(skillsSourceDir, 'peek_start', 'SKILL.md');
  const endSource = path.join(skillsSourceDir, 'peek_end', 'SKILL.md');
  if (!existsSync(startSource) || !existsSync(endSource)) {
    return {
      ok: false,
      reason: 'missing-source',
      message: `Source SKILL.md files not found under ${skillsSourceDir}.`,
    };
  }

  const commandsDir = path.join(claudeDir, 'commands');
  const skillsDir = path.join(claudeDir, 'skills');

  // Layout selection.
  let target: InstallTarget;
  let plan: { src: string; dest: string }[];

  if (existsSync(commandsDir)) {
    target = 'commands';
    plan = [
      { src: startSource, dest: path.join(commandsDir, 'peek_start.md') },
      { src: endSource, dest: path.join(commandsDir, 'peek_end.md') },
    ];
  } else if (existsSync(skillsDir)) {
    target = 'skills';
    plan = [
      { src: startSource, dest: path.join(skillsDir, 'peek_start', 'SKILL.md') },
      { src: endSource, dest: path.join(skillsDir, 'peek_end', 'SKILL.md') },
    ];
  } else {
    // Neither subdir exists. Create commands/ and use that.
    target = 'commands';
    plan = [
      { src: startSource, dest: path.join(commandsDir, 'peek_start.md') },
      { src: endSource, dest: path.join(commandsDir, 'peek_end.md') },
    ];
  }

  // Conflict check BEFORE any writes, so we leave disk untouched if we abort.
  if (!force) {
    for (const step of plan) {
      if (existsSync(step.dest)) {
        return {
          ok: false,
          reason: 'exists',
          conflict: step.dest,
          message: `File already exists: ${step.dest}. Pass --force to overwrite.`,
        };
      }
    }
  }

  // Copy (mkdir -p as needed).
  const written: string[] = [];
  try {
    for (const step of plan) {
      mkdirSync(path.dirname(step.dest), { recursive: true });
      const body = readFileSync(step.src, 'utf8');
      writeFileSync(step.dest, body, { encoding: 'utf8' });
      written.push(step.dest);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // EACCES / EPERM bubble up through fs errors.
    return {
      ok: false,
      reason: 'permission',
      written,
      message: `Failed to write install files: ${msg}`,
    };
  }

  return {
    ok: true,
    target,
    written,
    message: `Installed ${written.length} file(s) into ${target === 'commands' ? commandsDir : skillsDir}.`,
  };
}

/**
 * Best-effort reachability probe against a running Peek daemon. Returns
 * true if `GET ${baseUrl}/api/healthz` responds 2xx within the timeout.
 * Never throws.
 */
export async function probeDaemon(baseUrl: string, timeoutMs = 500): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/healthz`, {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}
