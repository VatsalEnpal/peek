#!/usr/bin/env bash
# Deny Edit/Write on protected paths:
#   - tests/acceptance/** (Karpathy tests immutable during /loop)
#   - docs/superpowers/specs/** (spec locked)
#   - .env* (secrets)
#   - .git/** (repo state)
#   - package-lock.json (lockfile)
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$FILE" ] && exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
REL="${FILE#$PROJECT_DIR/}"

block() {
  echo "{\"block\": true, \"message\": \"BLOCKED: $1\"}" >&2
  exit 2
}

case "$REL" in
  tests/acceptance/*|*/tests/acceptance/*)
    block "tests/acceptance/** is IMMUTABLE (Karpathy acceptance tests). Any regression halts the entire run — you cannot edit them under pressure."
    ;;
  tests/fixtures/expected-counts.json|*/tests/fixtures/expected-counts.json|tests/fixtures/session-with-secrets.jsonl|*/tests/fixtures/session-with-secrets.jsonl|tests/fixtures/isolated-claude-projects/*|*/tests/fixtures/isolated-claude-projects/*)
    block "test fixtures are IMMUTABLE ground truth. Changing them invalidates the Karpathy baseline."
    ;;
  docs/superpowers/specs/*|*/docs/superpowers/specs/*)
    block "spec is LOCKED. Update the plan or raise an issue if spec change is truly needed."
    ;;
  .env*|*.env|*.env.*|.envrc|*/.env|*/.env.*)
    block "refusing to edit .env files"
    ;;
  .git/*|.git|*/.git/*|*/.git)
    block "refusing to edit .git/"
    ;;
  package-lock.json|*/package-lock.json)
    block "lockfile changes should come from npm ci/install, not direct edit"
    ;;
esac

exit 0
