#!/usr/bin/env bash
# TypeScript type-check scoped to changed TS files. No-op if deps not installed.
# During SHIPLOOP_ACTIVE=1 runs this is silenced — verifier subagent owns the gate.
[ "$SHIPLOOP_ACTIVE" = "1" ] && exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
[ ! -d "$PROJECT_DIR/node_modules/typescript" ] && exit 0

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$FILE" ] && exit 0

case "$FILE" in
  *.ts|*.tsx)
    cd "$PROJECT_DIR" 2>/dev/null
    # Run a full tsc --noEmit but only surface errors for the changed file
    OUTPUT=$(npx tsc --noEmit 2>&1)
    if [ $? -ne 0 ]; then
      # Filter to only errors in the changed file
      FILE_ERRORS=$(echo "$OUTPUT" | grep -F "$FILE" | head -5)
      if [ -n "$FILE_ERRORS" ]; then
        echo "TypeScript errors in $FILE:" >&2
        echo "$FILE_ERRORS" >&2
      fi
    fi
    ;;
esac

exit 0
