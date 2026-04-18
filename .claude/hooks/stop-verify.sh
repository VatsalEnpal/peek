#!/usr/bin/env bash
# Stop — no-op during SHIPLOOP (verifier subagent owns gates).
# Otherwise run full typecheck + build + test gates.
INPUT=$(cat)

STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null)
[ "$STOP_ACTIVE" = "true" ] && exit 0

# During ShipLoop autonomous run, per-task commits shouldn't be blocked by Stop-level gates.
if [ "$SHIPLOOP_ACTIVE" = "1" ] || [ -f "${CLAUDE_PROJECT_DIR:-$(pwd)}/.peek-build/state.json" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$PROJECT_DIR" 2>/dev/null || exit 0

# Only gate if source files were modified
CHANGED=$(git diff --name-only HEAD 2>/dev/null | grep -E '\.(ts|tsx|js|jsx)$' | head -1)
UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null | grep -E '\.(ts|tsx|js|jsx)$' | head -1)
[ -z "$CHANGED" ] && [ -z "$UNTRACKED" ] && exit 0

[ ! -d "$PROJECT_DIR/node_modules" ] && exit 0

ERRORS=""
TSC=$(npx tsc --noEmit 2>&1)
if [ $? -ne 0 ]; then
  ERRORS="${ERRORS}[TYPECHECK] errors\n"
  ERRORS="${ERRORS}$(echo "$TSC" | grep 'error TS' | head -3)\n\n"
fi

if [ -f "node_modules/.bin/vitest" ]; then
  TEST=$(npx vitest run --reporter=dot tests/unit 2>&1)
  if [ $? -ne 0 ]; then
    ERRORS="${ERRORS}[UNIT TESTS] failed\n"
    ERRORS="${ERRORS}$(echo "$TEST" | grep FAIL | head -3)\n\n"
  fi
fi

if [ -n "$ERRORS" ]; then
  echo "{\"decision\": \"block\", \"reason\": \"Gates failed:\\n${ERRORS}\"}"
  exit 0
fi

exit 0
