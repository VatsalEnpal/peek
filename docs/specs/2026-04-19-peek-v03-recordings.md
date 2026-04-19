# Peek v0.3 — Recordings Spec

> Locked: 2026-04-19 evening. Pivoted after v0.2.1 morning-test revealed architecture/UX mismatch.
> Source of truth for builder + tester loops.

## Product framing

**Peek is a recorder, not a viewer.**

Users explicitly mark intervals of interest with `/peek_start NAME` and `/peek_end`. Peek captures everything that happens inside that interval in the Claude Code session where it was invoked, and shows exactly that — nothing more.

The mental model: like a screen recorder for your agent, but captures structured events (tool calls, API calls, subagents) instead of pixels. When you want to show someone "here's what the agent actually did," you share a recording.

## What users see

### Landing page = Recordings list

Only rows that are recordings. **Not sessions.** One row per `/peek_start NAME` → `/peek_end` pair (or unclosed).

Tabular:
```
│ Name              │ Started   │ Duration │ Tools │ API │ Tokens   │ Status    │
├───────────────────┼───────────┼──────────┼───────┼─────┼──────────┼───────────┤
│ refactoring-task  │ 14:32     │ 12m 04s  │ 28    │ 45  │ 87,412   │ ● closed  │
│ agentstudio-test  │ 13:15     │ ongoing  │ 12    │ 9   │ 14,280   │ ● recording │
│ debug-auth-flow   │ yesterday │ 3m 12s   │ 6     │ 11  │ 4,512    │ ● closed  │
```

Sort by started-desc. Live recordings pinned to top with pulsing dot. Click a row → detail.

Empty state: "No recordings yet. In Claude Code, type `/peek_start NAME` to start a recording."

### Detail page = the recording, expanded

Like Ctrl+O in CLI but structured and navigable:

```
← BACK TO RECORDINGS

refactoring-task
started 14:32 · 12m 04s · 28 tool calls · 45 api calls · 87,412 tokens

───────────────────────────────────────────────────────────

🗨  14:32:01   "Dispatch the security agent to scan the repo"                  (0 tokens — you)

🤖  14:32:03   [assistant] I'll dispatch the security agent.                   (42 tokens)

👥  14:32:05   SUBAGENT: security (general-purpose)
    ├─ 14:32:06   📄 Read       CLAUDE.md                            1,242  ▸
    ├─ 14:32:07   📄 Read       .claude/agents/security.md             890  ▸
    ├─ 14:32:07   🔍 Grep       "onDrop|dataTransfer" in src/          340  ▸
    ├─ 14:32:08   💻 Bash       ls src/components/terminal/             95  ▸
    ├─ 14:32:09   🌐 API call   claude (opus)                        3,217  ▸
    ├─ 14:32:10   📄 Read       server/index.ts                      2,104  ▸
    ├─ 14:32:11   🔍 Grep       "verifyClient|origin" in server/       282  ▸
    └─ ... 21 more in this subagent

🤖  14:44:05   [assistant] Security scan complete. Findings: ...            (1,821 tokens)

───────────────────────────────────────────────────────────
/peek_end at 14:44:05
```

Click any row `▸` → expands in place showing inputs (exact file path, exact grep pattern, exact bash command, exact prompt text) and outputs (truncated file content, grep matches, command output) — redacted where secrets detected.

### Hidden by default (toggle to show)

Claude Code lifecycle events — `bridge_status`, `command_permissions`, `mcp_instructions_delta`, `deferred_tools_delta`, `stop_hook_summary`, `auto_mode`, `turn_duration`, `file-history-snapshot`, `permission-mode`, `away_summary`, `last-prompt`, `queue-operation`, `task_reminder`. These confuse users and aren't the point.

A "Show internal events" toggle in the filter chip row reveals them.

## Data model

**Recording** (new first-class entity):
- `id` (uuid)
- `name` (from /peek_start arg — "refactoring-task")
- `sessionId` (the CC session UUID where /peek_start was invoked — for FK)
- `startTs` / `endTs` (endTs null while recording, set on /peek_end OR when the session's JSONL stops appending for > 10 min)
- `status` ('recording' | 'closed' | 'auto-closed')

**Events inside a recording** (all filtered by: event.sessionId == recording.sessionId AND event.ts BETWEEN recording.startTs AND recording.endTs):
- Must come from the exact session where /peek_start was invoked
- Subagent events stay attached to their parent span
- Lifecycle events filtered out of default view

## The `/peek_start` → `/peek_end` lifecycle

1. User types `/peek_start NAME` in CC session S
2. Slash command runs `curl POST /api/markers {type: "start", name: NAME}` — session detection picks S as current
3. Peek creates recording row `{name: NAME, sessionId: S, startTs: now(), status: "recording"}`
4. **One recording at a time per session.** If a recording is already open in session S and the user types `/peek_start NAME2`, the existing recording auto-closes (endTs = now, status = "auto-closed-by-new-start") and a new recording starts. Like hitting record on a camcorder while already recording — the previous file saves, a new one starts. The `/peek_end` between them is implicit.
5. User does things. Events accumulate in session S's JSONL. Peek's watcher picks them up.
6. User types `/peek_end` → recording.endTs = now(), status = "closed"
7. If user never /peek_ends and the session's JSONL stops getting new events for 10 minutes → Peek marks the recording as "auto-closed" with endTs = last-event-ts

## Scope boundaries

**Recording captures:**
- ✓ Every user prompt in session S during the interval
- ✓ Every assistant response in session S during the interval
- ✓ Every tool call made BY session S (Bash, Read, Write, Grep, etc.)
- ✓ Every API call logged in session S
- ✓ Every subagent dispatched FROM session S, including ALL its nested tool calls
- ✓ Every Skill invocation in session S
- ✓ Every hook fire in session S

**Recording does NOT capture:**
- ✗ Other CC sessions running in other terminals (unless explicitly /peek_start'd there)
- ✗ Events from session S that happened before /peek_start or after /peek_end
- ✗ Background system noise from Peek itself

## Critical fixes from v0.2.1 findings

1. **Marker regex** — only match `^/peek_(start|end)` as the WHOLE user_prompt text, not prose containing `@peek-end`. (Current regex picks up doc text.)
2. **Idempotent marker handler** — dedupe by `tool_use_id` so repeated /peek_start in the transcript don't create N bookmarks for 1 command.
3. **First-prompt cleanup** — strip `<command-message>` XML AND skip the SKILL body (the "# /peek_start — Open a Peek bookmark range" markdown) when deriving recording display names.
4. **Within-file import yielding** — setImmediate between event-parsing batches inside `importPath()` so a single huge JSONL doesn't block the event loop (L10 residual).
5. **Subagent surfacing** — subagent's own tool calls MUST render inline in the timeline, grouped under the parent subagent span. Currently they vanish.

## Acceptance criteria (for tester loop)

The tester loop runs this exact scenario and verifies the output, not just unit tests:

**Setup:**
- Clean data dir
- Daemon running
- Headless Claude Code spawned via `claude -p` subprocess OR a Docker container with real CC

**Flow (automated):**
1. Open CC session in `~/Code/personal/AgentStudio`
2. Run: `/peek_start security-scan-test`
3. Run: `"dispatch the security agent to scan this repo"`
4. Wait for security agent to complete (may take 60s+; many tool calls)
5. Run: `/peek_end`
6. From inside CC, capture the list of tool calls the security agent made (via CC's event transcript — this is the ground truth)

**Verification (tester must do all four):**
- **Provenance:** Count each tool type in CC's transcript vs Peek's recording detail. They must match exactly. Zero discrepancy.
- **Vision:** Take a screenshot of Peek's recording detail. Ask Claude native vision: "Is this a readable, well-organized list of tool calls that a user would find easy to scan?" Fail if the answer flags broken layout / unclear grouping / missing data.
- **Scope:** Verify Peek's recording ONLY shows events from the CC session that did /peek_start. Run a second CC session in parallel during the recording and verify none of its events appear in the recording.
- **Scroll + navigation:** Click on the recording, scroll to the bottom, click back, verify it returns to the recordings list (not to the old sessions list). Verify expand/collapse on tool call rows works.

**Pass conditions:**
- All 4 verifications pass
- Recording name = "security-scan-test" (not hex ID, not XML, not SKILL body)
- Tool count matches exactly (if CC did 28 tool calls inside the subagent, Peek shows 28)
- Zero events from the parallel unrelated CC session leak in
- Vision critique returns "yes, readable" without objections

**Fail = builder fixes, tester re-runs. Oscillation rule: if same finding reappears after claimed fix, halt and escalate.**

## What's NOT in v0.3 (explicitly deferred)

- Multi-session concurrent recording (one session at a time is fine)
- Search/filter across recordings
- Export to JSON/markdown
- Shareable recording links
- Token-attribution redesign (per-span token accuracy — deferred; for v0.3 we show what we have, labeled clearly)
- Cloud sync / auth
- iOS / Windows

## README requirements (mandatory before ship)

The README must make these behaviors crystal clear, not hidden in deep docs:

1. **"Only recordings show up."** In the How It Works section, bold: *"Peek only shows sessions you explicitly record with `/peek_start`. Your other Claude Code activity stays invisible."*

2. **The `/peek_start NAME` → `/peek_end` lifecycle.** Document:
   - Type `/peek_start my-topic` to start recording
   - Type `/peek_end` to save the recording
   - Only one recording at a time per session
   - Starting a new `/peek_start` while one is active auto-saves the previous one
   - If you close Claude Code or leave the session inactive for 10 min, recording auto-closes

3. **Text marker fallback for users who haven't installed slash commands:** `@peek-start NAME` and `@peek-end` as literal text in your prompt. Document this as a fallback only; `/peek_start` is the preferred flow.

4. **What goes inside a recording:** every tool call, every subagent's tool calls (inline), every API call, every file read, every grep, every bash command — exactly what you see if you press Ctrl+O in Claude Code during that time window. Lifecycle noise (bridge_status, permission checks, etc.) hidden by default.

5. **What does NOT appear:** other Claude Code sessions you didn't /peek_start, sessions from before Peek was installed, lifecycle cruft.

6. **Install flow in 30 seconds:**
   ```
   npx peek install
   peek
   # → http://127.0.0.1:7335
   # Open Claude Code, type /peek_start <name>, do stuff, /peek_end
   ```

7. **Privacy / trust:** "Peek never sends your data anywhere. All local. Daemon binds to 127.0.0.1 only."

## Commit / branch plan

- New branch: `feat/v03-recordings`
- Builder loop + tester loop in separate worktrees, IPC via shared dir
- Ship gate: all 4 verifications green on tester, no oscillations, user does final manual walkthrough before tag `v0.3.0`

## The playbook this time

Use the ShipLoop v2 playbook at `~/Code/work/repos/biz-ops/docs/shipping-with-claude-code.md` — the 60 lessons from this whole week. Specifically:
- §MENTAL-MODEL section in plan (lesson 52)
- Real user flow test, not API correctness (lesson 58)
- Run code review before declaring ready (lesson 60)
- Pre-flight IPC smoke test (lesson 7)
- Regression-based oscillation detection (lesson 5)
- Test like the user: real CC invocation, real subagent, real Ctrl+O comparison (new, from tonight's debrief)
