#!/usr/bin/env bash
# Block destructive commands + duplicate dev-server spawns + force-pushes.
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$CMD" ] && exit 0

# Destructive git
if echo "$CMD" | grep -qE 'git\s+push\s+(-f|--force)'; then
  echo '{"block": true, "message": "BLOCKED: force push not allowed"}' >&2
  exit 2
fi
if echo "$CMD" | grep -qE 'git\s+reset\s+--hard'; then
  echo '{"block": true, "message": "BLOCKED: git reset --hard destroys work"}' >&2
  exit 2
fi
if echo "$CMD" | grep -qE 'git\s+push.*\bmain\b'; then
  echo '{"block": true, "message": "BLOCKED: never push directly to main. Use a feature branch + PR."}' >&2
  exit 2
fi

# Destructive FS
if echo "$CMD" | grep -qE 'rm\s+-rf\s+/($|\s)'; then
  echo '{"block": true, "message": "BLOCKED: rm -rf / forbidden"}' >&2
  exit 2
fi
if echo "$CMD" | grep -qE 'rm\s+-rf\s+\.\s*$'; then
  echo '{"block": true, "message": "BLOCKED: rm -rf . would wipe the project"}' >&2
  exit 2
fi

# SQL destructive
if echo "$CMD" | grep -qiE 'DROP\s+(TABLE|DATABASE|SCHEMA)' || echo "$CMD" | grep -qiE 'TRUNCATE\s'; then
  echo '{"block": true, "message": "BLOCKED: DROP/TRUNCATE needs explicit approval"}' >&2
  exit 2
fi

# Single-server discipline: block duplicate dev-server spawns on :7334 (peek)
if echo "$CMD" | grep -qE '^\s*(npm|yarn|pnpm|bun)(\s+run)?\s+(dev|start|serve)' \
   || echo "$CMD" | grep -qE '^\s*(npx\s+)?(vite|peek)(\s+dev|\s+serve)?(\s|$)'; then
  if lsof -ti:7334 >/dev/null 2>&1; then
    PID=$(lsof -ti:7334 | head -1)
    echo "{\"block\": true, \"message\": \"BLOCKED: peek already on :7334 (pid $PID). Reuse or kill first.\"}" >&2
    exit 2
  fi
fi

# TypeScript typecheck before commit — skip during SHIPLOOP run
if echo "$CMD" | grep -qE '^\s*git\s+commit' \
   && [ "$SHIPLOOP_ACTIVE" != "1" ] \
   && [ ! -f "${CLAUDE_PROJECT_DIR}/.peek-build/state.json" ] \
   && [ -d "${CLAUDE_PROJECT_DIR}/node_modules" ]; then
  cd "$CLAUDE_PROJECT_DIR" 2>/dev/null
  TSC=$(npx tsc --noEmit 2>&1)
  if [ $? -ne 0 ]; then
    CNT=$(echo "$TSC" | grep -c "error TS")
    echo "BLOCKED: $CNT TypeScript errors. Fix before committing." >&2
    echo "$TSC" | grep "error TS" | head -5 >&2
    exit 2
  fi
fi

exit 0
