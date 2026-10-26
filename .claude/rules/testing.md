# Testing

Read [docs/testing.md](../../docs/testing.md) for the shared policy and commands.

## Test value

Add a test when it can catch a plausible regression in behavior we own. Name
that failure before writing the test. Prefer an existing suite at the narrowest
boundary that observes the result. Authorization, privacy, destructive actions,
migrations, protocol compatibility, and asynchronous ordering deserve focused
coverage, including the relevant refusal path.

Do not require a test per function, component, hook, or file. Do not add tests
for types already checked by TypeScript, copied implementation logic, fixed
copy, CSS classes, trivial prop forwarding, or third-party behavior. Review
layout in a browser. Keep accessibility and interaction tests where they verify
our behavior. When one test already catches the regression, another layer needs
a distinct failure to justify its setup and maintenance cost.

For a bug fix, reproduce the failure at the appropriate boundary when practical.
Prefer adding a case to an existing suite over creating a new file and preload.
Do not increase test count or coverage percentages as an end in itself.

Reuse existing boundary coverage. The API's composed-route authorization suite
already rejects anonymous and node-key requests on every guarded route; don't
repeat a bare 401 case in each route file. Keep separate tests for permission
scopes, ownership, conditional authentication, body-dependent behavior, and
refused writes leaving state unchanged.

Drive polling through a controlled scheduler or clock when elapsed wall time
isn't the behavior under test. Make successful fakes supply the response the
real operation waits for, rather than silently exercising its timeout fallback.
Keep real deadline/process tests when they verify cancellation or termination.

## Running tests

While editing, run the covering files from their package directory. Before
handoff, inspect `bun run test:changed -- --plan`, then run the affected checks
once. Use package `test` scripts for suite runs; they own parallelism and cleanup.
Use `env -u SHELLOPTS -u BASHOPTS` in automation shells, capture the output once,
and inspect failures from that capture. Confirm the expected file count ran.

Bun's `--parallel` isolates each file. DB suites migrate their own database;
runner-wide cleanup belongs in the package runner, not preload `afterAll`.
`SUBSHELL_TEST_PARALLEL` overrides local width. CI keeps serial package execution
while routing packages across at most three jobs. Tests in release verification
run without retries; a flaky failure needs fixing, not a green retry.

## Server-backed search coverage

Test the HTTP boundary, not just the matching helper: maximum and over-limit
lengths (including Unicode), invalid enum/format values, literal SQL/regex-like
text, and private records or nested members that must remain undiscoverable.
Use the composed-route suite for anonymous rejection. Retain filter-specific
scoped-bearer and visibility checks, including private results staying hidden.

UI tests should verify debounced requests, immediate select/clear actions,
stale-response isolation, and a failed search recovering through Retry without
showing “no matches.” Wait for the completed result state: rows can disappear
while a request is loading, so their absence alone does not prove an empty
result has arrived. Route-validation tests should mount the production error
handler so they assert the API's actual error status and body.

## After Making Code Changes

After any code change, check if tests need updating due to changed behavior (e.g., different error types, response formats, new error conditions). Run the checks affected by that behavior; see `verification.md`.
