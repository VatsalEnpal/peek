#!/usr/bin/env node
// Stub — implemented in Group 7. Just prints help for now.
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  console.log(`peek — local trace viewer for Claude Code sessions

Usage: peek <command> [options]

Commands:
  serve          Start the local viewer at http://localhost:7334
  import <path>  Import JSONL session(s) from path
  verify <json>  Verify imported tokens against expected-counts.json
  bookmarks list List recorded / focused bookmarks
  --version      Print version
  --help         Show this help

NOTE: This is the scaffold. Full CLI is implemented in Group 7 of the build.
`);
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  const pkg = require('../package.json');
  console.log(pkg.version);
  process.exit(0);
}

console.log('peek: command not yet implemented. Run `peek --help` for the scaffold list.');
process.exit(0);
