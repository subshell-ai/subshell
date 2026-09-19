# Node naming: what the 2026-09-18 rename deliberately did not do

The branch `refactor/cli-release-prefixes` renamed the release components to
`cli-server`/`cli-node` and stopped the word "agent" naming the node DAEMON in
copy and identifiers, while keeping it for the HARNESS a subshell runs. Several
things were frozen on purpose. This file records them, because the reasoning
lived in a scratch ledger that does not survive, and because two of the items
are easy to "finish" by accident in a way that breaks a running fleet.

## The rule the whole follow-up turns on

> A name is frozen when the two processes reading and writing it can ship at
> different versions, and how badly it is frozen depends on whether the
> reader's validator fails closed on absence.

That is what separates the items below from each other, and from the several
names that merely look like they qualify.

## 1. The migration-shaped change

These move together or not at all, because they are all the same fact — the
`nodes.kind` discriminant — spelled in different places.

| what | where | why it is not a rename |
|---|---|---|
| `nodes.kind = "agent"` | `db/migrations/0017-nodes.ts`, `db/types/nodes.db-types.ts` | a column VALUE in an applied migration |
| `nodes.agent_version` | same | a column NAME in an applied migration; cannot change in place |
| `NODE_AGENT_TOO_OLD` | `packages/backend-errors/src/error-codes.ts:28-39` | the enum member IS its string value, shipped as `code` in 409 bodies from four routes |
| `listAgents`, `#reconcileAgentRows`, `#applyAgentAlive` | node repository / registry | all gate on `kind === "agent"` |
| `isOfflineAgent`, `markStaleAgentsOffline` | `web/src/lib/node-label.ts:21`, `db/repositories/nodes.repository.ts:257` | same gate. These two were renamed during the branch and REVERTED for exactly this reason — `isOfflineNode(localNode)` returning false for an offline `local` is a name that lies |
| `agentNode()` | `web/src/routes/__tests__/nodes-detail.test.tsx` | builds rows keyed on that discriminant |

`NODE_AGENT_TOO_OLD` carries a freeze comment at its definition. Do not remove
it without doing the migration.

## 2. The cross-version boundary, ranked

Four keys cross between processes that can ship at different versions. They are
NOT equally risky, and the ordering is the point.

1. **`ready.runtime.agentLogPath`** (`node-frames.ts:327`) — **the sharpest, and
   it was on nobody's list until the final review.** `parseNodeRuntime`
   validates it with `!isStr(value.agentLogPath) ||` inside an
   `if (…) return null` (`node-frames.ts:382`). Renaming it plane-side without
   the fleet does not lose a log path: the WHOLE runtime block fails to parse,
   taking supervision, service state, tmux and `binaryPath` with it. It is a
   required `t.String` at `api/nodes/node-view.ts:231` and renders at
   `components/nodes/node-log-card.tsx:180`. Fleet-coordinated only.
2. **`agent_log_read`** — a wire COMMAND type (`node-frames.ts:718,1243,1248`,
   `node-results.ts:340,363`), 28 uses. A plane sending the new spelling to an
   older agent gets nothing back. Fleet-coordinated.
3. **`ready` frame `agentVersion`** (`node-frames.ts:950,1322`) — protocol field.
4. **`status --json` `agentVersion`** (`apps/node/agent/src/cli.ts:861`) — read
   only by TypeScript at `client/desktop/ui/src/lib/ipc.ts:66`, in an interface
   whose every field is optional BECAUSE the app may be older than the CLI.
   Rust forwards `status` as an opaque `serde_json::Value` and never indexes it.
5. **`status --json` `paths.agentLog`** (`cli.ts:894`) — **the safe one.** Zero
   cross-process readers: `parse_delete_plan` (`client/desktop/src-tauri/src/reset.rs:70-81`)
   reads `configFile`, `lockFile` and `dataDir` by name and stops. The only
   assertion is the node's own. Renameable in ONE commit — though it is still
   published `subshell status --json` output someone could be scripting against.

## 3. Things that look like the boundary and are not

Where a follow-up would waste effort, or break something while believing it was
being careful:

- **`NodePaths.config_file` / `.data_dir`** (`client/desktop/src-tauri/src/control.rs:379-392`)
  share spellings with the CLI's `status --json` `paths` block, so one grep
  returns both. They are the DESKTOP's own, built locally; their key names
  travel Rust→bundled page, and both halves ship in one `.app`/`.deb` from one
  commit. That is why renaming `node_log`/`node_log_hint` was safe in the branch
  and why `paths.agentLog` beside it was not.
- **Serialization is not a boundary inside one bundle.** `Probe` is
  `Serialize`, but its producer and consumer are replaced together. And
  `AgentChoice`/`AgentSource` were `Serialize` with `rename_all = "kebab-case"`,
  so the VARIANTS serialize and not the type name — renaming those types emitted
  byte-identical JSON.
- **`apps/server/desktop` has no exposure at all.** Every key it reads by name
  across `subshell-server status --json` and `service status --json` was
  enumerated; not one carries `agent`.

## 4. `apps/node/agent` → `apps/node/daemon`

Recommended, not done. It is the last structural place the overload survives:
`AGENTS.md` defines a node as "a machine that runs agents — the `subshell`
daemon", so the directory uses the word for the meaning this work removed,
while the package (`@internal/node`), the binary (`subshell`), the release
component (`cli-node`) and now `node_bin.rs` all agree on "node".

Cheaper than it looks: 238 references across 74 files, but only ~4 load-bearing
— `package.json`'s `--cwd`, `release.yml:360`'s `app_dir` table,
`scripts/__tests__/ci-test-plan.test.ts`, and the `git mv`. Workspaces are
`apps/*/*` globs and nothing hardcodes the path in `tsconfig` or `turbo.json`.

**`daemon`, not `cli`:** `cli-node` ↔ `node/cli` would imply a derivation rule
that `cli-server` ↔ `server/api` breaks, and AGENTS.md is explicit that id and
directory are MAPPED rather than derived, because `server/api-v1.9.0` is not a
usable tag.

`release.yml:360` is the one line that must be right or a cut dies on
`apps/<dir>/package.json` not existing. Wants its own review pass.

## 5. One operator decision, not a defect

`apps/server/web/src/components/updates/folded-server-row.tsx:81-83` calls
`Subshell <Product> <Form>` "the one rule all three update surfaces follow",
while `components/updates/server-row.tsx:123` renders `Server`. In a browser the
reader gets "Subshell Server App" directly above "Server" — the ambiguity the
folded row was built to remove. It is deliberate and triple-pinned
(`updates-table.test.tsx:39,98-99`; `e2e/tests/17-server-updates.spec.ts:70`),
so it is a naming choice to confirm or change, not a bug to fix.

## 6. Five sweeps in this work reported clean because they could not see

Worth reading before writing the next one. Each was a filter that could not
reach what it claimed to have cleared:

1. An `--include` list over `ts/tsx/rs/sh/yml/json/md/mdx` — cannot match
   `.gitignore` or a `Dockerfile`. Missed two live sites.
2. `\b[A-Za-z_$][A-Za-z0-9_$]*[Aa]gent[A-Za-z0-9_$]*\b` — requires a character
   BEFORE `agent`, so every identifier starting with the word was invisible, and
   `[Aa]gent` never matches `AGENT`. 384 occurrences unreachable.
3. An exclusion list built for our code, applied to a tree containing code that
   is not ours — swept four vendored CocoaPods headers before being caught.
4. Rust literals written `"\"no-agent\""` with escaped quotes — invisible to a
   string grep; `cargo test` found them.
5. A grep for the BACKTICKED form of a term, missing the unbackticked one.

Use `grep -rI` with no include-list, case-insensitively, and expect the fifth.

## 7. The defect class that caused four separate misses

A noun reaching the screen through a PARAMETER rather than a literal:
`update_summary(&report, "agent")` renders "Updated the installed agent from X
to Y." Searching for the rendered sentence finds nothing to change. It caused
the `install.sh` miss, the `a5f74ac5` miss, its own twin one function away, and
the `@param` documenting `"agent"` as a legal value — which was the path by
which the other three would have come back.
