# Peek v0.3 — Builder Plan

> **For agentic workers:** REQUIRED SUB-SKILLS — superpowers:test-driven-development, superpowers:verification-before-completion, superpowers:systematic-debugging, frontend-design:frontend-design.
> **Spec:** `docs/specs/2026-04-19-peek-v03-recordings.md` (READ BEFORE EACH GROUP).
> **Worktree:** `~/Code/personal/peek-trace-v03-builder` (branch `feat/v03-recordings`).
> **Shared IPC:** `.peek-v03/shared/` (symlinked to `/tmp/peek-v03-ipc`). Read `BLOCKING` at each tick start, delete after addressing.

**Goal:** Reframe Peek from "session viewer" to "recordings viewer." Only /peek_start → /peek_end intervals surface, named by user, full Ctrl+O-equivalent tool call list, subagents grouped visually, lifecycle noise hidden.

**Architecture:** Add Recording as first-class entity (new table). Change landing page from sessions-list to recordings-list. Rewrite detail page around a recording's bounded event range. Fix marker regex strictness + idempotency + subagent surfacing + within-file import yielding.

**Tech Stack:** Existing (Express, React, Vite, better-sqlite3, chokidar). No new runtime deps.

---

## Tick start protocol (every tick)

1. Read `.peek-v03/shared/OSCILLATION` — if exists, halt entirely; write "halted for human review" to logs/halt.log. Do not resume.
2. Read `.peek-v03/shared/BLOCKING` — if exists, read `.peek-v03/shared/tester-findings.md`:
   - Findings overlapping current group → fix now, prefix commit with `fix(blocking): ... (finding N)`
   - Findings for later groups → note, continue
3. Execute next uncompleted plan sub-task.
4. Run `npm run build && npm run test:unit` — must be green.
5. Commit with `feat(LX.Y): ...` or `fix(blocking): ...`.
6. Update `.peek-v03/shared/state/builder.json`.
7. Append one-line log to `.peek-v03/shared/logs/builder.log`.
8. If group N complete AND all findings addressed → delete `.peek-v03/shared/BLOCKING`.
9. If L6 ship-gate passes → write `.peek-v03/shared/BUILDER-COMPLETE`, stop scheduling wakeup.
10. Otherwise → `ScheduleWakeup(120s)`.

---

## §MENTAL-MODEL

The 5 things a first-time user will try in the first 2 minutes:
1. Install with `npx peek install` → works, slash commands appear in `~/.claude/commands/`
2. Run `peek` → daemon starts in <1s, UI loads, empty recordings list with hint
3. In CC type `/peek_start demo` → bookmark appears in UI within 3s
4. Dispatch a subagent (e.g. `"run the security agent"`) → timeline fills with subagent's tool calls inline under a subagent section, expandable
5. Type `/peek_end` → recording closes, visible as closed in list, click → detail shows full log, back button returns to recordings list

All 5 must work before ship-gate.

---

## §DATA-MAPPING (verified)

Same as v0.2.x — `~/.claude/projects/<slug>/<session-uuid>.jsonl`, append-only. Marker content is in `message.content[0].text` on user_prompt events. Subagent JSONL: `~/.claude/projects/<slug>/<session-uuid>/subagents/agent-<id>.jsonl`. Subagent agentId comes from the `queued_command` attachment's `<task-id>` regex match (verified).

**Marker regex (tightened for v0.3):** `^\s*\/peek_(start|end)(?:\s+(\S+(?:\s+\S+)*?))?\s*$` — matches ONLY entire user_prompt equaling the slash command, not prose containing the text. Same for `@peek-start`.

---

## Groups

### L1 — Recording entity + data model

**L1.1 — Recording table + store methods**
- File: `server/pipeline/store.ts` (modify)
- Add `recordings` table: `id TEXT PK, name TEXT, session_id TEXT FK, start_ts TEXT, end_ts TEXT NULL, status TEXT ('recording'|'closed'|'auto-closed'|'auto-closed-by-new-start'), created_at TEXT`
- Add methods: `putRecording(r)`, `listRecordings()`, `getRecording(id)`, `listOpenRecordingsBySession(sessionId)`, `closeRecording(id, endTs, reason)`
- Migration: drop-and-recreate (this is a dev DB, not prod)

**L1.2 — Marker regex strictness + idempotency**
- File: `server/bookmarks/marker-detector.ts` (modify), `server/api/markers.ts` (modify)
- New regex per §DATA-MAPPING — only match if the full user_prompt text is exactly the slash command
- Add idempotency: marker import dedupe key = `tool_use_id` of the slash command event. If already seen → skip.
- Text-marker (`@peek-start`) same strictness

**L1.3 — Marker → Recording lifecycle**
- File: `server/api/markers.ts`, `server/pipeline/import.ts` (modify)
- On /peek_start NAME:
  1. If recording already open in same session → close it with status='auto-closed-by-new-start'
  2. Create new recording row
  3. Broadcast SSE `recording:started`
- On /peek_end: close current open recording → status='closed', broadcast SSE `recording:ended`
- Auto-close on file inactivity: watcher tracks last-event-ts per session; if > 10min since last event AND recording still open → close with status='auto-closed'

**L1.4 — Unit tests (TDD: red→green→commit per test)**
- `tests/unit/recording-lifecycle.spec.ts`: 10 cases
  - Start + end → one closed recording
  - Start twice → first auto-closed-by-new-start, second open
  - Start + timeout → auto-closed
  - Regex does NOT match prose `"the @peek-end marker is useful"`
  - Regex DOES match `"/peek_start my-test"` exactly
  - Regex matches `"/peek_start my topic with spaces"`
  - Idempotent: importing same tool_use_id twice → one recording
  - Two sessions, one /peek_start in A, B's events not in A's recording
  - /peek_end without /peek_start → orphan end stored (doesn't crash)

### L2 — Recordings API

**L2.1 — GET /api/recordings** — list, with: id, name, sessionId, startTs, endTs, status, duration, tool count, api count, token total (computed from events bounded by range)

**L2.2 — GET /api/recordings/:id/events** — the events from the recording's session, bounded by startTs..endTs (inclusive), with lifecycle events filtered out by default. Query param `?includeLifecycle=1` shows them.

**L2.3 — GET /api/recordings/:id** — summary stats + name + timestamps

**L2.4 — SSE events added** — `recording:started`, `recording:ended`, plus existing `span:new` now also carries recordingId when the event falls inside an open recording

**L2.5 — Integration tests**: import JSONL with /peek_start → 5 tool calls → /peek_end → assert recordings list, detail, event bounds

### L3 — Recordings UI (landing page)

**L3.1 — RecordingsPage** (`src/pages/RecordingsPage.tsx`, new)
- Tabular layout: Name | Started | Duration | Tools | API | Tokens | Status
- Row = recording, click → /recording/:id
- Sort: active recordings pinned top, then by startTs desc
- LIVE pulsing amber dot for status='recording'
- Empty state: "No recordings yet. In Claude Code, type `/peek_start NAME` to start recording."

**L3.2 — Route change** (`src/main.tsx` or router file)
- `/` → RecordingsPage (replaces SessionsPage)
- `/sessions` → legacy SessionsPage (kept for `peek import` users)
- `/recording/:id` → RecordingDetailPage

**L3.3 — SSE wiring in RecordingsPage**
- On `recording:started`: add row with LIVE badge
- On `recording:ended`: flip badge to closed, update stats
- On `span:new` with recordingId matching a visible row: increment counters live

### L4 — Recording detail UI (the Ctrl+O experience)

**L4.1 — RecordingDetailPage** (`src/pages/RecordingDetailPage.tsx`, new)
- Header: recording name, started, duration, one-line stats (tools/api/tokens)
- Event log: vertical list with left rail time column, icon, type label, name/target, tokens, right arrow ▸ to expand
- Subagent events render as a visual section (nested gradient border + indented tool rows underneath)
- Back button → `/` (recordings list)

**L4.2 — Expandable tool call details**
- Component: `src/components/ToolCallRow.tsx`
- Collapsed: one row (icon + name + target + tokens)
- Expanded: inputs (path/pattern/command) + outputs (first 500 chars, scrollable for more)
- Redaction: secrets detected in inputs/outputs replaced with `<redacted>`

**L4.3 — Lifecycle events hidden by default**
- Chip "Show internal events" in filter row; when off: hide `bridge_status`, `command_permissions`, `mcp_instructions_delta`, `deferred_tools_delta`, `stop_hook_summary`, `auto_mode`, `turn_duration`, `file-history-snapshot`, `permission-mode`, `away_summary`, `last-prompt`, `queue-operation`, `task_reminder`
- When on: show all events

**L4.4 — Scroll fix** (inherit from v0.2.1 L16)
- Outer container: `height: 100dvh; overflow: hidden`
- Timeline: `flex: 1; overflow: auto`

**L4.5 — Subagent surfacing**
- Subagent span renders as collapsible group
- Children = the subagent's own tool calls, indented, same row style
- Subagent's agentId and description visible in group header

### L5 — Import pipeline fixes

**L5.1 — Within-file yielding** (L10 residual from v0.2.1)
- File: `server/pipeline/import.ts` (modify)
- Inside `precomputeTokens()` and `persistSession()` loops, `await new Promise(r => setImmediate(r))` every 50 events
- Test: import a 5000-event JSONL, assert healthz still responds <200ms during import

**L5.2 — Session scope enforcement**
- Recording's events query must filter by `session_id = recording.session_id AND ts BETWEEN recording.start_ts AND recording.end_ts`
- Test: two concurrent JSONLs written, only /peek_start'd one → recording events only contain that session

**L5.3 — First-prompt cleanup (v0.2.1 L12 extended)**
- Strip `<command-*>` XML
- Skip SKILL body markdown (text starting with `# /peek_` is the skill definition, not a user prompt)
- Use next non-command user_prompt as firstPrompt for the *session* (not used for recording, but still matters for legacy session list)

### L6 — README + ship gate

**L6.1 — README rewrite**
- File: `README.md` (modify)
- Required sections per spec §README requirements:
  1. Hero one-liner + "Peek only shows what you record"
  2. Install (30 sec): `npx peek install && peek`
  3. The `/peek_start NAME` → `/peek_end` lifecycle (with one-at-a-time auto-close explained)
  4. Text marker fallback (`@peek-start`, `@peek-end`) as backup
  5. What a recording captures vs doesn't
  6. Privacy / local-only / 127.0.0.1-bind
  7. Troubleshooting: daemon not running, port conflict

**L6.2 — Manual mental-model walkthrough (builder must run itself)**
- Start daemon (bare `peek`)
- Verify localhost:7335 loads, empty state shows correct hint
- Spawn `claude -p` (if API key / Max auth available) with: `/peek_start builder-self-test`, a small prompt, `/peek_end`
- Verify recording appears in UI with the correct name, stats, tool calls
- Kill daemon

**L6.3 — Full test suite green**
- `npm run build`
- `npm run test:unit && npm run test:integration`
- All green (excluding pre-existing e2e/phase*.spec.ts Playwright-under-vitest misconfig)

**L6.4 — Ship signal**
- Write `.peek-v03/shared/BUILDER-COMPLETE` with final SHA + timestamp
- Stop scheduling wakeup

---

## What NOT to do in this builder loop

- Do not touch the main `launch-v0.2` branch or main worktree
- Do not rewrite the import pipeline beyond L5 fixes
- Do not remove legacy `SessionsPage` — keep at `/sessions` route for users who ran `peek import` against old history
- Do not change server port default (7335 stays)
- Do not introduce new npm deps
- Do not push to git remote, do not tag

---

## Required skills reminder (load every tick)

- superpowers:test-driven-development
- superpowers:verification-before-completion
- superpowers:systematic-debugging
- frontend-design:frontend-design (for L3, L4)
