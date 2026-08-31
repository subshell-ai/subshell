@AGENTS.md

## Claude Code specifics

The import above pulls in `AGENTS.md`, which is the single source of truth. Keep
project documentation there, not here — this file exists only because Claude Code
reads `CLAUDE.md` rather than `AGENTS.md`, and other coding agents read
`AGENTS.md` directly.

**Per-app documentation loads on demand.** `apps/backend/CLAUDE.md` and
`apps/frontend/CLAUDE.md` import their own `AGENTS.md`, but nested files only
enter context once you read a file in that directory. If you are planning work in
an app before opening any of its files, read that app's `AGENTS.md` first.

**`.claude/rules/` also loads automatically**, covering code style, testing,
verification, dependencies, and the security posture. Where a rule and an app's
`AGENTS.md` disagree, the app's documentation is more specific and wins — and the
disagreement is a bug worth fixing rather than a choice to make silently.
