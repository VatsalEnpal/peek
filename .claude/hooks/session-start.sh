#!/usr/bin/env bash
# Re-inject build state after compaction/clear/startup.
set -e
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$PROJECT_DIR" 2>/dev/null || exit 0

echo "=== Peek build session ==="
echo "Repo: $PROJECT_DIR"
echo "Branch: $(git branch --show-current 2>/dev/null || echo 'none')"
echo ""

# ShipLoop state
if [ -f "$PROJECT_DIR/.peek-build/state.json" ]; then
  echo "=== ShipLoop state ==="
  cat "$PROJECT_DIR/.peek-build/state.json"
  echo ""
fi

# Recent log tail
if [ -f "$PROJECT_DIR/.peek-build/log.txt" ]; then
  echo "=== Recent log (last 5 lines) ==="
  tail -5 "$PROJECT_DIR/.peek-build/log.txt"
  echo ""
fi

# Dev server status
if lsof -ti:7334 >/dev/null 2>&1; then
  echo "Peek dev server: RUNNING on :7334 (pid $(lsof -ti:7334 | head -1))"
else
  echo "Peek dev server: NOT running"
fi

# Acceptance test status
if [ -d "$PROJECT_DIR/tests/acceptance" ] && [ -d "$PROJECT_DIR/node_modules" ]; then
  echo ""
  echo "=== Karpathy acceptance tests (tests/acceptance/**) are IMMUTABLE ==="
  echo "Regressions halt the entire run. Protected by protect-files.sh."
fi

echo ""
echo "Reminders: verifier is ALWAYS a separate subagent. Scoped context packs per task. depth-1 only."
