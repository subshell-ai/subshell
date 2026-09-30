# Testing

## Commands

```bash
turbo test                 # Run tests across all packages
```

Each package's `test` script passes `--parallel=N` (issue #261): test files
run in worker processes and **every file gets a fresh module registry** - a
fresh `db` singleton with its own database file. Two consequences for suite
authors: a suite that touches the DB must migrate it itself (server/api:
`@/__tests__/helpers/test-database.js`) and may assume neither an empty DB
nor a sibling file's boot; and runner-wide cleanup cannot live in a preload
`afterAll` (those fire per file under `--parallel`), it belongs in the
package's `test` script. A bare `bun test` still runs serially - bun ignores
a `parallel` key in `bunfig.toml [test]` (measured on 1.4.0 and 1.4.2), so
the flag lives in the scripts only.

## Guidelines

**Always write tests for new features.** Every new service, repository, route, or significant function should have corresponding tests. Tests should cover:

- Happy path (expected behavior)
- Edge cases (empty inputs, null values, boundaries)
- Error conditions (invalid inputs, not found cases)

Test files live in `__tests__/` directories alongside the code they test:
```
src/services/
├── logs.service.ts
└── __tests__/
    └── logs.service.test.ts

src/db/repositories/
├── logs.repository.ts
└── __tests__/
    └── logs.repository.test.ts
```

When fixing bugs, add a test that reproduces the bug before fixing it to prevent regressions.

## After Making Code Changes

After any code change, check if tests need updating due to changed behavior (e.g., different error types, response formats, new error conditions). Then run full verification - see `verification.md`.
