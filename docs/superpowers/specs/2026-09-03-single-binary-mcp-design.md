# Single-binary MCP — `subshell-server mcp`

Date: 2026-09-03
Status: approved (design conversation same day)
Supersedes: the paired-artifact release decision of the same day (shipped in 1.3.0)

## Problem

Every subshell pane's harness spawns a `subshell mcp` child (the agent's
Subshell-integration shim: channel tools, E2EE identity, per-pane bearer key).
The server must therefore know a **command** to bake into each pane's MCP
config, and a standalone (compiled) `subshell-server` had nothing to resolve:
its executable was not named `backend` (the dead name the sibling check
matched), a compiled binary has no `../mcp/main.js`, and releases shipped no
MCP artifact at all → create 500'd ("cannot locate the subshell-mcp
entrypoint", hit live on mac-builder).

1.3.0 mitigated it (resolver fixed: `services/mcp-resolve.ts`, client-on-PATH
rung, `status` mcp line) and paired the artifacts (`subshell-mcp-<triple>`
beside every server binary). That works, but the operator UX is two files to
download, rename, and co-locate — and needing a `status` line to tell whether
an install is correct is itself the smell.

## Why the binary "couldn't" carry an mcp subcommand — and why it can

The entry contract (`cli.ts` header, `index.ts` prelude, `cli-entry.test.ts`):
handled CLI commands must exit **synchronously** inside the prelude, because
measured bun 1.4.0 behavior evaluates the REST of the entry graph when a
command suspends — and that graph had import-time IO: `@/auth.js` builds
better-auth at module evaluation, which **opens SQLite**, littering the pane's
working directory with `data/subshell.db`. A stdio MCP server lives as long as
its pane, so it can never exit synchronously. Structurally impossible — under
that contract.

The audit (2026-09-03) found the contract guards **one** import-time offender:
`src/auth.ts:114` `export const auth = betterAuth(AUTH_OPTIONS)`. Everything
else in the graph is already evaluation-pure (`@/db` lazy by contract,
constants only *reads* `.env`, the rest are class definitions). So the honest
fix is to remove the constraint, not route around it.

## Design

### 1. Contract flip: import-purity replaces sync-exit as the safety property

New invariant (the load-bearing one): **no module in the entry graph performs
IO at import time** — no opening files/databases, no sockets, no spawns.
Sync-exit stays as house style for the existing commands (they're written;
don't churn), but safety no longer *depends* on it. The invariant is enforced
by subprocess tests (`cli-entry.test.ts`), not comments.

### 2. Auth goes lazy (the one refactor)

`src/auth.ts`: `export const auth = betterAuth(...)` →
`export function getAuth(): Auth` + `@internal resetAuthForTests()` — exactly
the singleton pattern `.claude/rules/code-style.md` prescribes. Construction
moves from import time to first use, which is boot (`index.ts`) or first
request (routes behind auth-guard) — behavior identical, `AUTH_OPTIONS`
unchanged. Update the 11 non-test importers (`auth-guard`, `auth.plugin`,
`subshell-tokens`, `auth-migrations`, `session-cookie`, `node-ws-handler`,
`system-keys.route`, `auth-rate-limit.route`, `enroll.route`,
`rotate-node-key.route`, `index.ts`) plus direct-import tests.

### 3. The `mcp` subcommand

`cli.ts` dispatch gains `case "mcp"`: runs `runSubshellMcp()` from
`@internal/mcp-core` (already a server dependency) until stdin closes, then
exits. Long-running is legal precisely because of §1 — the graph that
evaluates in the suspension window opens nothing. `subshell/mcp`'s pane-env
contract (`SUBSHELL_*`) is untouched.

The resolver ladder collapses:

1. `SUBSHELL_MCP_COMMAND` / `_ARGS` override (unchanged, still the exotic-layout escape)
2. **self**: compiled → `<execPath> mcp`; bun-interpreted (dev/dist) →
   `<execPath> <resolve(process.argv[1])> mcp` — resolved to an ABSOLUTE path
   at bake time (pane configs spawn in the subshell's cwd, where a relative
   entry path would not exist; empty `argv[1]` skips the rung)
3. `subshell` client on PATH (`subshell mcp` — kept as a free safety net for
   hosts that only ever had the agent binary)
4. error → `status` prints UNRESOLVED (unchanged)

Removed: the compiled-sibling rung, the dist-entry rung, and
`apps/server/src/mcp/main.ts` entirely.

### 4. Roll back the paired-artifact release (1.3.0's shape)

- `apps/server/src/scripts/release.ts`: drop `mcpBuildArgs` + the pair loop
  (back to one artifact per triple; map keyed by artifact name is harmless to
  keep or revert to triple keys — choose triple keys again, simpler).
- `@internal/subshell-protocol`: delete `serverMcpArtifactFileName` + its test.
- `apps/server/package.json` `compile`: single `--outfile` again.
- `.github/workflows/release.yml`: drop the `MCP_BIN` existence/sidecar/magic
  checks and `mcp_smoke`; release assets are 3 server binaries again. Keep the
  60-minute shard timeout (one notarize round-trip no longer needs it — set
  back to 45).
- Docs: root + server `AGENTS.md`, `docs/architecture.md`,
  `docs/subshell-rollout.md` → one-file install; the server `AGENTS.md`
  "MCP entrypoint resolution" section inverts its rationale (the subcommand is
  possible *because* the graph is import-pure).

### 5. Migration

Pane MCP configs are regenerated at every create/restart, so there is no
mixed-version state: a host replaces its binary and the next launch writes
`<path-to-subshell-server> mcp` configs. On the Mac, after upgrading past
1.4.0: delete the two `SUBSHELL_MCP_*` keys from `config.env` (the self rung
answers first) and drop any `subshell-mcp` sibling ever installed. Older
1.3.x installs with a sibling keep working until they upgrade (sibling rung was
the rung they resolved through; after upgrade the self rung supersedes it).

### 6. Verification

- **Spike gate, measured before the refactor lands**: in a temp dir containing
  a `.env` and with no config home, `time ./subshell-server mcp </dev/null`
  (compiled binary) must refuse cleanly on the missing-env contract with
  startup < 500 ms, RSS < 200 MB, and **zero files created**. If full-graph
  evaluation busts the budget, this design falls back to embed-and-extract
  (companion binary inside the server artifact) — nothing else changes.
- `cli-entry.test.ts`: subprocess `mcp`-without-env case (clean contract
  error, no port bind, no `data/` litter, non-zero exit); existing
  litter/net cases stay as the purity regression suite.
- `mcp-resolve` suite rewritten for the new ladder (self compiled + bun shapes,
  PATH fallback, error text, malformed-args guard carried over).
- `getAuth()` identity-stability + reset unit test; every existing suite as
  the auth-move regression net; full gates (build/verify-types/lint/test).

## Out of scope

- The client binary (`subshell mcp` unchanged — its entry never had the boot
  graph).
- Windows/other triples; packaging (tarball/installer) — the install stays
  "drop one binary, `init`, `service install`".
- HTTP/SSE MCP transports.
