---
name: peek_end
description: Close the current Peek bookmark range in this session
user-invocable: true
allowed-tools:
  - Bash
---

# /peek_end — Close the current Peek bookmark range

Closes the most recently opened bookmark range started by `/peek_start`. If
no range is open, Peek records an "orphan end" pin at the current timestamp.

Takes no arguments.

## What to do

1. Run this single Bash command exactly once. The port defaults to 7335 but
   honors `$PEEK_PORT` if set. The timestamp is captured as UTC in ISO-8601.
   The body is encoded via `python3` for symmetry with `/peek_start` — this
   command takes no arguments today, but the defensive shape protects
   against any future additions that might embed user input.

   ```bash
   BODY="$(python3 -c 'import json,sys; print(json.dumps({"type":"end","timestamp":sys.argv[1]}))' "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
   curl -sf -X POST "http://127.0.0.1:${PEEK_PORT:-7335}/api/markers" \
     -H 'Content-Type: application/json' \
     --data-raw "$BODY"
   ```

2. Read the command's exit code:
   - **Exit 0 (success):** print exactly one line:
     `peek: bookmark closed`
   - **Non-zero exit (curl error, e.g. daemon unreachable):** print exactly
     one line:
     `peek: daemon not running — start with "peek"`

3. Output nothing else. One-line confirmation only.
