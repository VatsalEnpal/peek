# Peek

**A local-first observatory for what your Claude Code agents actually loaded into context.**

Peek watches your Claude Code sessions live — every tool call, every file read, every subagent spawn, every token — and renders them in a browser on your machine. Nothing leaves your laptop.

## Demo

![demo](docs/demo.gif)

<!-- placeholder — demo GIF recorded against the live v0.2.1 flow -->

Type `/peek_start my-topic` in any Claude Code session. Ask Claude to do things. Every tool call, file read, and token count streams live into Peek at `http://localhost:7335`. Type `/peek_end` and a bookmark for that slice of the session appears on the timeline.

## Install

```bash
npx peek install     # installs /peek_start + /peek_end into ~/.claude/
peek                 # starts watcher + UI at http://localhost:7335
```

No config. No accounts. No network calls to anyone but your own machine.

## Use

1. Open Claude Code in any project.
2. Type `/peek_start my-topic` — bookmark range opens.
3. Open `http://localhost:7335` — watch the session stream live.
4. Type `/peek_end` when done — the bookmark closes and appears on the timeline.

That's it. Everything between the two markers is grouped into one bookmark you can re-open later.

## Text-marker fallback

Don't want to install slash commands? Type the markers as plain text in your Claude Code prompt:

```
@peek-start my-topic
...your normal prompts...
@peek-end
```

Peek's watcher picks these up directly from the JSONL that Claude Code writes to `~/.claude/projects/`. No curl, no daemon call from Claude. Exactly the same result.

## How it works

- Claude Code already writes every session as append-only JSONL to `~/.claude/projects/<slug>/<session-id>.jsonl`.
- `peek watch` tails those files with `chokidar` and imports each new line incrementally.
- `peek serve` exposes an HTTP + Server-Sent Events API on port 7335.
- The browser UI subscribes to SSE and renders sessions, turns, tool calls, and bookmarks as they happen.

All state lives in `~/.peek/` on your machine. No telemetry. No cloud. No login.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `?` | Open the help drawer |
| `Esc` | Close any open drawer or modal |
| `/` | Focus the search input |
| `g s` | Go to session list |
| `j` / `k` | Next / previous row in the timeline |

## Commands

| Command | Purpose |
| --- | --- |
| `peek` | Start watcher + UI on `http://localhost:7335` (default). |
| `peek install` | Copy `/peek_start` and `/peek_end` into `~/.claude/commands/`. `--force` overwrites. `--target <dir>` installs elsewhere (for testing). |
| `peek serve` | Start the HTTP server only. `--port` overrides 7334. `--watch` co-runs the watcher. |
| `peek watch` | Start the JSONL watcher only (no UI). Useful for headless setups. |
| `peek import <path>` | One-shot import of a JSONL file or directory into the local store. `--preview` scans without writing. |

Environment variables:

- `PEEK_PORT` — override the default live-mode port (`7335`).

## Troubleshooting

**`peek: daemon not running — start with "peek"`**
You ran `/peek_start` but `peek` isn't running. Open another terminal and run `peek`. Leave it running while you work.

**Port 7335 already in use**
Another process owns the port. Either stop it, or run `PEEK_PORT=7336 peek` and set the same `PEEK_PORT` in the shell where Claude Code runs so the slash commands hit the right daemon.

**`~/.claude/ not found at …`**
`peek install` couldn't find Claude Code's config directory. Install Claude Code first (`https://claude.ai/code`), run it once, then retry `peek install`. As a fallback you can copy `skills/peek_start/SKILL.md` and `skills/peek_end/SKILL.md` from this repo to `~/.claude/commands/peek_start.md` and `peek_end.md` yourself.

**Slash commands installed but `/peek_start` does nothing**
Restart Claude Code. It only scans `~/.claude/commands/` on startup.

**Session not appearing in the UI**
`peek` must be running before Claude Code starts writing to `~/.claude/projects/`. If you started `peek` after, run `peek import ~/.claude/projects/<slug>` to backfill.

## What makes Peek different

Claude Code already emits OTel telemetry. Peek gives you things telemetry doesn't:

- **Retroactive.** Reads sessions that existed before you turned anything on — the JSONL is always there.
- **Per-artifact tokens.** Each file, each tool result, each `CLAUDE.md` injection gets its own token count, not just per-turn totals.
- **Narrative view.** Read a session back as prose: *"At 14:03 you asked 'fix the PTY bug.' Agent loaded CURRENT_STATE.md (1,800 tokens), ran `grep zombie`, spawned a pty-specialist subagent…"*
- **Session identity that works.** The `{slug} · first-prompt · branch · time-ago` label tells ten same-folder sessions apart.
- **Capture-time secret redaction.** `.env` values, API keys, and credentials never reach Peek's database — only deterministic hashes. The source stays on your disk; Peek holds pointers, not copies.

## License

Apache-2.0. See [LICENSE](LICENSE), [SECURITY.md](SECURITY.md), and [CONTRIBUTING.md](CONTRIBUTING.md).
