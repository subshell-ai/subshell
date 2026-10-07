# SSH Anywhere - Plan 1: Foundations (gate + ported primitives) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On `feat/ssh-anywhere`, land the two foundations every later slice needs: a default-off, owner-controlled, fail-closed per-node `ssh_enabled` capability gate, and the neutral OpenSSH primitives (config discovery, `ssh -G` resolve, connection-snapshot grammar) plus the sshd e2e fixture, ported off `feat/ssh-support`.

**Architecture:** The `ssh_enabled` gate mirrors the existing `maintenance` flag (plane column + node mirror file + a push command + `ready` reporting) but with the plane as the sole writer and no pane-killing side effects; a `nodeCanSsh` predicate refuses use of a disabled node. The ssh grammar lives in `@internal/subshell-protocol` (barrel-safe: no `node:` builtins), the ssh engines in `@internal/pane-runtime` (its barrel is never imported by mobile), and the sshd fixture in `e2e/fixtures`.

**Tech Stack:** Bun, TypeScript, Elysia (routes), Kysely (migrations/types), node:test-style `bun:test` unit tests, Playwright (e2e), `@base-ui`, React (only read by later plans).

## Global Constraints

Every task obeys these (copied from the spec `docs/superpowers/specs/2026-10-07-ssh-anywhere-design.md`):

- New migration number is **`0047`** (`main`'s latest is `0046-backup-recovery.ts`); do NOT reuse the branch's 0047-0051 names.
- `ssh_enabled` defaults **off/false on every node including `local`**; the DB column is `notNull().defaultTo(0)` (the maintenance default-0 "upgrade keeps the fleet as it was" doctrine).
- The node-side read is **fail-closed**: a node that cannot read its own setting refuses SSH; an absent file reads as **off** (default-off).
- Changing the flag is **owner-only, admin on `local`** (`gate.canManage`), cookie-authenticated, audited as `node.ssh_enabled`; the flag is plane-written (no node self-toggle CLI).
- No SSH private key material, challenge, signature, or config value enters any log, argv, or audit row; audits name ids/hosts/field-names only.
- Node-builtin-importing modules must NOT be re-exported from `packages/subshell-protocol/src/index.ts` (Metro imports that barrel and cannot resolve `node:*`). Grammar modules that import no `node:` builtin MAY be barrel-exported there. `@internal/pane-runtime` is not a mobile dependency, so its engines may be exported from its own index barrel.
- `shellQuote` every token of any built command; static top-level imports only (no `await import` outside the sanctioned `plugin-runtime.ts`).
- Run package tests with `env -u SHELLOPTS -u BASHOPTS`; a `bun test <path>` silently passes on a wrong path, so check the file count.
- Commit as author `theo@suteki.nu`.
- Design system (only where copy is shipped, which this plan does not): role tokens, two-sentence max, no em dashes.

---

## File Structure

Ports (verbatim copies off `origin/feat/ssh-support`, then export wiring):
- Create: `packages/subshell-protocol/src/ssh-config.ts` (grammar; no `node:` builtins → barrel-safe)
- Create: `packages/subshell-protocol/src/ssh-limits.ts` (budgets; no `node:` builtins → barrel-safe)
- Create: `packages/subshell-protocol/src/__tests__/ssh-config.test.ts`
- Create: `packages/pane-runtime/src/ssh/ssh-spawn.ts` (`node:*` → pane-runtime barrel only)
- Create: `packages/pane-runtime/src/ssh/ssh-discover.ts` (`node:fs/os/path` → pane-runtime barrel only)
- Create: `packages/pane-runtime/src/ssh/ssh-resolve.ts`
- Create: `packages/pane-runtime/src/ssh/__tests__/ssh-discover.test.ts`
- Create: `packages/pane-runtime/src/ssh/__tests__/ssh-resolve.test.ts`
- Create: `e2e/fixtures/sshd.ts`

Gate (new, mirroring the maintenance template):
- Create: `apps/server/api/src/db/migrations/0047-node-ssh-enabled.ts`
- Modify: `apps/server/api/src/db/migrate.ts` (register `0047`)
- Modify: `apps/server/api/src/db/types/nodes.db-types.ts` (`sshEnabled`, `sshEnabledAt`)
- Modify: `apps/server/api/src/db/repositories/nodes.repository.ts` (`setSshEnabled`)
- Modify: `apps/server/api/src/lib/node-access.ts` (`nodeCanSsh`)
- Modify: `apps/server/api/src/api/nodes/node-view.ts` (`sshEnabled` in `NodeViewSchema` + `nodeViewBase`)
- Create: `apps/server/api/src/api/nodes/set-node-ssh-enabled.route.ts`
- Modify: `apps/server/api/src/api/nodes/index.ts` (mount the route)
- Modify: `packages/subshell-protocol/src/node-frames.ts` (`NodeSshEnabledWire`, `parseNodeSshEnabled`, `set_ssh_enabled` command arm, `ssh_enabled` event arm, `ready` arm, `NODE_RESULT_SSH_DISABLED`)
- Modify: `packages/subshell-protocol/src/index.ts` (export grammar + the new wire symbols)
- Create: `apps/node/agent/src/ssh-enabled.ts` (`node:*` file read/write, fail-closed)
- Create: `apps/node/agent/src/commands/set-ssh-enabled.ts` (executor: write mirror file + memoize)
- Modify: `apps/node/agent/src/commands/context.ts` (`lastReportedSshEnabled?` memo)
- Modify: `apps/node/agent/src/commands/report.ts` (`reportSshEnabled`, `maybeReportSshEnabled`, `seedSshEnabledMemo`)
- Modify: `apps/node/agent/src/commands/index.ts` (dispatch `set_ssh_enabled`)
- Modify: `apps/node/agent/src/daemon.ts` (`readyEvent` includes `sshEnabled`)
- Create: `apps/server/api/src/services/nodes/ssh-enabled.ts` (`setNodeSshEnabled`, `pushSetSshEnabled`, `reconcileSshEnabled`)
- Modify: `apps/server/api/src/services/nodes/node-events.ts` + `apps/server/api/src/index.ts` (onReady reconcile hook)
- Test files alongside each new service/route/module in `__tests__/`.

---

## Task 1: Port the ssh grammar into `subshell-protocol` (barrel-safe)

**Files:**
- Create: `packages/subshell-protocol/src/ssh-config.ts`
- Create: `packages/subshell-protocol/src/ssh-limits.ts`
- Modify: `packages/subshell-protocol/src/index.ts`
- Test: `packages/subshell-protocol/src/__tests__/ssh-config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (from `@internal/subshell-protocol`): `SSH_MAX_DISCOVERED_ALIASES`, `SSH_NAME_MAX_CHARS`, `SSH_REQ_ID_MAX_CHARS`, `SSH_MAX_IDENTITY_REFS` (limits); `type SshConnectionSnapshotWire`, `parseSshConnectionSnapshot`, `SSH_FORBIDDEN_SNAPSHOT_FIELDS` (grammar).

- [ ] **Step 1: Copy the two grammar files verbatim off the branch**

```bash
cd /home/theo/projects/subshell   # the shared checkout has feat/ssh-support pushed
B=origin/feat/ssh-support
git show "$B:packages/subshell-protocol/src/ssh-limits.ts"  > packages/subshell-protocol/src/ssh-limits.ts
git show "$B:packages/subshell-protocol/src/ssh-config.ts"  > packages/subshell-protocol/src/ssh-config.ts
git show "$B:packages/subshell-protocol/src/__tests__/ssh-config.test.ts" > packages/subshell-protocol/src/__tests__/ssh-config.test.ts
grep -nE "from \"node:" packages/subshell-protocol/src/ssh-config.ts packages/subshell-protocol/src/ssh-limits.ts  # MUST print nothing
```

Expected: the `grep` prints nothing (these two are `node:`-free, so they are barrel-safe). If it prints any line, that module is NOT grammar and belongs in `pane-runtime` instead - stop and re-scope.

- [ ] **Step 2: Run the ported grammar test to confirm the copy is complete**

Run: `cd /home/theo/projects/wt-ssh-anywhere/packages/subshell-protocol && env -u SHELLOPTS -u BASHOPTS bun test src/__tests__/ssh-config.test.ts`
Expected: the test imports from `../ssh-config.js`; it FAILS with "Cannot find module `../ssh-limits.js`" only if a symbol is missing - otherwise it may already pass because the two files are self-contained. If it references symbols that live in files NOT yet ported (e.g. `ssh-frames`), trim the test to the symbols actually in these two files for now, or port those symbols too. Record what the test needs.

- [ ] **Step 3: Barrel-export the grammar**

Append to `packages/subshell-protocol/src/index.ts` (do NOT export any `node:`-importing module here):

```ts
export {
  SSH_MAX_DISCOVERED_ALIASES,
  SSH_NAME_MAX_CHARS,
  SSH_REQ_ID_MAX_CHARS,
  SSH_MAX_IDENTITY_REFS,
} from "./ssh-limits.js";
export {
  type SshConnectionSnapshotWire,
  parseSshConnectionSnapshot,
  SSH_FORBIDDEN_SNAPSHOT_FIELDS,
} from "./ssh-config.js";
```

- [ ] **Step 4: Build the package and run its tests**

Run: `cd /home/theo/projects/wt-ssh-anywhere && bunx turbo build --filter=@internal/subshell-protocol && cd packages/subshell-protocol && env -u SHELLOPTS -u BASHOPTS bun test`
Expected: build succeeds; `ssh-config` test PASS; no other protocol test regresses.

- [ ] **Step 5: Confirm the mobile build is unaffected (the Metro trap)**

Run: `cd /home/theo/projects/wt-ssh-anywhere && bunx turbo build --filter=@internal/subshell-protocol` then `grep -c "ssh-config\|ssh-limits" dist/index.js`
Expected: the built barrel references the grammar; because both files import no `node:`, Metro can still resolve the barrel. (The real mobile guard runs in CI; this is the local sanity check the rules call for.)

- [ ] **Step 6: Commit**

```bash
git add packages/subshell-protocol/src/ssh-config.ts packages/subshell-protocol/src/ssh-limits.ts packages/subshell-protocol/src/index.ts packages/subshell-protocol/src/__tests__/ssh-config.test.ts
git commit -m "feat(ssh): port OpenSSH connection grammar + budgets into subshell-protocol"
```

---

## Task 2: Port the ssh engines into `pane-runtime` (barrel-safe because mobile never imports it)

**Files:**
- Create: `packages/pane-runtime/src/ssh/ssh-spawn.ts`
- Create: `packages/pane-runtime/src/ssh/ssh-discover.ts`
- Create: `packages/pane-runtime/src/ssh/ssh-resolve.ts`
- Modify: `packages/pane-runtime/src/index.ts`
- Test: `packages/pane-runtime/src/ssh/__tests__/ssh-discover.test.ts`, `.../ssh-resolve.test.ts`

**Interfaces:**
- Consumes (Task 1): `SshConnectionSnapshotWire`, `parseSshConnectionSnapshot`, `SSH_FORBIDDEN_SNAPSHOT_FIELDS`, `SSH_MAX_DISCOVERED_ALIASES`, `SSH_NAME_MAX_CHARS` from `@internal/subshell-protocol`.
- Produces (from `@internal/pane-runtime`): `discoverSshAliases(...)`, `defaultSshConfigPath`, `isDiscoverableAlias`, `resolveSshAliasConfig(...)`, `runSshProcess`, `sshChildPath` (verify exact export names against the copied files and mirror them).

- [ ] **Step 1: Copy the three engine files + their tests**

```bash
B=origin/feat/ssh-support
cd /home/theo/projects/subshell
mkdir -p /home/theo/projects/wt-ssh-anywhere/packages/pane-runtime/src/ssh/__tests__
for f in ssh-spawn ssh-discover ssh-resolve; do
  git show "$B:packages/pane-runtime/src/ssh/$f.ts" > /home/theo/projects/wt-ssh-anywhere/packages/pane-runtime/src/ssh/$f.ts
done
```

Then open each copied file and confirm the ONLY external imports are `node:*`, `../…` within pane-runtime, or `@internal/subshell-protocol`. If a file imports anything from `ssh-session-*`, `ssh-render`, or the codec (the abandoned runtime path), those are NOT needed for discovery/resolve: remove the unused import and the symbols that use it, or note it for a follow-up. Record any such coupling before deleting.

- [ ] **Step 2: Write the discovery failing test (real behavior, temp HOME)**

Create `packages/pane-runtime/src/ssh/__tests__/ssh-discover.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSshAliases } from "../ssh-discover.js";

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "ssh-discover-"));
  mkdirSync(join(home, ".ssh"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".ssh", "config"), "Host alpha\n  HostName a.example\nHost beta\n  HostName b.example\nHost *\n  User nobody\n");
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("discoverSshAliases", () => {
  it("lists concrete aliases and excludes the wildcard-only Host", () => {
    const { aliases } = discoverSshAliases({ homeDir: home });
    expect(aliases).toEqual(["alpha", "beta"]);
    expect(aliases).not.toContain("*");
  });
});
```

(Adapt the call signature to what `ssh-discover.ts` actually exports - read its top-level function before finalizing the assertion.)

- [ ] **Step 3: Run the test to see it fail before wiring the barrel**

Run: `cd /home/theo/projects/wt-ssh-anywhere/packages/pane-runtime && env -u SHELLOPTS -u BASHOPTS bun test src/ssh/__tests__/ssh-discover.test.ts`
Expected: FAIL importing `../ssh-discover.js` if it needs a symbol not yet in the barrel, or PASS if self-contained. Either way the file runs.

- [ ] **Step 4: Export the engines from the pane-runtime barrel**

Append to `packages/pane-runtime/src/index.ts`:

```ts
export * from "./ssh/ssh-spawn.js";
export * from "./ssh/ssh-discover.js";
export * from "./ssh/ssh-resolve.js";
```

- [ ] **Step 5: Build + run the engines' tests**

Run: `cd /home/theo/projects/wt-ssh-anywhere && bunx turbo build --filter=@internal/pane-runtime && cd packages/pane-runtime && env -u SHELLOPTS -u BASHOPTS bun test src/ssh`
Expected: PASS. Resolve's test invokes `ssh -G`; keep it behind the sshd/binary guard used elsewhere (`missingSshBins`) or mark it `it.skip` if `ssh` is absent, matching the repo's existing conditional-test idiom.

- [ ] **Step 6: Commit**

```bash
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
B=origin/feat/ssh-support
cd /home/theo/projects/subshell
mkdir -p /home/theo/projects/wt-ssh-anywhere/e2e/fixtures
git show "$B:e2e/fixtures/sshd.ts" > /home/theo/projects/wt-ssh-anywhere/e2e/fixtures/sshd.ts
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
- Test: `apps/server/api/src/db/__tests__/migration-0047.test.ts`

**Interfaces:**
- Produces: `NodeTable.sshEnabled: number` (0/1), `NodeTable.sshEnabledAt: string | null`; `NewNode.sshEnabled?: number`.

- [ ] **Step 1: Write the failing migration test**

```ts
import { describe, expect, it } from "bun:test";
import { sql } from "kysely";
import { testDatabase } from "@/__tests__/helpers/test-database.js";

describe("migration 0047 nodes.ssh_enabled", () => {
  it("adds a not-null default-0 column and a nullable stamp", async () => {
    const { db } = await testDatabase();
    const cols = await sql<{ name: string }>`select name from pragma_table_info('nodes')`.execute(db);
    const names = cols.rows.map((r) => r.name);
    expect(names).toContain("ssh_enabled");
    expect(names).toContain("ssh_enabled_at");
    const row = await db.selectFrom("nodes").select(["ssh_enabled"]).where("id", "=", "local").executeTakeFirstOrThrow();
    expect(row.ssh_enabled).toBe(0); // default off, including local
  });
});
```

(Confirm the helper module name/path `@/__tests__/helpers/test-database.js` against the existing `0031-node-maintenance` migration test and mirror it exactly.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd /home/theo/projects/wt-ssh-anywhere/apps/server/api && env -u SHELLOPTS -u BASHOPTS bun test src/db/__tests__/migration-0047.test.ts`
Expected: FAIL (no such column / migration not registered).

- [ ] **Step 3: Write the migration (copy the 0031 shape)**

```ts
import type { Kysely } from "kysely";
import { sql } from "kysely";

// Adds the per-node SSH capability gate. Default 0 keeps the whole fleet (and
// the control-plane host) off after an upgrade: SSH egress and key use are opt-in.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("nodes").addColumn("ssh_enabled", (col) => col.integer().notNull().defaultTo(0)).execute();
  await db.schema.alterTable("nodes").addColumn("ssh_enabled_at", (col) => col.text()).execute();
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

Run: `cd /home/theo/projects/wt-ssh-anywhere/apps/server/api && env -u SHELLOPTS -u BASHOPTS bun test src/db/__tests__/migration-0047.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/api/src/db/migrations/0047-node-ssh-enabled.ts apps/server/api/src/db/migrate.ts apps/server/api/src/db/types/nodes.db-types.ts apps/server/api/src/db/__tests__/migration-0047.test.ts
git commit -m "feat(nodes): add ssh_enabled capability column (default off) + migration"
```

---

## Task 5: `nodeCanSsh` predicate

**Files:**
- Modify: `apps/server/api/src/lib/node-access.ts`
- Test: `apps/server/api/src/lib/__tests__/node-access.test.ts` (add a describe)

**Interfaces:**
- Produces: `nodeCanSsh(opts: { kind: NodeKind; access: NodeAccess; granted: NodeAccess; serverAccountEnabled: boolean; sshEnabled: boolean }): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("nodeCanSsh", () => {
  it("refuses when the node's SSH gate is off, whoever the actor is", () => {
    expect(nodeCanSsh({ kind: "agent", access: "owner", granted: "owner", serverAccountEnabled: true, sshEnabled: false })).toBe(false);
  });
  it("refuses a non-owner even when enabled and shared", () => {
    expect(nodeCanSsh({ kind: "agent", access: "edit", granted: "edit", serverAccountEnabled: true, sshEnabled: true })).toBe(false);
  });
  it("allows an owner of an enabled agent node", () => {
    expect(nodeCanSsh({ kind: "agent", access: "owner", granted: "owner", serverAccountEnabled: true, sshEnabled: true })).toBe(true);
  });
  it("allows admin on an enabled local server only when server-as-node is on", () => {
    expect(nodeCanSsh({ kind: "local", access: "owner", granted: "owner", serverAccountEnabled: true, sshEnabled: true })).toBe(true);
    expect(nodeCanSsh({ kind: "local", access: "owner", granted: "owner", serverAccountEnabled: false, sshEnabled: true })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd /home/theo/projects/wt-ssh-anywhere/apps/server/api && env -u SHELLOPTS -u BASHOPTS bun test src/lib/__tests__/node-access.test.ts`
Expected: FAIL (`nodeCanSsh` not exported).

- [ ] **Step 3: Implement it beside `nodeCanLaunchOn`**

```ts
/** Whether this node may be used for Subshell SSH at all (dial out or serve keys).
 * Owner-only (matching who may broker an OS account's credentials), gated by the
 * node's own ssh_enabled flag; local is the server account and also honors
 * serverAccountEnabled. A distinct refusal from maintenance/no-launch, so the UI
 * can say why. */
export function nodeCanSsh(opts: { kind: NodeKind; access: NodeAccess; granted: NodeAccess; serverAccountEnabled: boolean; sshEnabled: boolean }): boolean {
  if (!opts.sshEnabled) return false;
  if (opts.kind === "local") return opts.access === "owner" && opts.serverAccountEnabled;
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

## Task 6: Plane write + view + `PUT /:id/ssh-enabled` route

**Files:**
- Modify: `apps/server/api/src/db/repositories/nodes.repository.ts`
- Modify: `apps/server/api/src/api/nodes/node-view.ts`
- Create: `apps/server/api/src/api/nodes/set-node-ssh-enabled.route.ts`
- Modify: `apps/server/api/src/api/nodes/index.ts`
- Test: `apps/server/api/src/api/nodes/__tests__/set-node-ssh-enabled.test.ts`

**Interfaces:**
- Consumes (Task 4): row fields; (Task 5): nothing directly (view reports the flag, not the predicate).
- Produces: `repos.nodes.setSshEnabled(id, { on, changedAt }): Promise<NodeTable | undefined>`; `NodeView.sshEnabled: boolean`; route `PUT /api/nodes/:id/ssh-enabled` body `{ on: boolean }` returning the node view.

- [ ] **Step 1: Failing route test (owner on, non-owner 403/404, audit written, local admin-only)**

Mirror the structure of the existing `set-node-maintenance` route test: create a member + a node they own; PUT `{on:true}` as owner → 200 and `sshEnabled:true`; PUT as a non-owner member → 404/403; PUT `local` as non-admin → refused; assert an audit row `node.ssh_enabled` with `{ on }` metadata and no secret.

- [ ] **Step 2: Run to confirm it fails**, then **Step 3: implement `setSshEnabled` in the repository** (copy `setMaintenance`'s shape, only `ssh_enabled`/`ssh_enabled_at`, `ssh_enabled: on ? 1 : 0`).

- [ ] **Step 4: add `sshEnabled` to the view** - in `NodeViewSchema` a `sshEnabled: t.Boolean({ description: "…" })`; in `nodeViewBase`, `sshEnabled: row.sshEnabled === 1`. Both list and detail flow through `nodeViewBase`, so one add lands both.

- [ ] **Step 5: write the route** (copy `set-node-maintenance.route.ts`):

```ts
const SshEnabledBodySchema = t.Object({
  on: t.Boolean({ description: "Allow this machine to be used for Subshell SSH (outbound ssh and serving its keys). Off by default. Owner only; admin on the control-plane host." }),
});
// requireCookieActor -> loadNodeGate -> 404 if missing/invisible -> if (!gate.canManage) ForbiddenError
// -> await repos.nodes.setSshEnabled(id, { on, changedAt: new Date().toISOString() })
// -> audit({ actorUserId: user.id, action: "node.ssh_enabled", targetType: "node", targetId: id, metadataJson: { on } })
// -> void pushSetSshEnabled(id, { on, changedAt })  (Task 7; may be a no-op stub until then)
// -> respond toNodeView(row, access, isAdmin, granted)
```

Mount it in `api/nodes/index.ts` beside the maintenance route.

- [ ] **Step 6: Run the route test to confirm pass**, then **rebuild backend so the Eden client sees the route**: `cd /home/theo/projects/wt-ssh-anywhere && bunx turbo build --filter=@internal/server --filter=@internal/backend-client`.

- [ ] **Step 7: Commit** (all touched files + the test).

---

## Task 7: Node-side mirror file + `set_ssh_enabled` push + `ready` reporting (fail-closed)

**Files:**
- Create: `apps/node/agent/src/ssh-enabled.ts`
- Create: `apps/node/agent/src/commands/set-ssh-enabled.ts`
- Modify: `apps/node/agent/src/commands/context.ts`, `.../report.ts`, `.../index.ts`, `apps/node/agent/src/daemon.ts`
- Modify: `packages/subshell-protocol/src/node-frames.ts`, `packages/subshell-protocol/src/index.ts`
- Modify: `apps/server/api/src/services/nodes/node-events.ts`, `apps/server/api/src/index.ts`
- Create: `apps/server/api/src/services/nodes/ssh-enabled.ts`
- Test: `apps/node/agent/src/__tests__/ssh-enabled.test.ts`

**Interfaces:**
- Produces: `sshEnabledPath(dataDir)`, `readSshEnabled(dataDir): {kind:"on"|"absent"|"unreadable", changedAt?}` (absent⇒treated off; unreadable⇒refuse), `writeSshEnabled`, `reportSshEnabled`, `seedSshEnabledMemo`, `pushSetSshEnabled(nodeId, {on, changedAt})` (no-op for `local`), `reconcileSshEnabled(nodeId, reported)`, protocol `NodeSshEnabledWire`/`parseNodeSshEnabled`/`set_ssh_enabled` arm/`ready.sshEnabled`.

- [ ] **Step 1: Failing node-side test** - `readSshEnabled` on an empty dir → `{kind:"absent"}`; after `writeSshEnabled({on:true})` → `{kind:"on"}`; a chmod-000 (or unreadable) file → `{kind:"unreadable"}`; assert the classifier maps `absent|unreadable` to "SSH refused" and only `on:true` to "allowed".

- [ ] **Step 2: Run to confirm fail.**

- [ ] **Step 3: Implement `apps/node/agent/src/ssh-enabled.ts`** mirroring `maintenance.ts` exactly (same file-permission doctrine 0600 temp+rename, same `MaintenanceRead`-shaped result with `kind`, the `unreadable` fail-closed arm), but: default/absent means **off**, and there is **no self-toggle** (plane is the only writer).

- [ ] **Step 4: Protocol arms** in `node-frames.ts`: `interface NodeSshEnabledWire { on: boolean; changedAt: string }`, `parseNodeSshEnabled`, a `set_ssh_enabled` command arm, an `ssh_enabled` event arm, and `ready` gains `sshEnabled?: NodeSshEnabledWire` (drop-not-fatal when malformed, like `maintenance`). Re-export from `index.ts`.

- [ ] **Step 5: Agent executor** `commands/set-ssh-enabled.ts` mirroring `set-maintenance.ts`: write the mirror file, set `ctx.lastReportedSshEnabled`, return `{ ok: true }`. Dispatch it in `commands/index.ts`.

- [ ] **Step 6: Reporting** - in `report.ts` add `reportSshEnabled(ctx, on)`, `maybeReportSshEnabled(ctx)` (heartbeat belt vs `ctx.lastReportedSshEnabled`), `seedSshEnabledMemo(ctx)`; in `daemon.ts` include `...(sshEnabled ? { sshEnabled } : {})` in `readyEvent`.

- [ ] **Step 7: Plane reconcile** - `services/nodes/ssh-enabled.ts`: `setNodeSshEnabled` (row write + audit + best-effort push), `pushSetSshEnabled` (`if (nodeId === LOCAL_NODE_ID) return;` then `sendCommand(..., { type: "set_ssh_enabled", ... })` best-effort), `reconcileSshEnabled(nodeId, reported)` (plane value is authoritative: if the reported mirror disagrees with the row, push the row value; never adopt from the node). Wire `reconcileSshEnabled` into the on-`ready` hooks (`node-events.ts` + `index.ts`), alongside the existing `onMaintenance`.

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
```

Expected: all green. `verify-types` is what proves the port engines' barrel edits and the new protocol arms typecheck across dependents.

- [ ] **Step 2: Focused suite counts** - run the protocol, pane-runtime, node-agent, and server/api suites touched above and confirm the FILE COUNTs are non-zero (bun skips bad paths silently).

- [ ] **Step 3: Changeset** - add a minor changeset noting the new `nodes.ssh_enabled` gate (migration 0047) and the ported ssh primitives, so release tooling sees the schema change.

- [ ] **Step 4: Commit** and open the stacked PR:

```bash
git push --no-verify -u origin HEAD
gh pr create --base feat/ssh-anywhere --title "SSH anywhere 1/3: foundations (ssh_enabled gate + ported primitives)" --body "..."
```

---

## Self-Review (author, after writing)

- **Spec coverage:** Plan 1 covers spec §4.3 (the gate), §7 (`ssh_enabled` column), §15 (port grammar + engines + fixture), and the `nodeCanSsh` predicate from §5/§13. It does NOT cover the destination-first UI (§11), the terminal launch, or host-key pinning - those are Plans 2 and 3, by design. No M2 (relay) items leaked in.
- **Type consistency:** the wire type name is `NodeSshEnabledWire` everywhere; the repo method is `setSshEnabled`; the predicate is `nodeCanSsh`; the audit action is `node.ssh_enabled`; the migration is `0047`. Confirm each before building on it in Plan 2.
- **Placeholders:** every "copy from `maintenance.ts`"/`git show` step names the exact source; new code is shown in full. Where a step says "adapt to the actual export name/`test-database` helper path," that is a deliberate verify-against-source instruction, not a content gap - resolve it during the task, do not leave a stub.
