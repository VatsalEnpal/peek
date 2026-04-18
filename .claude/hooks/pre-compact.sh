#!/usr/bin/env bash
# PreCompact — snapshot state.json before CC compacts our context.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
mkdir -p "$PROJECT_DIR/.peek-build/snapshots"

if [ -f "$PROJECT_DIR/.peek-build/state.json" ]; then
  SNAP="$PROJECT_DIR/.peek-build/snapshots/state-$(date -u +%FT%TZ | tr ':' '-').json"
  cp "$PROJECT_DIR/.peek-build/state.json" "$SNAP"
  echo "$(date -u +%FT%TZ) pre-compact snapshot → $SNAP" >> "$PROJECT_DIR/.peek-build/log.txt"
fi

exit 0
