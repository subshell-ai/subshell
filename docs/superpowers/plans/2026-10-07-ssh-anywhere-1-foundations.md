# SSH Anywhere - Plan 1: Foundations (gate + ported primitives) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a branch `feat/ssh-anywhere-1` cut from `feat/ssh-anywhere` (stacked PR onto the spec PR #333), land the two foundations every later slice needs: a default-off, owner-controlled, fail-closed per-node `ssh_enabled` capability gate, and the neutral OpenSSH primitives (config discovery, `ssh -G` resolve, connection-snapshot grammar) plus the sshd e2e fixture, ported off `feat/ssh-support`.

**Architecture:** The `ssh_enabled` gate mirrors the existing `maintenance` flag (plane column + node mirror file + a push command + `ready` reporting) but with the plane as the sole writer and no pane-killing side effects; a `nodeCanSsh` predicate refuses use of a disabled node. The ssh grammar lives in `@internal/subshell-protocol` (barrel-safe: no `node:` builtins), the ssh engines in `@internal/pane-runtime` (its barrel is never imported by mobile), and the sshd fixture in `e2e/fixtures`.

**Tech Stack:** Bun, TypeScript, Elysia (routes), Kysely (migrations/types), node:test-style `bun:test` unit tests, Playwright (e2e), `@base-ui`, React (only read by later plans).

## Global Constraints

Every task obeys these (copied from the spec `docs/superpowers/specs/2026-10-07-ssh-anywhere-design.md`):

- New migration number is **`0047`** (`main`'s latest is `0046-backup-recovery.ts`); do NOT reuse the branch's 0047-0051 names.
- `ssh_enabled` defaults **off/false on every node including `local`**; the DB column is `notNull().defaultTo(0)` (the maintenance default-0 "upgrade keeps the fleet as it was" doctrine).
- The node-side read is **fail-closed**: a node that cannot read its own setting refuses SSH; an absent file reads as **off** (default-off).
- Changing the flag is **owner-only, admin on `local`** (`gate.canManage`), cookie-authenticated, audited as `node.ssh_enabled.update` (the node-family verb pattern; the name is added to the `docs/security.md` section 10 event list in Task 6); the flag is plane-written (no node self-toggle CLI).
- **Every command runs in the `/home/theo/projects/wt-ssh-anywhere` worktree**, never in `/home/theo/projects/subshell` (the shared checkout holds other branches' uncommitted work). The worktree is a linked git worktree, so it shares the main checkout's refs and `git show origin/feat/ssh-support:<path>` works from inside it.
- **`NODE_PROTOCOL_VERSION` bumps 15 -> 16** (Task 7): the gate's new frames ride the bump because the node-link compatibility gate is exact-match.
- No SSH private key material, challenge, signature, or config value enters any log, argv, or audit row; audits name ids/hosts/field-names only.
- Node-builtin-importing modules must NOT be re-exported from `packages/subshell-protocol/src/index.ts` (Metro imports that barrel and cannot resolve `node:*`). Grammar modules that import no `node:` builtin MAY be barrel-exported there. `@internal/pane-runtime` is not a mobile dependency, so its engines may be exported from its own index barrel.
- `shellQuote` every token of any built command; static top-level imports only (no `await import` outside the sanctioned `plugin-runtime.ts`).
- Run package tests with `env -u SHELLOPTS -u BASHOPTS`; a `bun test <path>` silently passes on a wrong path, so check the file count.
- Commit as author `theo@suteki.nu`.
- Design system (only where copy is shipped, which this plan does not): role tokens, two-sentence max, no em dashes.

---

## Branch setup (once, before Task 1)

In the worktree (never in the shared checkout):

```bash
cd /home/theo/projects/wt-ssh-anywhere
git switch -c feat/ssh-anywhere-1   # from feat/ssh-anywhere, the spec/plan branch
```

All tasks commit on `feat/ssh-anywhere-1`; Task 8 opens the PR against
`feat/ssh-anywhere`.

---

## File Structure

Ports (verbatim copies off `origin/feat/ssh-support`, then export wiring; the ported files cite `SSH-SUPPORT.md`, which was deleted as superseded, so each port commit rewrites every `SSH-SUPPORT.md §N` pointer to this spec's `2026-10-07-ssh-anywhere-design.md §N`):
- Create: `packages/subshell-protocol/src/ssh-config.ts` (grammar; no `node:` builtins → barrel-safe)
- Create: `packages/subshell-protocol/src/ssh-limits.ts` (budgets; no `node:` builtins → barrel-safe)
- Create: `packages/subshell-protocol/src/ssh-errors.ts` (error codes + shipped descriptions; imports nothing → barrel-safe)
- Create: `packages/subshell-protocol/src/ssh-results.ts` (resolve/discover wire outcomes; type-only imports → barrel-safe)
- Create: `packages/subshell-protocol/src/__tests__/ssh-config.test.ts`
- Create: `packages/subshell-protocol/src/__tests__/fixtures/ssh-fixtures.ts` (imported by the grammar test)
- Create: `packages/pane-runtime/src/ssh/ssh-spawn.ts` (`node:*` → pane-runtime barrel only)
- Create: `packages/pane-runtime/src/ssh/ssh-discover.ts` (`node:fs/os/path` → pane-runtime barrel only)
- Create: `packages/pane-runtime/src/ssh/ssh-resolve.ts`
- Create: `packages/pane-runtime/src/ssh/__tests__/helpers.ts` (test fixtures + ssh shim; imported by both engine tests)
- Create: `packages/pane-runtime/src/ssh/__tests__/ssh-discover.test.ts` (ported verbatim, not hand-written)
- Create: `packages/pane-runtime/src/ssh/__tests__/ssh-resolve.test.ts` (ported verbatim, not hand-written)
- Create: `e2e/fixtures/sshd.ts`

Gate (new, mirroring the maintenance template):
- Create: `apps/server/api/src/db/migrations/0047-node-ssh-enabled.ts`
- Modify: `apps/server/api/src/db/migrate.ts` (register `0047`)
- Modify: `apps/server/api/src/db/types/nodes.db-types.ts` (`sshEnabled`, `sshEnabledAt`)
- Modify: `apps/server/api/src/db/repositories/nodes.repository.ts` (`setSshEnabled`)
- Modify: `apps/server/api/src/lib/node-access.ts` (`nodeCanSsh`)
- Modify: `apps/server/api/src/api/nodes/node-view.ts` (`sshEnabled` in `NodeViewSchema` + `nodeViewBase`)
- Create: `apps/server/api/src/api/nodes/set-node-ssh-enabled.route.ts` (calls the service, like the maintenance route calls `setNodeMaintenance`)
- Create: `apps/server/api/src/services/nodes/ssh-enabled.ts` (Task 6: `setNodeSshEnabled` row-write + audit; Task 7 adds `pushSetSshEnabled` + `reconcileSshEnabled`)
- Modify: `apps/server/api/src/api/nodes/index.ts` (mount the route)
- Modify: `docs/security.md` §10 + `.claude/rules/security-context.md` (add `node.ssh_enabled.update` to the nodes audit family)
- Modify: `packages/subshell-protocol/src/node-frames.ts` (`NodeSshEnabledWire`, `parseNodeSshEnabled`, `set_ssh_enabled` command arm, `ssh_enabled` event arm, `ready` arm, `NODE_PROTOCOL_VERSION` 15 -> 16 + history comment; the `NODE_RESULT_SSH_DISABLED` result string is deliberately NOT here - it ships with the Plan 2 launcher that produces it)
- Modify: `packages/subshell-protocol/src/index.ts` (export grammar + the new wire symbols)
- Create: `apps/node/agent/src/ssh-enabled.ts` (`node:*` file read/write, fail-closed)
- Create: `apps/node/agent/src/commands/set-ssh-enabled.ts` (executor: write mirror file + memoize)
- Modify: `apps/node/agent/src/commands/context.ts` (`lastReportedSshEnabled?` memo)
- Modify: `apps/node/agent/src/commands/report.ts` (`reportSshEnabled`, `maybeReportSshEnabled`, `seedSshEnabledMemo`)
- Modify: `apps/node/agent/src/commands/index.ts` (dispatch `set_ssh_enabled`)
- Modify: `apps/node/agent/src/daemon.ts` (`readyEvent` includes `sshEnabled`)
- Modify: `apps/server/api/src/services/nodes/node-events.ts` + `apps/server/api/src/index.ts` (onReady reconcile hook)
- Test files alongside each new service/route/module in `__tests__/`.

---

## Task 1: Port the ssh grammar into `subshell-protocol` (barrel-safe)

**Files:**
- Create: `packages/subshell-protocol/src/ssh-limits.ts`, `.../ssh-config.ts`, `.../ssh-errors.ts`, `.../ssh-results.ts`
- Create: `packages/subshell-protocol/src/__tests__/ssh-config.test.ts`, `.../__tests__/fixtures/ssh-fixtures.ts`
- Modify: `packages/subshell-protocol/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (from `@internal/subshell-protocol`): the limits `SSH_MAX_DISCOVERED_ALIASES`, `SSH_MAX_PROXY_HOPS`, `SSH_NAME_MAX_CHARS`, `SSH_PROBE_DEADLINE_MS`; the grammar `type SshHopWire`, `type SshConnectionSnapshotWire`, `parseSshConnectionSnapshot`, `SSH_FORBIDDEN_SNAPSHOT_FIELDS`; the named-refusal codes and shipped sentences `SSH_ERROR_CODES`, `type SshErrorCode`, `isSshErrorCode`, `SSH_ERROR_DESCRIPTIONS` (the Plan 3 review UI renders the descriptions by equality, never the wire code); the RPC outcomes `type NodeSshAliasListResult`, `type NodeSshResolveOutcomeWire`. This is exactly what Task 2's engines import from the package barrel (`ssh-resolve.ts` pulls seven of these symbols; a missing one fails its test run at Task 2 Step 2, not here).

- [ ] **Step 1: Copy the six files verbatim off the branch, into the worktree**

```bash
cd /home/theo/projects/wt-ssh-anywhere
B=origin/feat/ssh-support
mkdir -p packages/subshell-protocol/src/__tests__/fixtures
for f in ssh-limits ssh-config ssh-errors ssh-results; do
  git show "$B:packages/subshell-protocol/src/$f.ts" > packages/subshell-protocol/src/$f.ts
done
git show "$B:packages/subshell-protocol/src/__tests__/ssh-config.test.ts" > packages/subshell-protocol/src/__tests__/ssh-config.test.ts
git show "$B:packages/subshell-protocol/src/__tests__/fixtures/ssh-fixtures.ts" > packages/subshell-protocol/src/__tests__/fixtures/ssh-fixtures.ts
grep -nE "from \"node:" packages/subshell-protocol/src/ssh-limits.ts packages/subshell-protocol/src/ssh-config.ts packages/subshell-protocol/src/ssh-errors.ts packages/subshell-protocol/src/ssh-results.ts  # MUST print nothing
```

Expected: the `grep` prints nothing (all four modules are `node:`-free, so they are barrel-safe). If it prints any line, that module is NOT grammar and belongs in `pane-runtime` instead - stop and re-scope.

- [ ] **Step 2: Rewrite the deleted-document pointers**

The copied files' doc comments cite `SSH-SUPPORT.md`, deleted as superseded. Replace every citation with `docs/superpowers/specs/2026-10-07-ssh-anywhere-design.md`, keeping the sentence true (drop a `§N` cross-reference when the spec has no matching section rather than pointing at a wrong one). Check: `grep -c "SSH-SUPPORT" packages/subshell-protocol/src/ssh-limits.ts packages/subshell-protocol/src/ssh-config.ts packages/subshell-protocol/src/ssh-errors.ts packages/subshell-protocol/src/ssh-results.ts` prints `0` for all four.

- [ ] **Step 3: Run the grammar test (it imports the copied files by relative path, so it is green before any barrel wiring)**

Run: `cd /home/theo/projects/wt-ssh-anywhere/packages/subshell-protocol && env -u SHELLOPTS -u BASHOPTS bun test src/__tests__/ssh-config.test.ts`
Expected: PASS (1 file). A failed import means the copy is incomplete - fix the copy, do not trim the test.

- [ ] **Step 4: Barrel-export the grammar**

Append to `packages/subshell-protocol/src/index.ts` (do NOT export any `node:`-importing module here):

```ts
export {
  SSH_MAX_DISCOVERED_ALIASES,
  SSH_MAX_PROXY_HOPS,
  SSH_NAME_MAX_CHARS,
  SSH_PROBE_DEADLINE_MS,
} from "./ssh-limits.js";
export {
  type SshHopWire,
  type SshConnectionSnapshotWire,
  parseSshConnectionSnapshot,
  SSH_FORBIDDEN_SNAPSHOT_FIELDS,
} from "./ssh-config.js";
export {
  SSH_ERROR_CODES,
  type SshErrorCode,
  isSshErrorCode,
  SSH_ERROR_DESCRIPTIONS,
} from "./ssh-errors.js";
export {
  type NodeSshAliasListResult,
  type NodeSshResolveOutcomeWire,
} from "./ssh-results.js";
```

(Do not export `NODE_RESULT_SSH_GENERATION_STALE` or the other #330 result-channel strings; they have no consumer on this path.)

- [ ] **Step 5: Build the package and run its tests**

Run: `cd /home/theo/projects/wt-ssh-anywhere && bunx turbo build --filter=@internal/subshell-protocol && cd packages/subshell-protocol && env -u SHELLOPTS -u BASHOPTS bun test`
Expected: build succeeds; `ssh-config` test PASS; no other protocol test regresses.

- [ ] **Step 6: Confirm the mobile build is unaffected (the Metro trap)**

Run: `grep -c "ssh-config\|ssh-limits" /home/theo/projects/wt-ssh-anywhere/packages/subshell-protocol/dist/index.js`
Expected: nonzero - the built barrel references the grammar; because the four files import no `node:`, Metro can still resolve the barrel. (The real mobile guard runs in CI; this is the local sanity check the rules call for.)

- [ ] **Step 7: Commit**

```bash
cd /home/theo/projects/wt-ssh-anywhere
git add packages/subshell-protocol/src/ssh-limits.ts packages/subshell-protocol/src/ssh-config.ts packages/subshell-protocol/src/ssh-errors.ts packages/subshell-protocol/src/ssh-results.ts packages/subshell-protocol/src/index.ts packages/subshell-protocol/src/__tests__/ssh-config.test.ts packages/subshell-protocol/src/__tests__/fixtures/ssh-fixtures.ts
git commit -m "feat(ssh): port OpenSSH grammar, budgets, and named-refusal codes into subshell-protocol"
```

---

## Task 2: Port the ssh engines into `pane-runtime` (barrel-safe because mobile never imports it)

**Files:**
- Create: `packages/pane-runtime/src/ssh/ssh-spawn.ts`, `.../ssh-discover.ts`, `.../ssh-resolve.ts`
- Create: `packages/pane-runtime/src/ssh/__tests__/helpers.ts`, `.../ssh-discover.test.ts`, `.../ssh-resolve.test.ts` (all three ported verbatim; the two tests import `./helpers.js`)
- Modify: `packages/pane-runtime/src/index.ts`

**Interfaces:**
- Consumes (Task 1): `type NodeSshResolveOutcomeWire`, `parseSshConnectionSnapshot`, `SSH_MAX_PROXY_HOPS`, `SSH_PROBE_DEADLINE_MS`, `type SshConnectionSnapshotWire`, `type SshErrorCode`, `type SshHopWire` (ssh-resolve.ts) plus `SSH_MAX_DISCOVERED_ALIASES`, `SSH_NAME_MAX_CHARS` (ssh-discover.ts), and `type SshConnectionSnapshotWire` in helpers.ts - all from `@internal/subshell-protocol`.
- Produces (from `@internal/pane-runtime`): `runSshProcess`, `type SshProcessResult`, `sshChildPath` (spawn); `defaultSshConfigPath`, `discoverSshAliases`, `isDiscoverableAlias`, `expandTilde`, `walkSshConfig`, `type SshAliasDiscovery`, `type SshConfigWalk`, `type SshHostBlock`, `type SshWalkBudget` (discover); `parseProxyHop`, `resolveSshAliasConfig`, `type SshResolutionDeps` (resolve). These are the branch's real export names, verified from the files themselves on 2026-10-07.

- [ ] **Step 1: Copy the three engines and their three test files verbatim**

```bash
cd /home/theo/projects/wt-ssh-anywhere
B=origin/feat/ssh-support
mkdir -p packages/pane-runtime/src/ssh/__tests__
for f in ssh-spawn ssh-discover ssh-resolve; do
  git show "$B:packages/pane-runtime/src/ssh/$f.ts" > packages/pane-runtime/src/ssh/$f.ts
done
for f in helpers ssh-discover.test ssh-resolve.test; do
  git show "$B:packages/pane-runtime/src/ssh/__tests__/$f.ts" > packages/pane-runtime/src/ssh/__tests__/$f.ts
done
```

Then confirm each engine's imports are ONLY `node:*`, its `./` siblings inside `ssh/`, or `@internal/subshell-protocol`. The known true edges (keep them): `ssh-resolve.ts` imports `defaultSshConfigPath`, `expandTilde`, `type SshHostBlock`, `type SshWalkBudget`, `walkSshConfig` from `./ssh-discover.js` and `runSshProcess`, `sshChildPath` from `./ssh-spawn.js`; helpers.ts imports a protocol type. A `./ssh-render` / `./ssh-session-*` / `./kill-group` / codec import would be coupling to the abandoned runtime path - none exists on the branch today, so if one appears, record it and de-couple it (never by deleting a protocol import Task 1 supplies). Rewrite the `SSH-SUPPORT.md` pointers as in Task 1 Step 2 and check `grep -l "SSH-SUPPORT" packages/pane-runtime/src/ssh/*.ts packages/pane-runtime/src/ssh/__tests__/*.ts` prints nothing.

- [ ] **Step 2: Run the ported tests**

Run: `cd /home/theo/projects/wt-ssh-anywhere && bunx turbo build --filter=@internal/subshell-protocol && cd packages/pane-runtime && env -u SHELLOPTS -u BASHOPTS bun test src/ssh/__tests__/ssh-discover.test.ts src/ssh/__tests__/ssh-resolve.test.ts`
Expected: PASS, 2 files. The resolve tests run the resolver against a shim `ssh` that `helpers.ts` bakes with canned `-G` output, and end with one case driven by the REAL host `ssh -G`, loud-skipped only where ssh is absent - the guard ships inside the ported test; do not add `missingSshBins` (that lives in the e2e package, which pane-runtime does not depend on).

- [ ] **Step 3: Export the engines from the pane-runtime barrel (named exports, the file's existing style)**

Append to `packages/pane-runtime/src/index.ts`:

```ts
export { runSshProcess, type SshProcessResult, sshChildPath } from "./ssh/ssh-spawn.js";
export {
  defaultSshConfigPath,
  discoverSshAliases,
  isDiscoverableAlias,
  type SshAliasDiscovery,
  type SshConfigWalk,
  type SshHostBlock,
  type SshWalkBudget,
  walkSshConfig,
} from "./ssh/ssh-discover.js";
export {
  parseProxyHop,
  resolveSshAliasConfig,
  type SshResolutionDeps,
} from "./ssh/ssh-resolve.js";
```

(`expandTilde` stays package-internal like the branch's barrel has it; the engines use it via relative imports.)

- [ ] **Step 4: Build, typecheck, and commit**

```bash
cd /home/theo/projects/wt-ssh-anywhere
bunx turbo build --filter=@internal/pane-runtime
bunx turbo verify-types --filter=@internal/pane-runtime
git add packages/pane-runtime/src/ssh packages/pane-runtime/src/index.ts
git commit -m "feat(ssh): port OpenSSH config discovery and ssh -G resolve into pane-runtime"
```

---

## Task 3: Port the sshd e2e fixture

**Files:**
- Create: `e2e/fixtures/sshd.ts`
- Test: nothing (fixture; exercised by later plans)

**Interfaces:**
- Produces (from `e2e/fixtures/sshd`): `missingSshBins`, `SSH_FIXTURE_ALIAS`, `startSshFixture`, `type SshFixture`.

- [ ] **Step 1: Copy the fixture and check its imports**

```bash
cd /home/theo/projects/wt-ssh-anywhere
B=origin/feat/ssh-support
git show "$B:e2e/fixtures/sshd.ts" > e2e/fixtures/sshd.ts
```

Open it: it must depend only on `node:*` + repo-internal e2e helpers (`../ports`, `../stack`) that already exist on `main`. Fix any import that pointed at a #330-only helper.

- [ ] **Step 2: Typecheck the e2e package**

Run: `cd /home/theo/projects/wt-ssh-anywhere && bunx turbo verify-types --filter=@internal/e2e`
Expected: no new errors from `sshd.ts`.

- [ ] **Step 3: Commit**

```bash
git add e2e/fixtures/sshd.ts
git commit -m "test(e2e): port the isolated sshd fixture"
```

---

## Task 4: Add the `nodes.ssh_enabled` column (migration + row type)

**Files:**
- Create: `apps/server/api/src/db/migrations/0047-node-ssh-enabled.ts`
- Modify: `apps/server/api/src/db/migrate.ts`
- Modify: `apps/server/api/src/db/types/nodes.db-types.ts`
- Test: `apps/server/api/src/db/migrations/__tests__/0047-node-ssh-enabled.test.ts` (the established migration-test placement and pattern is `0031-node-maintenance.test.ts` beside the migrations, hand-built Kysely over a migration subset; the boot-seeded `local` row does NOT exist in such a DB, so the test proves the default on its own inserted rows)

**Interfaces:**
- Produces: `NodeTable.sshEnabled: number` (0/1), `NodeTable.sshEnabledAt: string | null`; `NewNode.sshEnabled?: number`.

- [ ] **Step 1: Write the failing migration test**

Model it on `0031-node-maintenance.test.ts` read verbatim (`git show origin/main:apps/server/api/src/db/migrations/__tests__/0031-node-maintenance.test.ts`): hand-built Kysely over a migration subset, a row inserted BEFORE the new migration runs (that is the upgrade case), raw `pragma_table_info` checks, and a down/up round trip. The full test:

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as profileDefaultFlagMigration from "@/db/migrations/0010-profile-default-flag.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import * as sshEnabledMigration from "@/db/migrations/0047-node-ssh-enabled.js";
import { openSqliteDatabase } from "@/db/open-database.js";

interface MigrationDatabase {
  [table: string]: Record<string, unknown>;
  nodes: Record<string, unknown>;
}

/**
 * The SSH capability gate columns. Default 0 is the whole upgrade story: a
 * node enrolled before this migration (and the seeded local row) reads OFF,
 * because SSH egress and key use are opt-in per machine.
 */
describe("migration 0047-node-ssh-enabled", () => {
  let dbFile: string;
  let db: Kysely<MigrationDatabase>;

  /** Insert a node row the way the pre-0047 repository did - no ssh fields at all. */
  const legacyNode = (id: string) =>
    db
      .insertInto("nodes")
      .values({
        id,
        owner_user_id: "u1",
        name: id,
        kind: "agent",
        created_at: "2026-10-01T00:00:00.000Z",
        updated_at: "2026-10-01T00:00:00.000Z",
      })
      .execute();

  beforeAll(async () => {
    dbFile = `/tmp/subshell-0047-${Math.random().toString(36).slice(2)}.db`;
    db = new Kysely<MigrationDatabase>({ dialect: new BunSqliteDialect({ database: openSqliteDatabase(dbFile) }) });
    await initMigration.up(db);
    await remoteOpsMigration.up(db);
    await profileDefaultFlagMigration.up(db);
    await nodesMigration.up(db);
    // Written BEFORE the columns exist - the upgrade case this test is about.
    await legacyNode("pre-existing");
    await sshEnabledMigration.up(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("adds the two columns", async () => {
    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('nodes')`.execute(db);
    const names = cols.rows.map((c) => c.name);
    expect(names).toContain("ssh_enabled");
    expect(names).toContain("ssh_enabled_at");
  });

  it("leaves every pre-existing node with SSH off (default-off doctrine)", async () => {
    const r = await sql<{ ssh_enabled: number; ssh_enabled_at: string | null }>`SELECT ssh_enabled, ssh_enabled_at FROM nodes WHERE id = 'pre-existing'`.execute(db);
    expect(r.rows[0]).toEqual({ ssh_enabled: 0, ssh_enabled_at: null });
  });

  it("defaults a row written without the columns to 0", async () => {
    await legacyNode("fresh");
    const r = await sql<{ ssh_enabled: number }>`SELECT ssh_enabled FROM nodes WHERE id = 'fresh'`.execute(db);
    expect(r.rows[0].ssh_enabled).toBe(0);
  });

  it("stores the flag with its stamp", async () => {
    await db
      .updateTable("nodes")
      .set({ ssh_enabled: 1, ssh_enabled_at: "2026-10-07T10:00:00.000Z" })
      .where("id", "=", "fresh")
      .execute();
    const r = await sql<{ ssh_enabled: number; ssh_enabled_at: string }>`SELECT ssh_enabled, ssh_enabled_at FROM nodes WHERE id = 'fresh'`.execute(db);
    expect(r.rows[0]).toEqual({ ssh_enabled: 1, ssh_enabled_at: "2026-10-07T10:00:00.000Z" });
  });

  it("down removes both columns and leaves the rows", async () => {
    await sshEnabledMigration.down(db);
    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('nodes')`.execute(db);
    const names = cols.rows.map((c) => c.name);
    expect(names).not.toContain("ssh_enabled");
    expect(names).not.toContain("ssh_enabled_at");
    const left = await sql<{ id: string }>`SELECT id FROM nodes ORDER BY id`.execute(db);
    expect(left.rows.map((r) => r.id)).toEqual(["fresh", "pre-existing"]);
    await sshEnabledMigration.up(db); // leave the DB on the current shape
  });
});
```

(`Math.random()` is fine here: this is a bun:test file, not a Workflow script. The temp file name follows the 0031 test's own pattern.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd /home/theo/projects/wt-ssh-anywhere/apps/server/api && env -u SHELLOPTS -u BASHOPTS bun test src/db/migrations/__tests__/0047-node-ssh-enabled.test.ts`
Expected: FAIL (module `0047-node-ssh-enabled.js` does not exist yet).

- [ ] **Step 3: Write the migration (copy the 0031 shape; kysely's `addColumn` is three-arg: name, type expression, constraint callback)**

```ts
import type { Kysely } from "kysely";

// Adds the per-node SSH capability gate. Default 0 keeps the whole fleet (and
// the control-plane host) off after an upgrade: SSH egress and key use are
// opt-in per machine (spec 4.3; the maintenance default-0 "upgrade keeps the
// fleet as it was" doctrine).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("nodes").addColumn("ssh_enabled", "integer", (col) => col.notNull().defaultTo(0)).execute();
  await db.schema.alterTable("nodes").addColumn("ssh_enabled_at", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("nodes").dropColumn("ssh_enabled_at").execute();
  await db.schema.alterTable("nodes").dropColumn("ssh_enabled").execute();
}
```

- [ ] **Step 4: Register it in `migrate.ts`**

Add the import and map entry beside the maintenance ones, keyed `"0047-node-ssh-enabled"`.

- [ ] **Step 5: Add the row-type fields**

In `nodes.db-types.ts`, next to `maintenance`/`maintenanceAt`, add `sshEnabled: number;` and `sshEnabledAt: string | null;` (with the property JSDoc the file uses) and `sshEnabled?: number;` on `NewNode`.

- [ ] **Step 6: Run the test to confirm it passes**

Run: `cd /home/theo/projects/wt-ssh-anywhere/apps/server/api && env -u SHELLOPTS -u BASHOPTS bun test src/db/migrations/__tests__/0047-node-ssh-enabled.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/api/src/db/migrations/0047-node-ssh-enabled.ts apps/server/api/src/db/migrate.ts apps/server/api/src/db/types/nodes.db-types.ts apps/server/api/src/db/migrations/__tests__/0047-node-ssh-enabled.test.ts
git commit -m "feat(nodes): add ssh_enabled capability column (default off) + migration"
```

---

## Task 5: `nodeCanSsh` predicate

**Files:**
- Modify: `apps/server/api/src/lib/node-access.ts`
- Test: `apps/server/api/src/lib/__tests__/node-access.test.ts` (add a describe)

**Interfaces:**
- Produces: `nodeCanSsh(opts: { kind: NodeKind; access: NodeAccess; isAdmin: boolean; serverAccountEnabled: boolean; sshEnabled: boolean }): boolean`. Note the shape mirrors `nodeCanManageFor`, not `nodeCanLaunchOn`: it takes `isAdmin` (the resolver ranks admins at `edit`, never `owner`, so the local-admin exception is invisible in `access` alone) and deliberately has NO `granted` parameter (on `local`, granted access is Everyone-`edit` by the seeded share, and that grant must not confer SSH use).

- [ ] **Step 1: Write the failing tests**

```ts
describe("nodeCanSsh", () => {
  it("refuses when the node's SSH gate is off, whoever the actor is", () => {
    expect(nodeCanSsh({ kind: "agent", access: "owner", isAdmin: false, serverAccountEnabled: true, sshEnabled: false })).toBe(false);
  });
  it("refuses a non-owner even when enabled and shared edit", () => {
    expect(nodeCanSsh({ kind: "agent", access: "edit", isAdmin: false, serverAccountEnabled: true, sshEnabled: true })).toBe(false);
  });
  it("refuses an admin on someone else's node: the boost confers management, never SSH use", () => {
    expect(nodeCanSsh({ kind: "agent", access: "edit", isAdmin: true, serverAccountEnabled: true, sshEnabled: true })).toBe(false);
  });
  it("allows an owner of an enabled agent node", () => {
    expect(nodeCanSsh({ kind: "agent", access: "owner", isAdmin: false, serverAccountEnabled: true, sshEnabled: true })).toBe(true);
  });
  it("allows an admin on the enabled local server (admins resolve to edit, never owner)", () => {
    expect(nodeCanSsh({ kind: "local", access: "edit", isAdmin: true, serverAccountEnabled: true, sshEnabled: true })).toBe(true);
  });
  it("the seeded Everyone edit grant on local does not confer SSH use", () => {
    expect(nodeCanSsh({ kind: "local", access: "edit", isAdmin: false, serverAccountEnabled: true, sshEnabled: true })).toBe(false);
  });
  it("local honors the server-as-node switch", () => {
    expect(nodeCanSsh({ kind: "local", access: "owner", isAdmin: false, serverAccountEnabled: true, sshEnabled: true })).toBe(true);
    expect(nodeCanSsh({ kind: "local", access: "edit", isAdmin: true, serverAccountEnabled: false, sshEnabled: true })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd /home/theo/projects/wt-ssh-anywhere/apps/server/api && env -u SHELLOPTS -u BASHOPTS bun test src/lib/__tests__/node-access.test.ts`
Expected: FAIL (`nodeCanSsh` not exported).

- [ ] **Step 3: Implement it beside `nodeCanLaunchOn`**

```ts
/** Whether this node may be used for Subshell SSH at all (dial out or serve keys).
 * Owner-only, matching who may broker an OS account's credentials, with the same
 * local-node admin exception `nodeCanManageFor` applies (the resolver ranks admins
 * at `edit`, never `owner`, so without `isAdmin` an admin could never USE the
 * server gate they are allowed to enable). Deliberately NOT shaped like
 * `nodeCanLaunchOn`: local's seeded Everyone grant confers launch, never SSH use,
 * so there is no `granted` parameter here to widen it. Gated by the row's
 * ssh_enabled (fail-closed) and, for `local`, the server-as-node switch. A
 * distinct refusal from maintenance/no-launch, so the UI can say why. */
export function nodeCanSsh(opts: {
  kind: NodeKind;
  access: NodeAccess;
  isAdmin: boolean;
  serverAccountEnabled: boolean;
  sshEnabled: boolean;
}): boolean {
  if (!opts.sshEnabled) return false;
  if (opts.kind === "local") {
    return (opts.access === "owner" || opts.isAdmin) && opts.serverAccountEnabled;
  }
  return opts.access === "owner";
}
```

- [ ] **Step 4: Run to confirm pass; commit**

Run then:
```bash
git add apps/server/api/src/lib/node-access.ts apps/server/api/src/lib/__tests__/node-access.test.ts
git commit -m "feat(nodes): nodeCanSsh predicate (owner-only, gated by ssh_enabled)"
```

---

## Task 6: Plane write + view + service + `PUT /:id/ssh-enabled` route

**Files:**
- Modify: `apps/server/api/src/db/repositories/nodes.repository.ts`
- Modify: `apps/server/api/src/api/nodes/node-view.ts`
- Create: `apps/server/api/src/services/nodes/ssh-enabled.ts` (this task: row write + audit; Task 7 adds `pushSetSshEnabled` + `reconcileSshEnabled` to the SAME file)
- Create: `apps/server/api/src/api/nodes/set-node-ssh-enabled.route.ts` (thin gate + service call, exactly like `set-node-maintenance.route.ts` calling `setNodeMaintenance`)
- Modify: `apps/server/api/src/api/nodes/index.ts`
- Modify: `docs/security.md` §10 event list and `.claude/rules/security-context.md` (add `node.ssh_enabled.update` to the nodes audit family)
- Test: `apps/server/api/src/api/nodes/__tests__/set-node-ssh-enabled.route.test.ts`

**Interfaces:**
- Consumes (Task 4): row fields; (Task 5): nothing directly (the view reports the flag; `nodeCanSsh` is consumed by the Plan 2 launch path).
- Produces: `repos.nodes.setSshEnabled(id, { on, changedAt }): Promise<NodeTable | undefined>`; `setNodeSshEnabled(write): Promise<void>` - the ONE site of the change act (row write + audit; Task 7 layers the push into this same function). The route must not write or audit itself: `maintenance.ts`'s own doc comment states the reason - "two implementations of a four-step act is two implementations that drift, and the half that drifts is whichever one nobody exercised"; `apps/server/api/src/services/nodes/maintenance.ts` is the file to mirror;
- `NodeView.sshEnabled: boolean`; route `PUT /api/nodes/:id/ssh-enabled` body `{ on: boolean }` returning the node view.

- [ ] **Step 1: Failing route test (owner on, non-owner refused, audit written, local admin-only)**

Mirror the structure of `set-node-maintenance.route.test.ts`: create a member + a node they own; PUT `{on:true}` as owner -> 200 with `sshEnabled: true` and an audit row action `node.ssh_enabled.update` whose `metadataJson` is the JSON string `"{\"on\":true}"` (no secret, no config values); PUT as a member who neither owns nor is granted the node -> the same 404 the maintenance route gives for invisible rows; PUT as an `edit` grantee -> refused (management of the flag is owner-only even though launch is granted - spec 4.3); PUT `local` as member -> refused, as admin -> 200.

- [ ] **Step 2: Run to confirm it fails**, then **Step 3: implement `setSshEnabled` in the repository** (copy `setMaintenance`'s shape, only `ssh_enabled`/`ssh_enabled_at`, `ssh_enabled: on ? 1 : 0`).

- [ ] **Step 4: add `sshEnabled` to the view** - in `NodeViewSchema` a `sshEnabled: t.Boolean({ description: "…" })`; in `nodeViewBase`, `sshEnabled: row.sshEnabled === 1`. Both list and detail flow through `nodeViewBase`, so one add lands both.

- [ ] **Step 5: write the service, then the route**

`services/nodes/ssh-enabled.ts` (mirror `maintenance.ts`'s audit call exactly - string metadata, `getRequestlessContext()` for repos):

```ts
export interface SshEnabledWrite {
  nodeId: string;
  on: boolean;
  changedAt: string;
  actorUserId: string;
}

/** Flip one node's SSH capability: row, audit, and (from Task 7) the best-effort
 * push - all in this one function, so no caller can perform half the act. */
export async function setNodeSshEnabled(write: SshEnabledWrite): Promise<void> {
  const { repos } = getRequestlessContext();
  await repos.nodes.setSshEnabled(write.nodeId, { on: write.on, changedAt: write.changedAt });
  await audit({
    actorUserId: write.actorUserId,
    action: "node.ssh_enabled.update",
    targetType: "node",
    targetId: write.nodeId,
    metadataJson: JSON.stringify({ on: write.on }),
  });
  // Task 7 appends here: void pushSetSshEnabled(write.nodeId, { on: write.on, changedAt: write.changedAt });
}
```

The route copies `set-node-maintenance.route.ts` (`requireCookieActor` -> `loadNodeGate` -> 404 if missing/invisible -> `if (!gate.canManage)` ForbiddenError -> `await setNodeSshEnabled({ nodeId, on: body.on, changedAt: new Date().toISOString(), actorUserId: user.id })` -> re-read the row -> `toNodeView(row, access, isAdmin, granted)`), with the body schema:

```ts
const SshEnabledBodySchema = t.Object({
  on: t.Boolean({ description: "Allow this machine to be used for Subshell SSH (outbound ssh and serving its keys). Off by default. Owner only; admin on the control-plane host." }),
});
```

Mount it in `api/nodes/index.ts` beside the maintenance route.

- [ ] **Step 6: Run the route test to confirm pass**, then **rebuild backend so the Eden client sees the route**: `cd /home/theo/projects/wt-ssh-anywhere && bunx turbo build --filter=@internal/server --filter=@internal/backend-client`.

- [ ] **Step 7: Audit-event housekeeping** - add `node.ssh_enabled.update` to the event-name list in `docs/security.md` section 10 (beside `node.maintenance.update`) and to the nodes family line in `.claude/rules/security-context.md`; a name that exists in code but not in the list is a list that lies.

- [ ] **Step 8: Commit** (all touched files + the test).

---

## Task 7: Node-side mirror file + `set_ssh_enabled` push + `ready` reporting (fail-closed)

**Files:**
- Create: `apps/node/agent/src/ssh-enabled.ts`
- Create: `apps/node/agent/src/commands/set-ssh-enabled.ts`
- Modify: `apps/node/agent/src/commands/context.ts`, `.../report.ts`, `.../index.ts`, `apps/node/agent/src/daemon.ts`
- Modify: `packages/subshell-protocol/src/node-frames.ts`, `packages/subshell-protocol/src/index.ts`
- Modify: `apps/server/api/src/services/nodes/node-events.ts`, `apps/server/api/src/index.ts`
- Modify: `apps/server/api/src/services/nodes/ssh-enabled.ts` (created in Task 6; this task appends the push and reconcile and enables the push line in `setNodeSshEnabled`)
- Test: `apps/node/agent/src/__tests__/ssh-enabled.test.ts`

**Interfaces:**
- Produces: `sshEnabledPath(dataDir)`, `readSshEnabled(dataDir): {kind:"on"|"absent"|"unreadable", changedAt?}` (absent⇒treated off; unreadable⇒refuse), `writeSshEnabled`, `reportSshEnabled(ctx, state: NodeSshEnabledWire)`, `seedSshEnabledMemo`, `pushSetSshEnabled(nodeId, {on, changedAt})` (no-op for `local`), `reconcileSshEnabled(nodeId, reported)`, protocol `NodeSshEnabledWire`/`parseNodeSshEnabled`/`set_ssh_enabled` arm/`ready.sshEnabled`, and `NODE_PROTOCOL_VERSION` 15 -> 16.

- [ ] **Step 1: Failing node-side test** - `readSshEnabled` on an empty dir → `{kind:"absent"}`; after `writeSshEnabled({on:true})` → `{kind:"on"}`; a chmod-000 (or unreadable) file → `{kind:"unreadable"}`; assert the classifier maps `absent|unreadable` to "SSH refused" and only `on:true` to "allowed".

- [ ] **Step 2: Run to confirm fail.**

- [ ] **Step 3: Implement `apps/node/agent/src/ssh-enabled.ts`** mirroring `maintenance.ts` exactly (same file-permission doctrine 0600 temp+rename, same `MaintenanceRead`-shaped result with `kind`, the `unreadable` fail-closed arm), but: default/absent means **off**, and there is **no self-toggle** (plane is the only writer).

- [ ] **Step 4: Protocol arms + version bump** in `node-frames.ts`: `interface NodeSshEnabledWire { on: boolean; changedAt: string }`, `parseNodeSshEnabled`, a `set_ssh_enabled` command arm, an `ssh_enabled` event arm, and `ready` gains `sshEnabled?: NodeSshEnabledWire` (drop-not-fatal when malformed, like `maintenance`). Then bump `NODE_PROTOCOL_VERSION` 15 -> 16 and add the file's history-comment entry: additive, and breaking anyway, because the link gate is exact-match - pre-16 agents must never be wire-ambiguous about honoring `set_ssh_enabled` (spec 4.3). Re-export from `index.ts`.

- [ ] **Step 5: Agent executor** `commands/set-ssh-enabled.ts` mirroring `set-maintenance.ts`: write the mirror file, set `ctx.lastReportedSshEnabled`, return `{ ok: true }`. Dispatch it in `commands/index.ts`.

- [ ] **Step 6: Reporting** - in `report.ts` add `reportSshEnabled(ctx, state: NodeSshEnabledWire)` (mirror `reportMaintenance(ctx, state)`: the wire carries `{ on, changedAt }`, the `ready` arm cannot be built from `on` alone), `maybeReportSshEnabled(ctx)` (heartbeat belt vs `ctx.lastReportedSshEnabled`), `seedSshEnabledMemo(ctx)`; in `daemon.ts` include `...(sshEnabled ? { sshEnabled } : {})` in `readyEvent`.

- [ ] **Step 7: Plane push + reconcile, into Task 6's file** - append to `services/nodes/ssh-enabled.ts`: `pushSetSshEnabled(nodeId, { on, changedAt })` (`if (nodeId === LOCAL_NODE_ID) return;` then `sendCommand(..., { type: "set_ssh_enabled", ... })` best-effort, mirroring `maintenance.ts`'s push), `reconcileSshEnabled(nodeId, reported)` (plane value is authoritative: if the reported mirror disagrees with the row, push the row value; never adopt from the node). Enable the commented push line inside `setNodeSshEnabled` from Task 6, so the write, the audit, and the push stay one function. Wire `reconcileSshEnabled` into the on-`ready` hooks (`node-events.ts` + `index.ts`), alongside the existing `onMaintenance`.

- [ ] **Step 8: Run all touched tests + build**:
`cd /home/theo/projects/wt-ssh-anywhere && bunx turbo build --filter=@internal/subshell-protocol && cd apps/node/agent && env -u SHELLOPTS -u BASHOPTS bun test src/__tests__/ssh-enabled.test.ts && cd ../../server/api && env -u SHELLOPTS -u BASHOPTS bun test src/services/nodes`
Expected: PASS; node defaults off/unreadable-refuse; local push is a no-op.

- [ ] **Step 9: Commit.**

---

## Task 8: Tier-level verification + changelog

- [ ] **Step 1: Full boundary suite** (per `verification.md`):

```bash
cd /home/theo/projects/wt-ssh-anywhere
bun run verify-types
bun run lint:check
bun run lint:prose
bunx turbo build
bun run test
```

Expected: all green. `verify-types` is what proves the port engines' barrel edits and the new protocol arms typecheck across dependents, and `bun run test` is mandatory here (pre-push does NOT run it, and this plan touched the protocol version every suite reads). Note the protocol bump is safe locally: all consumers import `NODE_PROTOCOL_VERSION` symbolically (verified on main), so no literal `15` asserts exist outside the constant.

- [ ] **Step 2: Focused suite counts** - re-run the protocol, pane-runtime, node-agent, and server/api suites touched above and confirm the FILE COUNTs are non-zero (bun skips bad paths silently).

- [ ] **Step 3: Changeset** - add a minor changeset noting the new `nodes.ssh_enabled` gate (migration 0047) and the ported ssh primitives, so release tooling sees the schema change.

- [ ] **Step 4: Commit** and open the stacked PR:

```bash
git push --no-verify -u origin HEAD
gh pr create --base feat/ssh-anywhere --title "SSH anywhere 1/3: foundations (ssh_enabled gate + ported primitives)" --body "..."
```

(Base is `feat/ssh-anywhere`, the branch below `feat/ssh-anywhere-1` this plan works on - never the repo default. Open the PR; do not merge it without the operator's word.)

---

## Self-Review (author, after writing)

- **Spec coverage:** Plan 1 covers spec §4.3 (the gate), §7 (`ssh_enabled` column), §15 (port grammar + engines + fixture), and the `nodeCanSsh` predicate from §5/§13. It does NOT cover the destination-first UI (§11), the terminal launch, or host-key pinning - those are Plans 2 and 3, by design. No M2 (relay) items leaked in.
- **Type consistency:** the wire type name is `NodeSshEnabledWire` everywhere; the repo method is `setSshEnabled`; the single change-site is `setNodeSshEnabled` (Task 6 creates it write+audit, Task 7 appends the push); the predicate is `nodeCanSsh` (options object, `isAdmin`, no `granted`); the audit action is `node.ssh_enabled.update`; the migration is `0047`; `NODE_PROTOCOL_VERSION` lands at 16. Confirm each before building on it in Plan 2.
- **Placeholders:** every "copy from X"/`git show` step names the exact source and lands in the worktree; new code is shown in full. Export names were verified against `origin/feat/ssh-support`'s files on 2026-10-07 (the engines' symbols, the grammar test's fixtures module, `kysely`'s three-arg `addColumn`, the hand-built migration-test pattern) - if any drifts when the task runs, the build or the test tells you; do not leave a stub.
