# Verification

**Verify the affected behavior, including at task boundaries.** A push, PR,
merge, or handoff does not justify running unrelated packages. The shared
policy is [docs/testing.md](../../docs/testing.md).

While iterating, run covering test files, the package's type check, and Biome
on changed code. Before handoff, inspect and execute the affected plan:

```bash
bun run test:changed -- --plan
bun run verify:changed
```

The planner includes committed changes since `origin/main`, staged changes,
unstaged changes, and untracked files. `--base <ref>` selects another base.
Unknown inputs or missing history select full verification and explain why.
Do not silently narrow that fallback; fetch the correct base if it is missing.
For a documentation-only change, run prose/content validation instead of product
suites. Do not repeat checks that already passed unless new changes affect them.

`verify:changed` builds and type-checks changed packages and their transitive
consumers. This catches failures source-only tests miss, including a shared
protocol import that Metro cannot bundle. It also runs the selected tests,
compiled/browser checks, and Rust crates. A Rust app edit checks that app;
a shared desktop-core change checks both apps too. `rust:check` still stages
missing sidecar stubs and removes only the stubs it created.

Fix relevant failures before handoff. Report the checks actually run and any
blocked tier. Never describe a partial run as the full suite. `bun run test`
is workspace unit tests only; `bun run test:full` includes the other tiers.
Full verification belongs to release cuts and explicit broad verification,
not every task boundary. Release CI requires a fresh full run on the release
revision before tags or artifacts are published, on Linux and macOS.

The pre-push hook runs affected static checks plus the fast repository contract
checks. CI owns the affected test tiers; the hook does not duplicate them.

## The CLI end-to-end suite

```bash
bun run test:cli     # compiles both binaries, then drives them as an operator does
```

Not part of `bun run test` (it compiles ~150 MB of binaries and takes a
minute). Run it when you touch `init`, `configure`, `status`, `service`,
either CLI's `update`/`backup`, the node `setup`/`enroll` verbs, or the
rendered `install.sh`; it is the only thing that answers whether those work
COMPILED. The two update scenarios (`server-update.sh`, `node-update.sh`) each
build a second binary from the same source with a patched version and restore
the edit from a trap, so an interrupted run leaves no bumped `package.json`. `bun run test` stubs every
service seam, and `e2e/` boots the server from source, so a bundler dropping a
module, a prompt that hangs without a TTY, or a handoff line nobody prints are
invisible to both.

It isolates config and data with temp dirs and the env knobs
(`SUBSHELL_SERVER_CONFIG_DIR`, `SUBSHELL_CONFIG_HOME`) and binds ports
31992–31999, never `:3080`. It does **not** uniformly use a throwaway `HOME`:
`install-script.sh` and `published-release.sh` swap it; the update scenarios
run under the REAL one. That is not an oversight to fix but the fact the next
sentence guards. One thing is NOT sandboxable at all: `update` replaces the
binary the SERVICE DEFINITION names, and the definition lives in
the real launchd/systemd user domain (loaded or merely on disk), so
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
published binary, and enrols a node through the one-liner that server serves,
covering the digest check, the embedded SPA, and the lazy fetch of the agent
binary from the node release, none of which have a local equivalent. It needs
the public internet and a published `cli-server-v*`, which is why it is not in
`test:cli`.

## `lint` vs `lint:check`

- `bun run lint` runs biome with `--write --unsafe`: it **fixes** what it can and rarely reports a failure. Use it while working.
- `bun run lint:check` runs biome read-only. Use it to verify, because it actually fails on anything unfixed and never leaves modified files behind.

The usual loop is `bun run lint` to fix, then `bun run lint:check` to confirm.
