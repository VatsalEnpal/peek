#!/usr/bin/env bash
# SubagentStop — append raw payload to build log. Coordinator canonicalizes results on next tick.
# Robust: doesn't rely on a task_id field in the payload (CC doesn't emit it reliably).
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
mkdir -p "$PROJECT_DIR/.peek-build/subagent-events"

TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$PROJECT_DIR/.peek-build/subagent-events/${TS}-${RANDOM}.json"

# Raw payload dump — coordinator reads all events under subagent-events/ next tick
cat > "$OUT"
echo "$(date -u +%FT%TZ) subagent-stop event → $OUT" >> "$PROJECT_DIR/.peek-build/log.txt"

exit 0
