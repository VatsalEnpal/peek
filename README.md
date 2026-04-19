# Peek

**A local recorder for Claude Code sessions.** Mark an interval with `/peek_start NAME`, work normally, close it with `/peek_end` — and get back a complete, navigable log of every tool call, file read, subagent, and API request that happened inside the window. All local. Nothing leaves your laptop.

![demo](docs/demo.gif)

<!-- placeholder — demo GIF recorded against the live v0.3 flow -->

---

## Install (30 seconds)

```bash
npx peek install     # installs /peek_start + /peek_end into ~/.claude/commands/
peek                 # starts the recorder daemon at http://127.0.0.1:7335
```

Open Claude Code, type `/peek_start my-topic`, do your thing, type `/peek_end`. Open [http://127.0.0.1:7335](http://127.0.0.1:7335) to see the recording.

No config. No accounts. No network calls to anyone but your own machine.

## How it works

**Peek only shows sessions you explicitly record with `/peek_start`. Your other Claude Code activity stays invisible.**

That's the whole model. Peek is not a passive observatory of everything Claude Code does — it's a recorder you consciously turn on and off. If you never type `/peek_start`, the landing page stays empty no matter how much Claude Code activity happens on your machine.

### The recording lifecycle

1. In any Claude Code session, type `/peek_start my-topic` — a new recording opens (status: `recording`, with a pulsing amber dot in the UI).
2. Work normally. Every tool call, file read, grep, bash, API call, and subagent dispatched from that session streams into the recording live.
3. Type `/peek_end` — the recording closes (status: `closed`).

A few rules that keep this sane:

- **One recording at a time per session.** If you type `/peek_start NAME2` while a recording is already open in the same Claude Code session, Peek auto-saves the previous one (status: `auto-closed-by-new-start`) and opens the new one. Like hitting record on a camcorder while already recording — the previous file saves, a new one starts.
- **10-minute idle auto-close.** If you quit Claude Code or the session goes idle for 10 minutes, Peek auto-closes the recording with status `auto-closed` and the end timestamp is stamped at the last event it saw.
- **Sessions, not windows.** A recording is tied to the single Claude Code session where you typed `/peek_start`. Two sessions running in parallel in different terminals are independent; recording one does not capture the other.

### Text marker fallback

Don't want to install the slash commands? Type markers as plain text in your Claude Code prompt:

```
@peek-start my-topic
…work normally…
@peek-end
```

The markers must be the **entire prompt** on their own — Peek deliberately ignores `@peek-end` if it appears inside prose so your documentation and README diffs don't accidentally start recordings.

Slash commands are the preferred flow. The text fallback exists for users who haven't run `peek install`.

## What a recording captures

Everything you'd see if you pressed `Ctrl+O` in Claude Code during the window:

- Every user prompt in that session
- Every assistant response + token usage
- Every tool call (`Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`, `WebFetch`, `TodoWrite`, MCP calls…) with its inputs and outputs
- Every subagent spawned from the session — including **every tool call the subagent itself made**, rendered inline as an indented group under the subagent header
- Every `Skill` invocation
- Every hook fire

## What a recording does NOT include

- Other Claude Code sessions running in other terminals you didn't `/peek_start`
- Events in the same session that happened before `/peek_start` or after `/peek_end`
- Claude Code lifecycle noise (`bridge_status`, `permission-mode`, `file-history-snapshot`, `turn_duration`, `auto_mode`, and their ~10 siblings) — hidden by default. A "show internal events" toggle on the detail page turns them back on.

## Privacy

Peek binds to **`127.0.0.1` only**. Nothing leaves your laptop. No telemetry. No cloud. No login.

The daemon stores recordings and events under `~/.peek/` on your machine. Capture-time secret redaction hashes `.env` values, API keys, and credentials before writing, so even the local database never sees them in plaintext. The source files stay where they are on disk; Peek holds pointers, not copies.

## Commands

| Command              | Purpose                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `peek`               | Start the recorder on `http://127.0.0.1:7335`.                                                                                          |
| `peek install`       | Copy `/peek_start` and `/peek_end` into `~/.claude/commands/`. `--force` overwrites. `--target <dir>` installs elsewhere (for testing). |
| `peek serve`         | HTTP server only (no watcher). `--port` overrides 7335.                                                                                 |
| `peek watch`         | JSONL watcher only (no UI). For headless setups.                                                                                        |
| `peek import <path>` | One-shot import of a JSONL file or directory. Only populates the legacy `/sessions` view — recordings still require `/peek_start`.      |

Environment variables:

- `PEEK_PORT` — override the default live-mode port (`7335`).
- `PEEK_HOST` — override `127.0.0.1`. Use `0.0.0.0` inside a container if you need LAN access (not recommended on trusted networks only).

## Routes

- `/` — the recordings list (what you made with `/peek_start`)
- `/recording/:id` — the full detail view for one recording
- `/sessions` — legacy view of every Claude Code session Peek has ever imported (useful for `peek import` users; not the default)

## Keyboard shortcuts

| Key       | Action                              |
| --------- | ----------------------------------- |
| `?`       | Open the help drawer                |
| `Esc`     | Close any open drawer or modal      |
| `/`       | Focus the search input              |
| `j` / `k` | Next / previous row in the timeline |

## Troubleshooting

**`peek: daemon not running — start with "peek"`**
You typed `/peek_start` but `peek` isn't running. Open another terminal and run `peek`. Leave it running while you work.

**Port 7335 already in use**
Another process owns the port. Either stop it, or run `PEEK_PORT=7336 peek` and set the same `PEEK_PORT` in the shell where Claude Code runs so the slash commands hit the right daemon.

**`~/.claude/ not found at …`**
`peek install` couldn't find Claude Code's config directory. Install Claude Code first (`https://claude.ai/code`), run it once, then retry `peek install`. As a fallback you can copy `skills/peek_start/SKILL.md` and `skills/peek_end/SKILL.md` to `~/.claude/commands/peek_start.md` and `peek_end.md` yourself.

**Slash commands installed but `/peek_start` does nothing**
Restart Claude Code. It only scans `~/.claude/commands/` on startup.

**Recording stays empty**
Check that `peek` was running _before_ you typed `/peek_start`. If you started it after, the events already appended to the session's JSONL are lost to the recording window — a new `/peek_start` will capture everything from that point forward.

## License

Apache-2.0. See [LICENSE](LICENSE), [SECURITY.md](SECURITY.md), and [CONTRIBUTING.md](CONTRIBUTING.md).
