---
name: peek_start
description: Start a Peek bookmark range in the current session
user-invocable: true
allowed-tools:
  - Bash
---

# /peek_start — Open a Peek bookmark range

Marks the start of a bookmark range in the Peek trace viewer. The range is
closed later by `/peek_end`. Everything you and the assistant do between the
two markers will be grouped into one bookmark on the Peek timeline.

Argument: `$ARGUMENTS` — the bookmark name (optional, but recommended).

## What to do

1. Run this single Bash command exactly once. The port defaults to 7335 but
   honors `$PEEK_PORT` if set in the environment. The timestamp is captured
   as UTC in ISO-8601. JSON encoding happens inside `python3` so a bookmark
   name containing `"`, `$`, or any other shell-hostile character is treated
   as a plain string (no shell/JSON injection).

   ```bash
   BODY="$(python3 -c 'import json,sys; print(json.dumps({"type":"start","name":sys.argv[1],"timestamp":sys.argv[2]}))' "$ARGUMENTS" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
   curl -sf -X POST "http://127.0.0.1:${PEEK_PORT:-7335}/api/markers" \
     -H 'Content-Type: application/json' \
     --data-raw "$BODY"
   ```

2. Read the command's exit code:
   - **Exit 0 (success):** print exactly one line to the user:
     `peek: bookmark "NAME" started`  (substitute the actual `$ARGUMENTS` value
     for `NAME`; if `$ARGUMENTS` is empty, print `peek: bookmark started`).
   - **Non-zero exit (curl error, e.g. daemon unreachable):** print exactly
     one line:
     `peek: daemon not running — start with "peek"`

3. Output nothing else. No pre-amble, no post-amble. This is a slash command
   for the user — they want a single confirmation line, not a report.
