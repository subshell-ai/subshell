# Testing

## Commands

```bash
turbo test                 # Run tests across all packages
```

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
