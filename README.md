# Peek

**See what your agents actually loaded.**

Peek is a local-first trace viewer for Claude Code sessions. Point it at `~/.claude/projects/` and see every turn, every tool call, every file loaded into context — with exact input token counts per artifact.

> Anthropic's guidance is ~10,000 input tokens in a static context before degradation compounds. Peek shows you where you are on that ceiling, live, per turn, per file loaded.

## Install

```bash
npx peek-trace
```

Or:

```bash
npm install -g peek-trace
peek
```

## What's different

Claude Code already ships OTel telemetry. What Peek does that existing tools don't:

- **Retroactive.** Reads sessions that existed BEFORE you turned telemetry on, because Claude Code writes JSONL to disk unconditionally.
- **Per-artifact tokens.** Each file, each tool result, each `CLAUDE.md` injection gets its own token count — not just per-turn totals.
- **Narrative view.** Click a session and read back what happened as prose: *"At 14:03 you asked 'fix the PTY bug.' Agent loaded CURRENT_STATE.md (1,800 tokens), ran `grep zombie`, spawned a pty-specialist subagent …"*
- **Session identity that works.** The `{slug} · first-prompt · branch · time-ago` label finally tells your 10-same-folder sessions apart.
- **Capture-time secret redaction.** Your `.env` values, API keys, and credentials never land in Peek's database — only deterministic hashes. Source stays on your disk; we hold pointers, not copies.

## License

Apache-2.0. See [LICENSE](LICENSE) and [SECURITY.md](SECURITY.md).

## Status

v0.0.1 — scaffold. v0.1 ships tonight.
