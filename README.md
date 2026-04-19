# Peek

**An observatory for Claude Code.** The single biggest determinant of useful work from an agent is *what entered context, in what order, at what cost*. Too much and it loses focus, output degrades. Too little and there's no guardrail. Peek shows you that composition — every file, skill, rule, memory, hook, tool call, and MCP call that entered context during an interval you marked. Listed. Tokenized. Drillable. Nothing leaves your laptop.

---

## Why this exists

I spent a long time trying to find something that shows context composition in a human-digestible way. Nothing did.

Anthropic's built-in telemetry is **span-oriented**: one row per API call or tool use. That answers "what did the agent do?" It does not answer "what did the agent's context look like when it made those decisions?"

Peek is **artifact-oriented**: one row per artifact that entered context during your interval. Same underlying data, different view. When an agent spawns a subagent and pulls in six files, three skills, two MCP responses, and a batch of memories — Peek shows you all of that as a navigable list, with per-artifact token counts and expandable bodies.

The beauty of Claude Code is you can just build what you need. So I did.

## How it feels to use

You type `/peek_start refactoring-auth`. You work normally. You type `/peek_end`. You refresh `http://127.0.0.1:7335` and see a view like this:

```
22:04:04  👥  SUBAGENT  Agent: orchestrator                 18 children  ▾
22:04:04  💬  USER_PROMPT  user_prompt                              150  ▸
22:04:06  🤖  API_CALL     api_call                                  13  ▾
          OUTPUTS  I'll start by exploring the working directory
                   to find git repositories.
22:04:07  ▸   TOOL_CALL    Bash                                       45  ▸
22:04:09  ▸   TOOL_CALL    Bash                                       74  ▸
22:04:11  🤖  API_CALL     api_call                                  31  ▾
          OUTPUTS  There are multiple repos. I need to determine
                   which one is "the current repository"…
```

Click any row. The panel slides open with the real content — the file the agent read, the exact Bash command with full stdout, the MCP response body, the skill that was activated, the memory block that was injected. Subagents collapse into groups with accurate child counts; every artifact their sub-context pulled in is visible under the parent row. Lifecycle noise (permission-mode changes, file-history snapshots, etc.) is hidden by default; one click reveals it.

Peek is a **recorder by design** — you consciously turn it on with `/peek_start` and off with `/peek_end` — and an **observatory by output** — every artifact that was in-context during the interval is there, drillable, with tokens. Other Claude Code sessions on your machine stay invisible until you `/peek_start` inside them.

---

## Get it running

**Prerequisites:** Node.js 22 or newer, and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and run at least once (so `~/.claude/` exists).

```bash
git clone https://github.com/VatsalEnpal/peek.git
cd peek
npm install
npm run build
node dist/bin/peek.js install
node dist/bin/peek.js serve
```

You should see:

```
peek live on http://127.0.0.1:7335 (dataDir=~/.peek, watch=~/.claude/projects)
```

Open Claude Code. Type `/peek_start my-topic`. Work. Type `/peek_end`. Refresh `http://127.0.0.1:7335`.

> **Heads up — known v0.3 limitation.** The recording picks the "current" Claude Code session by watching which JSONL was most recently appended. If you have multiple CC windows writing at the same time, a recording may briefly attribute to whichever one happened to blink last. For single-session workflows (almost everyone) this is invisible. If you're dogfooding Peek while debugging Peek in a second window — close one or wait for v0.3.1, which makes the JSONL-side marker authoritative.

---

## The mental model

**Only intervals you explicitly record show up.** If you never type `/peek_start`, Peek's landing page stays empty no matter how much Claude Code activity your machine sees. Peek does not passively vacuum your agent history. You turn it on when something matters.

Three rules keep it sane:

- **One recording at a time per session.** A second `/peek_start` auto-saves the previous one and starts fresh — like hitting record on a camcorder while already recording.
- **10-minute idle auto-close.** If you quit Claude Code or the session goes quiet, Peek closes the recording at the last event it saw.
- **Recording follows the session it was started in.** Other Claude Code sessions in other terminals are invisible unless you `/peek_start` inside them too.

## What a recording does NOT include

- Other Claude Code sessions you didn't `/peek_start`
- Events in the same session from before `/peek_start` or after `/peek_end`
- Claude Code lifecycle chatter (`permission-mode`, `file-history-snapshot`, `turn_duration`, `last-prompt`, and ~10 siblings) — hidden by default. Toggle "show internal events" on the detail page to see them.

## Privacy

Peek binds to `127.0.0.1` only. No telemetry. No cloud. No login. Your recordings live under `~/.peek/`. Capture-time redaction hashes `.env` values and API-key-looking tokens before writing — even your local database never sees secrets in plaintext.

---

## Reference

### Commands

| Command              | Purpose                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| `peek`               | Start the observatory (HTTP + JSONL watcher) on `http://127.0.0.1:7335`. Equivalent to `peek serve`.      |
| `peek serve`         | Same as `peek` with explicit flags. Watcher runs by default; pass `--no-watch` to disable. `--port`, `--data-dir`, `--claude-dir` override the defaults. |
| `peek install`       | Copy `/peek_start` and `/peek_end` into `~/.claude/commands/`. `--force` overwrites. `--target <dir>` installs elsewhere. |
| `peek import <path>` | One-shot import of a JSONL file or directory. Populates the legacy `/sessions` view; recordings still require `/peek_start`. |

### Environment variables

- `PEEK_PORT` — override the default port (`7335`). Honored by the daemon AND by the slash commands, so setting it once makes both ends match.
- `PEEK_DATA_DIR` — override `~/.peek/`. Useful for hermetic test runs or keeping recordings under a project tree.
- `PEEK_HOST` — override `127.0.0.1`. Use `0.0.0.0` only on trusted networks (containers, remote dev boxes).

### Keyboard shortcuts

| Key                                   | Action                                     |
| ------------------------------------- | ------------------------------------------ |
| `?`                                   | Open the help drawer                       |
| `Esc`                                 | Close any open drawer or modal             |
| `j` / `k` (or `↓` / `↑`)              | Next / previous row in the timeline        |
| `h` / `l` (or `←` / `→`)              | Collapse / expand the focused row          |
| `Enter`                               | Open / drill into the focused row          |
| `Cmd+Shift+R` / `Ctrl+Shift+R`        | Toggle recording                           |

### Routes

- `/` — the recordings list (intervals you marked with `/peek_start`)
- `/recording/:id` — the full detail view for one recording
- `/sessions` — legacy view of every imported Claude Code session (for `peek import` users)

### Troubleshooting

**`peek: daemon not running — start with "peek"`**
The daemon isn't running. Open another terminal and run `peek`. Leave it running while you work.

**Port 7335 already in use**
Another process owns the port. Either stop it, or run `PEEK_PORT=7336 peek` — the slash commands honor the same env var so they still hit the right daemon.

**`~/.claude/ not found`**
`peek install` couldn't find Claude Code's config directory. Install Claude Code, run it once, then retry `peek install`. Fallback: copy `skills/peek_start/SKILL.md` and `skills/peek_end/SKILL.md` into `~/.claude/commands/peek_start.md` and `peek_end.md` yourself.

**Slash commands installed but `/peek_start` does nothing**
Restart Claude Code. It scans `~/.claude/commands/` only on startup.

**Recording stays empty**
Check that `peek` was already running *before* you typed `/peek_start`. Events appended to the JSONL before the start marker are out of the recording window.

---

## License

Apache-2.0. See [LICENSE](LICENSE), [SECURITY.md](SECURITY.md), and [CONTRIBUTING.md](CONTRIBUTING.md).
