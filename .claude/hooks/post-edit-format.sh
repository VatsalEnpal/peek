#!/usr/bin/env bash
# Format edited TS/TSX/JS/JSON files with prettier. No-op if deps not installed yet.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
[ ! -d "$PROJECT_DIR/node_modules/prettier" ] && exit 0

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$FILE" ] && exit 0

case "$FILE" in
  *.ts|*.tsx|*.js|*.jsx|*.json|*.md)
    cd "$PROJECT_DIR" 2>/dev/null
    npx prettier --write "$FILE" 2>/dev/null || true
    ;;
esac

exit 0
