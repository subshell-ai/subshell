# Verification

**Always run verification after making code changes.** Don't wait to be asked or until you "feel confident" - run these immediately after any modification:

```bash
bun run verify-types
bun run lint:check
bun run test
```

If any of these fail, fix the issues before considering the task complete. Do not proceed to commits or other work until all three pass.

`pre-push` runs only the first two (types + lint) — CI owns the test suite. Run all three
yourself before pushing anything you expect to be green on the first try.

## Changes under `packages/` need a build

```bash
bunx turbo build
```

`verify-types`, `lint:check` and `test` all run against SOURCE and will pass
while the workspace build is broken. The trap that catches people is
`@internal/subshell-protocol`: **`apps/client/mobile` imports its barrel through
Metro, which cannot resolve `node:*`**, so adding a node-builtin import to
`src/index.ts` — directly or by re-exporting a module that has one — breaks the
mobile build and NOTHING ELSE. All three local commands stay green and CI fails
on a package you never opened. Node-only modules are subpath exports instead
(`release-artifacts`, `service-test-safety`); `src/index.ts` says so at the
export site. Measured 2026-09-15, twice in one run.

## Rust changes need a fourth command

Those three commands do not touch Rust at all. If you changed anything under
`crates/desktop-core` or either `apps/*/desktop/src-tauri`, also run:

```bash
bun run rust:check
```

It runs exactly what CI's Rust jobs run — `cargo fmt --check`, then
`cargo clippy --all-targets -- -D warnings`, then `cargo test` — in all three
crates.

**`cargo check` on its own is not enough, and the two app crates cannot even be
compiled without help.** `tauri-build` refuses to build when an `externalBin`
path is missing, and the staged sidecar is a gitignored ~110 MB build input, so
a plain `cargo clippy` there dies inside the build script instead of reporting a
lint. `rust:check` stages a stub for the host triple first (the same trick
test.yml uses) and removes only what it created, so a real sidecar staged by a
release in progress is left alone.

This was added after a hand-written import block failed `cargo fmt --check` on
both desktop shards in CI — caught by neither `cargo check` nor clippy, and a
full CI round trip to discover something a local command finds in seconds.

**On macOS it refuses early when `cc` cannot link** (`scripts/macos-toolchain-preflight.sh`,
shared with the `tauri dev` launchers). An unaccepted Xcode licence stops every
cargo build, and cargo reports that as a `note:` about a hundred lines above an
error naming a SOURCE FILE — so a machine that cannot link anything reads as one
broken doctest in a file you just edited. Measured on 2026-09-15. The remedy is
`sudo xcodebuild -license`, or `export DEVELOPER_DIR=/Library/Developer/CommandLineTools`,
whose toolchain the licence gate does not cover. A link failure the probe does
not recognise is reported verbatim rather than blamed on the licence.

## The CLI end-to-end suite

```bash
bun run test:cli     # compiles both binaries, then drives them as an operator does
```

Not part of `bun run test` (it compiles ~150 MB of binaries and takes a
minute). Run it when you touch `init`, `configure`, `status`, `service`,
either CLI's `update`/`backup`, the node `setup`/`enroll` verbs, or the
rendered `install.sh` — it is the only thing that answers whether those work
COMPILED. The two update scenarios (`server-update.sh`, `node-update.sh`) each
build a second binary from the same source with a patched version and restore
the edit from a trap, so an interrupted run leaves no bumped `package.json`. `bun run test` stubs every
service seam, and `e2e/` boots the server from source, so a bundler dropping a
module, a prompt that hangs without a TTY, or a handoff line nobody prints are
invisible to both.

It isolates config and data with temp dirs and the env knobs
(`SUBSHELL_SERVER_CONFIG_DIR`, `SUBSHELL_CONFIG_HOME`) and binds ports
31992–31999 — never `:3080`. It does **not** uniformly use a throwaway `HOME`:
`install-script.sh` and `published-release.sh` swap it; the update scenarios
run under the REAL one. That is not an oversight to fix but the fact the next
sentence guards. One thing is NOT sandboxable at all: `update` replaces the
binary the SERVICE DEFINITION names, and the definition lives in
the real launchd/systemd user domain (loaded or merely on disk) — so
`server-update.sh` **refuses to run on a host that has a per-user Subshell
Server installed** (measured 2026-09-18:
unguarded, the scenario swapped a developer's real `~/.local/bin/subshell-server`
for the test build while still reporting the swap). The same host fact makes
`cli.test.ts`'s "update refuses when no binary is installed" fail locally on
such a machine while CI is green: the resolution ladder sees the operator's
job, and no injected temp-dir can hide it.

**After a release cut**, run the post-cut check by hand:

```bash
bash scripts/cli-e2e/published-release.sh
```

It drives `install-server.sh` against the real GitHub release, boots the
published binary, and enrols a node through the one-liner that server serves —
covering the digest check, the embedded SPA, and the lazy fetch of the agent
binary from the node release, none of which have a local equivalent. It needs
the public internet and a published `server-v*`, which is why it is not in
`test:cli`.

## `lint` vs `lint:check`

- `bun run lint` runs biome with `--write --unsafe`: it **fixes** what it can and rarely reports a failure. Use it while working.
- `bun run lint:check` runs biome read-only. Use it to verify, because it actually fails on anything unfixed and never leaves modified files behind.

The usual loop is `bun run lint` to fix, then `bun run lint:check` to confirm.
