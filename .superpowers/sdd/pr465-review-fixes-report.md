# PR 465 review fix wave

Worktree: `/tmp/subshell-pr465-review`, branch `review/pr465-security`, starting head `188b9782708a80c8d2d57ecfb42df3118bb4a274`. No pushes, GitHub comments, or changes to the original shared checkout. Root owns final independent review and push.

## Findings and dispositions

- **4397822385 / CodeQL19, response-transform.ts**: added `scriptString`, which JSON-quotes injected module addresses/base literals and escapes HTML angle brackets before they enter generated JavaScript. Static and computed imports use it. Regression feeds a closing-script payload through the mapper and checks that no literal closing tag survives. The generated expression still deliberately preserves the app's original import argument; app code executes inside the existing preview sandbox. CodeQL must reanalyse the new commit before the remote alert can be called fixed. CodeQL18 was already FIXED at the starting revision per root's audit; no weakening of its HTML-parser test.
- **4398892109 / proxy Location**: when absolute redirect mapping is disabled, still apply the existing root-relative `rewriteLocation` boundary. Added real HTTP-lane coverage with rewriting disabled; existing absolute redirect behavior stays covered.
- **4398892129 / lexer errors**: catch parse failures alone and return the original module. Transform/expansion errors remain errors. Added malformed-JavaScript regression.
- **4398892148 / transform concurrency**: replaced the eight-active-response gate with a process-wide 128 MiB decoded-input byte budget, retaining the 16 MiB per-resource and expansion limits. Charge each decoded chunk while it is retained, release in `finally` on success/error/cancellation. Twenty slow small responses can now coexist. Tests cover that burst, aggregate exhaustion, cancellation, and recovery. Simply moving the old counter after buffering would have removed the aggregate memory defense; that suggestion was not adopted.
- **4398892161 / settings schemas**: named request/settings schemas, descriptions, and 200/400/401/403/404/409 response map. Documented the saved service target's host explicitly.
- **4398892183 / pipe strikes**: quiet intervals preserve accumulated evidence; only log progress clears strikes. Added intermittent-output regression.
- **4398892201 / false re-arm journal**: emit the success message after `pipePane` succeeds. Stubbed successful calls in the previous test (its unimplemented fake threw) and added an explicit throwing-call regression with no success journal.
- **4398892215 / truncated refusal tail**: decode only `readSync`'s returned byte count. Existing display-provider tests/types pass. No artificial syscall mock test for this direct bounded-read fix.
- **4398892233 / reconnect replay base**: clear established grid/output counter at each connect attempt. Added a reconnect-open-before-replay regression with a resize tick.
- **4398892250 / fish setup command**: **not adopted**. The premise is outdated: official fish 3.1 FAQ says `VAR=value command` is supported since fish 3.1: https://fishshell.com/docs/3.1/faq.html. Prefixing `env` would temporarily expose the secret in the `env` process argv and undo credential hardening. Original shell environment assignment remains unchanged.
- **4398892264 / node settings link**: both note and link now use the same full reason aggregation, including individual web/display flags. Added cases with undefined/unsupported-port reasons and a disabled feature.
- **4398892281 / retained quit dialog**: clear transient confirmation on document hide and on an explicit native `subshellPanelShown` callback on reopening. AppKit retains the document and WebKit visibility alone is not sufficient evidence of reopening. Added lifecycle regression.
- **4398892295 / helper lifecycle coverage**: added pinned existing workspace `@happy-dom/global-registrator` dev dependency, preload preserving Bun's native Response, and DOM tests for state pushes, focus retention, Tab/Escape, native reopen, quit bridge messages, and finite resize dimensions. Added plugin `generateBundle` regression checking inlining and asset deletion. Copy sweep now understands TOML and distinguishes test-runner preload references from shipped code imports.
- **4398892310 / assistant parity**: test intro paragraph, full trust warning, and host/client subtitle in addition to existing steps/note coverage.
- **4398892337 / palette imports**: design checker now validates real shared import resolution before crediting palette declarations, including helper-panel. Added filesystem fixture tests that remove the server/helper imports and override a shared role through the real `allAgreement` pipeline. Shared redeclaration enforcement stays enabled. This also exposed and corrected `MOBILE_COLOR_MAP`'s pre-existing too-narrow type for optional `scrim`, once the client parity test imported the shared role list.

Non-inline findings:

- **views-open.route.ts loopback claim**: preserved the intentional arbitrary saved-service destination policy. The numeric port branch is loopback; saved serviceId explicitly uses its stored host/protocol. Verified `services.route.ts` save/remove and forward-open require edit authority through `gatePreview`, saved IDs are pane-scoped, and proxy request credential stripping remains in place. `docs/security.md` already described private-network reach; it now explicitly includes link-local reach. The Host field explains this at the decision point and asks the editor to trust other people with edit access. Confining all saved hosts would break the deliberately shipped external-service feature and would not remove shell-equivalent editors' network authority.
- **new-workspace Cancel skips reset**: reset on Cancel and both child leave paths, matching X/Escape's existing reset. Added retained-instance selection-reset regression.
- **Runtime.swift lost capture strands pointer**: invoke guarded `restoreStrandedCursor()` on lost capture before error/close.
- **display_helper.rs stale PID staging directory**: reserve per-attempt timestamp/attempt-suffixed directories with exclusive `create_dir`, skipping collisions; never overwrite recovery copies. Named errors point at the Applications directory/remedy. Rust test preserves an old PID-only recovery file while two subsequent staging attempts succeed.
- **desktop stylesheet comments**: removed copied-palette/orphan scrim claims and pointed to the imported shared token file.

Summary-only input-budget concern: **no protocol change**. Process-wide exhaustion deliberately closes the requesting socket with retryable 1013; it does not identify that socket as malicious. Callers return without ack on refusal, allowing reliable-input clients to resend after reconnect while already dispatched work remains charged. Silently returning without closing would strand client retries, and accepting/queuing would bypass the global bound. Older unsequenced input has no lossless retry guarantee; that is not safely repaired by changing this admission helper. Existing input budget tests already cover process exhaustion and retained in-flight work. The shared overload outcome is a residual availability tradeoff, not incorrect offender attribution.

Non-blocking nits:

- Keep the same open quit-dialog element/focus across pushes; update body text without refocusing Cancel. DOM test verifies node/focus identity.
- Add all-permissions-granted state wording and coverage.
- Initialize diagnostics visibility lazily from the persisted preference.
- Move preview settings DB row to documented `preview-proxy-settings.db-types.ts`; protocol is `http | https` throughout target and row types.
- Settings gate uses `recheckPreviewOpen(..., "any")`, retaining account/pane/running checks and permitting display-only nodes. Test still refuses when both features are off.
- Import `COLOR_ROLES` in the client parity test rather than restating it.
- Correct main.swift comments to describe the warnings-as-errors full-source typecheck.
- Move two exploratory mobile captures and unused workspace capture outside published screenshot inventory. Remove three orphan PNGs; this fixes docs CI.
- Remove unused `readSurfaceCss` export.

## CI fixes and screenshot

Docs failure was exact screenshot inventory mismatch caused by three unreferenced PNGs. They are removed and capture scripts no longer recreate them in the published directory.

Connect-flow login inherited the shared origin's cookie (ports do not scope cookies), allowing `/login` to redirect before `#email` existed. Clear the browser context's cookies before logging into the isolated instance. All five connect-flow scenarios pass.

Mobile scroll's original wait matched tty command echo, allowing late shell output to change the captured bottom anchor. It now runs sequence and printf in one command and waits for an executed standalone sentinel line. The exact CI timing was not reproduced locally; both targeted proper-setup runs passed, including the final tightened fixture. No product scrolling behavior was changed. An initial selected run omitted `01-setup-wizard` and failed because admin storage state was missing; a repeat-each experiment was stopped because setup is intentionally once per shared stack. Those invocations are not validation successes.

Actual screenshot command from repo root:

`E2E_PORT_BACKEND=3319 E2E_PORT_FAKE_REGISTRY=3318 E2E_PORT_FAKE_IDP=3317 bun e2e/capture-preview-intro.ts`

Reused the existing website responding on :3401; did not stop or replace it. Capture creates an actual demo subshell in `$HOME/Projects/website`, uses the real service proxy and checks loaded styling/image before screenshot. Result was visually inspected by this agent and root: loaded website, readable controls, `/home/theo/Projects/website`, no scratch checkout path. No image editing. Picker/settings captures were regenerated too but byte-identical; only hero PNG changed.

## Validation

Successful final or covering checks:

- `bun run --cwd apps/docs test`: 184 pass, 0 fail (final).
- `bun run --cwd packages/helper-panel test`: 48 pass, 0 fail (final).
- `bun run --cwd packages/helper-panel build`: successful single-file Vite build.
- `bun test src/modules/previews/__tests__/response-transform.test.ts` from server/api: 14 pass, 0 fail (final, includes aggregate budget).
- `bun test src/modules/previews/__tests__/pv-proxy.test.ts` from server/api: 22 pass, 0 fail.
- `bun test src/api/subshells/__tests__/preview-routes-auth.test.ts` from server/api: 61 pass, 0 fail.
- `bun run --cwd apps/node/agent test -- src/__tests__/commands-launch.test.ts`: 42 pass, 0 fail.
- `bun run --cwd apps/server/web test -- src/lib/__tests__/use-subshell-ws-resync.test.ts`: 14 pass, 0 fail.
- `bun run --cwd apps/server/web test -- src/components/preview/__tests__/preview-section.test.tsx`: 24 pass, 0 fail.
- `bun run --cwd apps/server/web test -- src/components/sidebar/__tests__/new-workspace-dialog.test.tsx`: 11 pass, 0 fail.
- `bun run --cwd apps/server/desktop test`: 460 pass, 0 fail (includes expanded parity test).
- `bun run --cwd apps/client/desktop test -- src/__tests__/tokens-match-spa.test.ts`: client root tests and 6 focused UI tests pass after correcting intermediate import/name errors.
- `bun run --cwd packages/pane-runtime test -- src/preview/display-provider.test.ts`: 8 pass, 0 fail.
- `bun test scripts/__tests__/design-tokens.test.ts`: 45 pass, 0 fail.
- `cargo test --manifest-path crates/desktop-core/Cargo.toml display_helper`: 11 pass, 0 fail.
- Isolated E2E ports 3329/3328/3327/3326: connect-flow 5 pass; final setup + mobile scroll 2 pass. Commands used package `bun run test:e2e -- tests/...`.
- API, web, node, client, helper-panel, pane-runtime, e2e `verify-types` pass. Final changed-file Biome check passes. `lint:design`, `lint:lockfile`, `git diff --check` pass.
- Root ran final native `bash test.sh` on an isolated Mac subtree with the Settings.swift callback included: warnings-as-errors compile, whole-app typecheck, and runtime tests all passed (exit 0). Root removed its owned temporary terminal/subtree.

An initial API `bun run test -- <files>` invocation unexpectedly ran the entire package because its script always includes `src`; it was interrupted after observing the focused failures subsequently fixed/retested above. Do not report that run as a full-suite pass. No release/full verification was requested or claimed. Remote CodeQL/CI results necessarily await the final push.

## Shipping and remaining review

Added `.changeset/pr465-review-hardening.md` for server/node/both desktop apps/docs. No ignored package changeset. All modifications are one review-fix wave, ready for root's independent review. Commit hash is provided in the agent handoff (this report is committed with it).
