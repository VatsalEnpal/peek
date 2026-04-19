# Contributing to Peek

Thank you for your interest in contributing.

## Quick start

```bash
git clone https://github.com/VatsalEnpal/peek.git
cd peek-trace
./install.sh     # validates Node 22+, npm ci, platform checks
npm test         # run all tests
npm run dev      # start dev server at http://localhost:7334
```

## Running tests

```bash
npm test                   # all
npm run test:acceptance    # the 5 load-bearing tests (must always pass)
npm run test:unit          # unit tests
npm run test:integration   # Playwright, requires dev server running
```

## Philosophy

- **Nothing fake.** Every token count, every tool call, every file loaded must come from the JSONL the user's Claude Code actually wrote. No estimates, no inferences. If the data isn't available, show "unavailable" — never a plausible guess.
- **Input tokens are the primary number.** Not cost, not latency. Peek helps users understand their context window usage.
- **Minimalism with progressive disclosure.** The first view shows the least. Details appear on click. Four levels deep: session list → session view → turn view → span view.

## PR format

- Branch off `main`.
- Commit prefix: `feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `chore:`.
- Keep PRs focused — one feature or fix per PR.
- Include a test for any behavior change.

## Adding a secretlint rule

See `packages/secretlint-rule-anthropic/` for our rule package template. New rules PR'd upstream to `@secretlint/secretlint` when possible; local rules live in `packages/` until merged.

## Code of conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
