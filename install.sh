#!/usr/bin/env bash
# peek-trace bootstrap. Idempotent — safe to re-run.

set -e
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

echo "━━━ Peek Bootstrap ━━━"
echo "Repo: $REPO_DIR"
echo ""

# Prereqs
echo "→ Checking prerequisites…"
MISSING=""
for tool in node npm git; do
  command -v "$tool" >/dev/null 2>&1 || MISSING="$MISSING $tool"
done
if [ -n "$MISSING" ]; then
  echo "✗ Missing tools:$MISSING"
  exit 1
fi

NODE_MAJOR=$(node -v | sed -E 's/v([0-9]+).*/\1/')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "✗ Node $NODE_MAJOR detected. Peek needs 22+."
  echo "  nvm install 22 && nvm use 22"
  exit 1
fi
echo "  ✓ node $(node -v), npm $(npm -v), git"

# Platform detection
OS="$(uname)"
case "$OS" in
  Darwin) echo "  ✓ macOS" ;;
  Linux)
    if grep -qi microsoft /proc/version 2>/dev/null; then
      echo "  ✓ WSL2 (supported with caveats — see README)"
    else
      echo "  ✓ Linux"
    fi
    ;;
  *)
    echo "✗ Unsupported platform: $OS. Use macOS, Linux, or WSL2."
    exit 1
    ;;
esac

# Install deps
echo ""
echo "→ Installing npm dependencies…"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

# Port check
echo ""
if lsof -ti:7334 >/dev/null 2>&1; then
  echo "⚠ Port 7334 in use. Free it or use PEEK_PORT=<n>: lsof -ti:7334 | xargs kill"
fi

echo ""
echo "━━━ Ready ━━━"
echo ""
echo "Start:  npm run dev          # dev server at http://localhost:7334"
echo "Test:   npm test             # all tests"
echo "CLI:    npx peek --help"
echo ""
