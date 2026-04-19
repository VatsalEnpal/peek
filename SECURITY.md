# Security Policy

## Reporting

Report vulnerabilities via **GitHub's private security advisory flow** at https://github.com/VatsalEnpal/peek-trace/security/advisories/new.

**Do not** file public issues for vulnerabilities.

## Threat model — what Peek defends against

Peek captures Claude Code session transcripts, which commonly contain:

- API keys (Anthropic, OpenAI, AWS, etc.)
- Database credentials
- Personal information from tool outputs
- Proprietary code

**Peek is a local-first tool.** Data stays on your disk. We do not upload, telemeter, or analyze your sessions.

### Controls in v0.1

1. **Capture-time redaction (ON by default).** Detected secrets replaced with `<secret:hash>` at import. Our database never holds plaintext.
2. **Deterministic session-salted hashing.** Same secret → same hash within a session → correlation possible, cross-session recovery is not.
3. **Source files are never modified.** Peek reads `~/.claude/projects/` — never writes back.
4. **Unmask via `sourceOffset` pointers.** To show plaintext, we re-read the user's own JSONL in memory. If source moved, unmask is impossible.
5. **`sourceLineHash` TOCTOU defense.** Source-file-bytes must match import-time hash or unmask refuses.
6. **Local only.** No network calls. No telemetry.

## Residual risks openly documented

| Attack                                                  | Works in v0.1?                  | Mitigation                                             |
| ------------------------------------------------------- | ------------------------------- | ------------------------------------------------------ |
| Homoglyph evasion of regex (U+2010 vs U+002D)           | Yes                             | v0.2 adds NFKD normalization                           |
| Secrets in PNG/PDF tool outputs                         | Yes                             | v0.3 optional OCR pass                                 |
| Secret split across two content blocks                  | Yes                             | v0.2 sliding-window join                               |
| `sourceOffset` as secret-locator (if store.db leaked)   | Partial                         | FS perms are the boundary; v0.2 encrypts salts at rest |
| Browser extension reads unmasked DOM                    | Yes                             | Cannot mitigate; warn in docs                          |
| Deterministic-hash recovery with leaked DB + screenshot | Yes (requires local compromise) | v0.2 encrypts salts                                    |

See the full design spec and residual-attack table for details.

## Scope

In scope: RCE, path traversal, information disclosure from the peek process itself, redaction bypass that leads to plaintext persistence in our database.

Out of scope: attacks that require pre-existing local access to the user's machine (the FS perms ARE the boundary); vulnerabilities in upstream packages (report to them directly); issues in Claude Code itself (report to Anthropic).
