/**
 * Unit tests for the `peek install` logic (L3.3).
 *
 * The CLI surface is a thin wrapper that calls `runInstall({ claudeDir,
 * skillsSourceDir, force })`. These tests exercise the pure function against
 * temporary directories so no real `~/.claude/` is ever touched.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runInstall } from '../../server/cli/install';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SKILLS_SOURCE = join(REPO_ROOT, 'skills');

describe('runInstall', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'peek-install-test-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('installs into a fresh ~/.claude/commands/ directory when it exists', () => {
    const claudeDir = join(tmpRoot, '.claude');
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });

    const result = runInstall({ claudeDir, skillsSourceDir: SKILLS_SOURCE });

    expect(result.ok).toBe(true);
    expect(result.target).toBe('commands');
    expect(existsSync(join(claudeDir, 'commands', 'peek_start.md'))).toBe(true);
    expect(existsSync(join(claudeDir, 'commands', 'peek_end.md'))).toBe(true);
    // Files should be non-empty and contain the curl call.
    const startBody = readFileSync(join(claudeDir, 'commands', 'peek_start.md'), 'utf8');
    expect(startBody).toContain('/api/markers');
    expect(startBody.length).toBeGreaterThan(50);
  });

  test('falls back to ~/.claude/skills/ when commands/ does not exist', () => {
    const claudeDir = join(tmpRoot, '.claude');
    mkdirSync(join(claudeDir, 'skills'), { recursive: true });

    const result = runInstall({ claudeDir, skillsSourceDir: SKILLS_SOURCE });

    expect(result.ok).toBe(true);
    expect(result.target).toBe('skills');
    expect(existsSync(join(claudeDir, 'skills', 'peek_start', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(claudeDir, 'skills', 'peek_end', 'SKILL.md'))).toBe(true);
  });

  test('prefers commands/ when both commands/ and skills/ exist', () => {
    const claudeDir = join(tmpRoot, '.claude');
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    mkdirSync(join(claudeDir, 'skills'), { recursive: true });

    const result = runInstall({ claudeDir, skillsSourceDir: SKILLS_SOURCE });

    expect(result.ok).toBe(true);
    expect(result.target).toBe('commands');
    expect(existsSync(join(claudeDir, 'commands', 'peek_start.md'))).toBe(true);
    // skills/ untouched
    expect(existsSync(join(claudeDir, 'skills', 'peek_start'))).toBe(false);
  });

  test('errors when the same file already exists and --force is not set', () => {
    const claudeDir = join(tmpRoot, '.claude');
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    writeFileSync(join(claudeDir, 'commands', 'peek_start.md'), 'existing content');

    const result = runInstall({ claudeDir, skillsSourceDir: SKILLS_SOURCE });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('exists');
    // Existing file must be untouched.
    expect(readFileSync(join(claudeDir, 'commands', 'peek_start.md'), 'utf8')).toBe(
      'existing content'
    );
  });

  test('overwrites existing files when --force is set', () => {
    const claudeDir = join(tmpRoot, '.claude');
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    writeFileSync(join(claudeDir, 'commands', 'peek_start.md'), 'old content');

    const result = runInstall({ claudeDir, skillsSourceDir: SKILLS_SOURCE, force: true });

    expect(result.ok).toBe(true);
    expect(result.target).toBe('commands');
    const body = readFileSync(join(claudeDir, 'commands', 'peek_start.md'), 'utf8');
    expect(body).not.toBe('old content');
    expect(body).toContain('/api/markers');
  });

  test('returns manual-instructions result when ~/.claude/ does not exist', () => {
    const claudeDir = join(tmpRoot, 'does-not-exist', '.claude');

    const result = runInstall({ claudeDir, skillsSourceDir: SKILLS_SOURCE });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-claude-dir');
    // Nothing should have been created on disk.
    expect(existsSync(claudeDir)).toBe(false);
  });

  test('creates commands/ subdir when ~/.claude/ exists but commands/ and skills/ do not', () => {
    const claudeDir = join(tmpRoot, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    const result = runInstall({ claudeDir, skillsSourceDir: SKILLS_SOURCE });

    expect(result.ok).toBe(true);
    expect(result.target).toBe('commands');
    expect(existsSync(join(claudeDir, 'commands', 'peek_start.md'))).toBe(true);
    expect(existsSync(join(claudeDir, 'commands', 'peek_end.md'))).toBe(true);
  });
});
