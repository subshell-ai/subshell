# Virtual display toggle on a live subshell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person (or an agent over MCP) turn a subshell's virtual display on or off at any time, instead of only at launch: on = persist `screen_config` + in-place restart; off = a new `preview_display_close` wire command that tears the display down without touching the pane.

**Architecture:** `subshells.screen_config` becomes the row's desired screen state (written before applied, on both flips). The on-path reuses the existing restart machinery end to end; the off-path adds one signed node command and one plane teardown route. The broker, the `/views` read, the header indicator, and the viewer all keep working unchanged because they already derive everything from whether a display exists.

**Tech Stack:** Bun + TypeScript monorepo, Elysia routes, Kysely/SQLite, `@internal/subshell-protocol` wire grammar, pane-runtime display providers, MCP core tools, React SPA (`apps/server/web`), bun:test everywhere.

**Spec:** `docs/superpowers/specs/2026-11-06-virtual-display-toggle-design.md` (this repo, same branch — read it first; the plan argues from it).

## Global Constraints

- Work in the worktree `/home/theo/projects/subshell/.claude/worktrees/virtual-display-toggle` (branch `worktree-virtual-display-toggle`). It has no `node_modules` yet; Task 1 Step 1 installs.
- Bun only: `bun install`, `bun run <script>`, `bunx` — never npm/pnpm/npx.
- Run automation shells with `env -u SHELLOPTS -u BASHOPTS`, capture output to a file once, and read failures from the capture: `... > /tmp/out.txt 2>&1; echo exit=$?; grep "(fail)" /tmp/out.txt; tail -4 /tmp/out.txt`.
- Suite runs go through package `test` scripts (they own parallelism and cleanup); a bare `bun test <file>` is fine for one focused file mid-edit. Never a bare `bun test` for a suite run.
- No dynamic imports anywhere (`await import()` banned; the one named exception is `packages/pane-runtime/src/plugin-runtime.ts` and is not touched here).
- No new database column and no migration. `subshells.screen_config` is the only state written.
- Protocol bump rule (`apps/server/api/AGENTS.md`, "Nodes: the plane-side rules"): one commit raises `NODE_PROTOCOL_VERSION`, `MIN_NODE_VERSION`, and `apps/node/agent/package.json` to matching values. New value: protocol **27**, semver floor **3.2.0**.
- Every visible subshell write announces: `publishLive({ kind: "subshell.changed", id })` in the service that owns the act. The on-path's announce is already carried by the restart; the off-path must add its own.
- UI copy: fixed short titles naming the action, no em-dashes (U+2014) in any shipped string or in `apps/docs` prose (`bun run lint:prose` checks); explanations at the decision point; owner restrictions in gold `text-warning`; disabled controls explain themselves.
- Route schemas: every Elysia `t` property gets a `description`; use `t` from elysia; the route declares `systemPermission` like its restart sibling.
- The composed `api-surface-auth.test.ts` suite already owns anonymous/node-key rejection for every guarded route; do NOT duplicate bare-401 cases in the new route tests.
- Tests carry plausible regression value, not per-function coverage (repo testing policy). Fix failures before moving on; never describe a partial run as the full suite.
- Commit messages: plain ASCII, no backticks inside `-m` strings (they expand); use `git commit -m "..."` with single quotes or a message file.
- Changesets rule: never write a changeset for an ignored package (`@internal/server-web` is one); SPA work rides `@internal/server`.

---

### Task 1: Protocol surface — `preview_display_close`, result grammar, version bump

**Files:**
- Modify: `packages/subshell-protocol/src/node-frames.ts` (version block ~205-240, `NodeCommandBody` union ~1325-1330, preview command interfaces + `PREVIEW_COMMAND_TYPES` ~1655-1745, `parseNodeCommand` preview cases ~2419-2431)
- Modify: `packages/subshell-protocol/src/node-results.ts` (beside `parseNodePreviewCloseResult` ~836-853 and `PreviewDisplayReadiness` ~1001+)
- Modify: `packages/subshell-protocol/src/versions.ts` (`MIN_NODE_VERSION` at line 136 and its JSDoc)
- Modify: `apps/node/agent/package.json` (version 3.1.4 → 3.2.0)
- Test: `packages/subshell-protocol/src/__tests__/node-frames.test.ts` (census at ~1940, parser cases beside the `preview_ports_get` group), `packages/subshell-protocol/src/__tests__/node-results.test.ts`, `packages/subshell-protocol/src/__tests__/versions.test.ts`

**Interfaces:**
- Produces: wire member `{ type: "preview_display_close"; paneId: string }`; result `{ closed: boolean }` via `parseNodePreviewDisplayCloseResult(data)`; `NODE_PROTOCOL_VERSION = 27`; `MIN_NODE_VERSION = "3.2.0"`. Tasks 2-4 consume these.

- [ ] **Step 1: Install dependencies in the worktree (once)**

```bash
bun install
```

- [ ] **Step 2: Write the failing parser tests**

In `node-frames.test.ts`, find the census test (near line 1940) that asserts the sorted `PREVIEW_COMMAND_TYPES` list and `toHaveLength(5)`, and update it to the six-member list including `"preview_display_close"` (keep the existing sort order semantics — alphabetical as the file shows it). Then add to the preview command grammar group:

```ts
it("preview_display_close parses a paneId and rebuilds without stray members", () => {
  expect(parseNodeCommand({ type: "preview_display_close", paneId: "pane-1" })).toEqual({
    type: "preview_display_close",
    paneId: "pane-1",
  });
  expect(parseNodeCommand({ type: "preview_display_close", paneId: "" })).toBeNull();
  expect(parseNodeCommand({ type: "preview_display_close" })).toBeNull();
  expect(parseNodeCommand({ type: "preview_display_close", paneId: "p", extra: 1 })).toEqual({
    type: "preview_display_close",
    paneId: "p",
  });
});
```

In `node-results.test.ts`, beside the existing `parseNodePreviewCloseResult` group:

```ts
it("parseNodePreviewDisplayCloseResult accepts only a boolean closed", () => {
  expect(parseNodePreviewDisplayCloseResult({ closed: true })).toEqual({ closed: true });
  expect(parseNodePreviewDisplayCloseResult({ closed: false })).toEqual({ closed: false });
  expect(parseNodePreviewDisplayCloseResult({})).toBeNull();
  expect(parseNodePreviewDisplayCloseResult({ closed: "yes" })).toBeNull();
  expect(parseNodePreviewDisplayCloseResult(null)).toBeNull();
});
```

Add the imports (`parseNodePreviewDisplayCloseResult`) following each file's existing import block style.

- [ ] **Step 3: Run them to verify they fail**

```bash
cd packages/subshell-protocol
env -u SHELLOPTS -u BASHOPTS bun test src/__tests__/node-frames.test.ts src/__tests__/node-results.test.ts > /tmp/proto-out.txt 2>&1; echo exit=$?; grep "(fail)\|error:" /tmp/proto-out.txt | head
```

Expected: import/type errors and the census length failure.

- [ ] **Step 4: Implement the grammar**

In `node-frames.ts`:

a) Append the bump history entry to the `NODE_PROTOCOL_VERSION` doc block (after the 25 -> 26 entry) and raise the constant:

```ts
/**
 * ... (existing entries) ...
 *
 * **26 -> 27:** `preview_display_close` ends a pane's allocated virtual
 * display without touching the pane itself (spec 2026-11-06, live display
 * toggle). Older nodes answer `unsupported`, which the plane maps to "update
 * the node", so the exact-match handshake refuses one before the toggle is
 * ever offered. The version floor and `apps/node/agent/package.json` move to
 * 3.2.0 in this commit, per the versions.ts rule.
 */
export const NODE_PROTOCOL_VERSION = 27;
```

b) In the `NodeCommandBody` union, after the `preview_display_check` member:

```ts
  | PreviewDisplayCloseCommand
```

c) Beside the other preview command interfaces (after `PreviewPortsGetCommand`):

```ts
/** Ends a pane's allocated virtual display without touching the pane. Teardown is never
 *  policy-gated node-side (the preview_close doctrine): a switched-off node must still be
 *  able to free the display. An unallocated pane answers closed:false. */
export interface PreviewDisplayCloseCommand {
  type: "preview_display_close";
  paneId: string;
}
```

d) In `PREVIEW_COMMAND_TYPES`, add `"preview_display_close"` beside the others (comment says a new command must be added HERE and to the dispatcher — the dispatcher is Task 2).

e) In `parseNodeCommand`, beside the `preview_ports_get` case:

```ts
    case "preview_display_close":
      return isStr(value.paneId) ? { type: "preview_display_close", paneId: value.paneId } : null;
```

In `node-results.ts`, beside `parseNodePreviewCloseResult`:

```ts
/** The `preview_display_close` answer: whether an allocated display was actually torn down.
 *  False means there was none — an answer, not a failure (the close is idempotent). */
export interface NodePreviewDisplayCloseResult {
  closed: boolean;
}

/**
 * Validates and narrows a `preview_display_close` answer.
 * @param data - the `data` member of a successful result frame
 * @returns the narrowed answer, or null when malformed
 */
export function parseNodePreviewDisplayCloseResult(data: unknown): NodePreviewDisplayCloseResult | null {
  if (!isRecord(data) || !isBool(data.closed)) return null;
  return { closed: data.closed };
}
```

Export both from `packages/subshell-protocol/src/index.ts` exactly where `PreviewCloseCommand` / `parseNodePreviewCloseResult` are already re-exported.

In `versions.ts`, raise the floor and rewrite its JSDoc's first-sentence context to say it was raised to 3.2.0 with protocol 27 (the display-toggle command) while keeping the existing reasoning shape:

```ts
export const MIN_NODE_VERSION = "3.2.0";
```

And `apps/node/agent/package.json`: `"version": "3.2.0"`.

- [ ] **Step 5: Run the protocol suite, including versions**

```bash
cd packages/subshell-protocol
env -u SHELLOPTS -u BASHOPTS bun test src > /tmp/proto-out.txt 2>&1; echo exit=$?; grep "(fail)" /tmp/proto-out.txt || echo "no failures"; tail -4 /tmp/proto-out.txt
```

If `versions.test.ts` fails on a pinned literal, read what it pins (the floor/pairing rule) and update the pin in the same spirit as the bump. Expected: all pass.

- [ ] **Step 6: Typecheck and commit**

```bash
bun run verify-types   # from packages/subshell-protocol
git add packages/subshell-protocol apps/node/agent/package.json
git commit -m 'feat(protocol): preview_display_close command, grammar, and the 27/3.2.0 bump'
```

---

### Task 2: Node executor — close a display without killing the pane

**Files:**
- Create: `apps/node/agent/src/commands/preview-display-close-exec.ts`
- Modify: `apps/node/agent/src/commands/index.ts` (case beside `preview_display_check` ~line 141)
- Test: `apps/node/agent/src/__tests__/preview-display.test.ts` (new describe block reusing its `onDir`, `makeDeps`, `FakeChild`, `portsCtx` helpers, `PreviewDisplays` subclass, and the `xauthorityPath` path fact)

**Interfaces:**
- Consumes: Task 1's `preview_display_close` wire member; `CommandContext.previewDisplays` (`pane-runtime` `PreviewDisplays`: `openFor(paneId, size)`, `getFor(paneId)`, `closeFor(paneId)`).
- Produces: `{ ok: true, data: { closed: boolean } }` — parsed plane-side by `parseNodePreviewDisplayCloseResult` (Task 3).

- [ ] **Step 1: Write the failing tests**

Append to `preview-display.test.ts`. The file's own idioms (verified against it): `makeDeps()` returns `{ deps, advanceClock }` (feed `deps` to the `PreviewDisplays` subclass defined at the top of the file); allocations omit `provider` (`openFor(PANE, { width: 640, height: 480 })`); the trusted-census sweep idiom is the one at ~lines 915-930 (`makeLaunchCtx` + `ctx.meta = { listComplete: async () => ({ metas: [], scanOk: true }) }` + `runDisplaySweep(ctx, reg)`). Import `execPreviewDisplayClose` from `../commands/preview-display-close-exec.js`; `setPreviewEnabled`, `runDisplaySweep`, `join`, `existsSync`, `STAMP`, `PANE`, `onDir`, `portsCtx`, `makeLaunchCtx`, `SubshellMetaStore` are already imported or defined.

```ts
/* Live toggle (spec 2026-11-06): preview_display_close ends the display, the pane survives. */

describe("preview_display_close (live display toggle)", () => {
  it("closes an allocated display: registry cleared, per-pane state and lock gone", async () => {
    const dataDir = onDir("toggle-close-basic");
    const { deps } = makeDeps();
    const reg = new PreviewDisplays(dataDir, deps);
    await reg.openFor(PANE, { width: 640, height: 480 });
    expect(reg.getFor(PANE)).not.toBeNull();

    const answer = await execPreviewDisplayClose(portsCtx(dataDir, reg), {
      type: "preview_display_close",
      paneId: PANE,
    });
    expect(answer).toEqual({ ok: true, data: { closed: true } });
    expect(reg.getFor(PANE)).toBeNull();
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", PANE))).toBe(false);
    expect(existsSync(xauthorityPath(dataDir, PANE))).toBe(false);
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", ".display-90.lock"))).toBe(false);
  });

  it("answers closed:false for a pane that owns no display, and a repeat says the same", async () => {
    const dataDir = onDir("toggle-close-none");
    const { deps } = makeDeps();
    const reg = new PreviewDisplays(dataDir, deps);
    const cmd = { type: "preview_display_close", paneId: PANE } as const;
    expect(await execPreviewDisplayClose(portsCtx(dataDir, reg), cmd)).toEqual({ ok: true, data: { closed: false } });
    expect(await execPreviewDisplayClose(portsCtx(dataDir, reg), cmd)).toEqual({ ok: true, data: { closed: false } });
  });

  it("teardown is never policy-gated: a switched-off mirror still closes the display", async () => {
    const dataDir = onDir("toggle-close-switched");
    const { deps } = makeDeps();
    const reg = new PreviewDisplays(dataDir, deps);
    await reg.openFor(PANE, { width: 640, height: 480 });
    setPreviewEnabled(dataDir, { on: false, changedAt: STAMP });
    const answer = await execPreviewDisplayClose(portsCtx(dataDir, reg), {
      type: "preview_display_close",
      paneId: PANE,
    });
    expect(answer).toEqual({ ok: true, data: { closed: true } });
    expect(reg.getFor(PANE)).toBeNull();
  });

  it("the sweep cannot resurrect a display the user closed", async () => {
    const dataDir = onDir("toggle-close-sweep");
    const { deps } = makeDeps();
    const reg = new PreviewDisplays(dataDir, deps);
    await reg.openFor(PANE, { width: 640, height: 480 });
    await execPreviewDisplayClose(portsCtx(dataDir, reg), { type: "preview_display_close", paneId: PANE });
    const { ctx } = makeLaunchCtx(dataDir, reg);
    ctx.meta = { listComplete: async () => ({ metas: [], scanOk: true }) } as unknown as SubshellMetaStore;
    await runDisplaySweep(ctx, reg); // trusted census, pane absent: nothing on disk to rehydrate
    expect(reg.getFor(PANE)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/node/agent
env -u SHELLOPTS -u BASHOPTS bun test src/__tests__/preview-display.test.ts > /tmp/node-out.txt 2>&1; echo exit=$?; grep "(fail)\|Cannot find" /tmp/node-out.txt | head
```

Expected: `Cannot find module '../commands/preview-display-close-exec.js'`.

- [ ] **Step 3: Write the executor**

Create `apps/node/agent/src/commands/preview-display-close-exec.ts`:

```ts
import type { JsonValue } from "@internal/subshell-protocol";
import type { Cmd, CommandContext, CommandResult } from "./context.js";

/**
 * Execute `preview_display_close` (spec 2026-11-06): end the display this
 * pane's id owns, leaving the pane itself running. Deliberately NOT
 * policy-gated, the `preview_close` doctrine: the node switch being off (or a
 * provider leaving the enabled set) must never block a teardown, because the
 * refused act would strand Xvfb/x11vnc (or a BetterDisplay screen) on a
 * machine that stopped serving displays. `closeFor` is idempotent across the
 * provider registry, so an unallocated pane is routine: the answer is
 * `closed: false`, not an error. The pre-read of `getFor` is what makes that
 * answer honest; the per-pane open/close queue inside PreviewDisplays keeps
 * it true against a concurrent launch or sweep.
 */
export async function execPreviewDisplayClose(
  ctx: CommandContext,
  cmd: Cmd<"preview_display_close">,
): Promise<CommandResult> {
  if (!ctx.previewDisplays) {
    return { ok: false, error: "preview plumbing unavailable in this daemon context" };
  }
  const closed = ctx.previewDisplays.getFor(cmd.paneId) !== null;
  await ctx.previewDisplays.closeFor(cmd.paneId);
  return { ok: true, data: { closed } as unknown as JsonValue };
}
```

Register in `apps/node/agent/src/commands/index.ts` beside `preview_display_check` (import like `execPreviewClose`):

```ts
      case "preview_display_close":
        return await execPreviewDisplayClose(ctx, cmd);
```

- [ ] **Step 4: Run the test file to verify it passes**

```bash
env -u SHELLOPTS -u BASHOPTS bun test src/__tests__/preview-display.test.ts > /tmp/node-out.txt 2>&1; echo exit=$?; grep "(fail)" /tmp/node-out.txt || echo "no failures"; tail -4 /tmp/node-out.txt
```

Then the package script once, to catch dispatch typing:

```bash
env -u SHELLOPTS -u BASHOPTS bun run test > /tmp/node-suite.txt 2>&1; echo exit=$?; grep "(fail)" /tmp/node-suite.txt || echo "no failures"; tail -4 /tmp/node-suite.txt
```

- [ ] **Step 5: Commit**

```bash
git add apps/node/agent/src/commands/preview-display-close-exec.ts apps/node/agent/src/commands/index.ts apps/node/agent/src/__tests__/preview-display.test.ts
git commit -m 'feat(node): preview_display_close ends a display without touching the pane'
```

---

### Task 3: Plane — service methods, the two routes, and route tests

**Files:**
- Modify: `apps/server/api/src/modules/subshells/subshells.service.ts` (new methods beside `restartSubshell` ~line 1430; update its JSDoc cross-references)
- Modify: `apps/server/api/src/db/types/subshells.db-types.ts` (`screenConfig` doc: "creation input saved for restarts" → desired screen state, written by the toggle routes)
- Create: `apps/server/api/src/api/subshells/set-subshell-screen.route.ts`
- Create: `apps/server/api/src/api/subshells/clear-subshell-screen.route.ts`
- Modify: `apps/server/api/src/api/subshells/index.ts` (mount both)
- Test: `apps/server/api/src/api/subshells/__tests__/subshell-screen-toggle.route.test.ts`

**Interfaces:**
- Consumes: Task 1's `preview_display_close` + `parseNodePreviewDisplayCloseResult`; `sendCommand`/`NodeRpcError` from `@/modules/nodes/node-rpc.js`; `resolveNodeDisplayRequest(nodeId, request, status)` from `@/modules/nodes/display-selection.js`; `isNodeOffline` from `@/modules/nodes/node-registry.js`; `getPreviewBroker().onDisplayClosed(paneId, reason)`; `getLocalPreviewRuntime().displays` (from `@/modules/previews/local-preview.js`); `this.repos.subshells.update(id, { screenConfig })`; `publishLive`.
- Produces: `PUT /api/subshells/:id/screen` and `DELETE /api/subshells/:id/screen`, answered to Task 4 (MCP) and Task 5 (SPA). Service surface: `setSubshellScreen(viewerId, id, request, actor, systemKeyPermissions)`, `clearSubshellScreen(viewerId, id, actor)`.

- [ ] **Step 1: Write the failing route tests**

Create `subshell-screen-toggle.route.test.ts` on the scripted-node fixture exactly as `restart-prompt.route.test.ts` composes it (read that file's `beforeAll` and copy its node/row seeding shape; the scripted sim exposes `cmdsOf`/`countOf`/`detach`):

```ts
/**
 * The live display toggle (spec 2026-11-06). PUT /:id/screen writes the row's
 * desired screen and rides the existing restart to apply it: a refusal
 * anywhere leaves screen_config exactly as it was. DELETE clears the column
 * FIRST (desired-state-first) and then sends preview_display_close, always, so
 * a repeated off converges even after a mid-flight failure. Both flips refuse
 * while the node is offline, at edit access, and an ssh pane refuses like
 * restart refuses. A foreign row is 404; the composed anonymous rejection is
 * owned by api-surface-auth.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { errorHandlerPlugin } from "@/api/middleware/error-handler.plugin.js";
import { subshellRoutes } from "@/api/subshells/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellSharesRepository } from "@/db/repositories/subshell-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { resetNodeRegistryForTests } from "@/modules/nodes/node-registry.js";
import { attachScriptedNode, ok, probeAllAlive, type ScriptedHandlers } from "@/testing/scripted-node.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "@/testing/api/auth-tables.js";
import { randomUUID } from "node:crypto";

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);
const nodes = new NodesRepository(db);
const subshells = new SubshellsRepository(db);
const shares = new SubshellSharesRepository(db);

Build the handlers as the restart-prompt fixture's `lifecycle()` map, verbatim, plus the one new arm — that map is the set the restart path actually sends, and unscripted traffic fails the test loudly:

```ts
function toggleHandlers(): ScriptedHandlers {
  return {
    ...restartLifecycle, // launch/terminate/kill/input/resize/probe/stat_dir/path_exists, exactly as
    // restart-prompt.route.test.ts's lifecycle() scripts them (import its shape by copying the map;
    // use the statDirEcho and probeAllAlive helpers it imports).
    preview_display_close: () => ({ closed: true }),
  };
}
```

Seeding facts, all copied from the two sibling suites (verified in them): users via `UsersRepository.createUser` + `hashPassword` + `signIn` (restart-ssh-refusal's `beforeAll`), the agent node via `await nodes.create({ id: nodeId, ownerUserId: ownerId, name: "toggle-node", kind: "agent", virtualDisplayEnabled: 1 })` (the `restart-preset-swap` suite's node seeding, plus the `create` input's `virtualDisplayEnabled` field, default 0), a dead pane row via `subshells.create` with `{ id, userId: ownerId, harnessId: "claude", name: "toggle", workingDir: tmpdir(), tmuxSocket: null, status: "terminated", alive: 0, nodeId }` (the ssh-refusal file's `seedSshRow` shape; `presetId` stays unset), and a view share via `await shares.replaceForSubshell(id, [{ granteeUserId: viewerId, permission: "view" }], ownerId)`. The scripted attach is `const sim = attachScriptedNode(nodeId, handlers)`; after each test that attached, call `sim.detach()`; `resetNodeRegistryForTests()` and row/user/node cleanup in `afterAll`.

```ts
async function putScreen(id: string, cookie: string, body: unknown) {
  return app.fetch(
    new Request(`http://localhost:3099/api/subshells/${id}/screen`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: `better-auth.session_token=${cookie}` },
      body: JSON.stringify(body),
    }),
  );
}
async function deleteScreen(id: string, cookie: string) {
  return app.fetch(
    new Request(`http://localhost:3099/api/subshells/${id}/screen`, {
      method: "DELETE",
      headers: { cookie: `better-auth.session_token=${cookie}` },
    }),
  );
}

/** One fresh dead row per case (no cross-test row reuse). */
async function seedPane(tag: string, nodeId: string): Promise<string> {
  const id = randomUUID();
  created.push(id);
  await subshells.create({
    id,
    userId: ownerId,
    harnessId: "claude",
    name: `toggle-${tag}`,
    workingDir: tmpdir(),
    tmuxSocket: null,
    status: "terminated",
    alive: 0,
    nodeId,
  });
  return id;
}

describe("PUT /api/subshells/:id/screen", () => {
  it("sets the desired screen and rides the restart: 200, provider pinned on the row, the node sees the screen", async () => {
    const sim = attachScriptedNode(agentNode, toggleHandlers());
    const id = await seedPane("on", agentNode);
    const res = await putScreen(id, ownerCookie, { width: 640, height: 480 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.screen).toEqual({ width: 640, height: 480, provider: "xvfb-x11vnc" }); // the node default
    const row = await subshells.findById(id);
    expect(JSON.parse(row!.screenConfig!)).toEqual({ width: 640, height: 480, provider: "xvfb-x11vnc" });
    expect(sim.cmdsOf("launch").at(-1)?.screen).toEqual({ width: 640, height: 480, provider: "xvfb-x11vnc" });
    sim.detach();
  });

  it("a pane that already wants a display refuses: 409, no restart, column unchanged", async () => {
    const sim = attachScriptedNode(agentNode, toggleHandlers());
    const id = await seedPane("dup", agentNode);
    await subshells.update(id, { screenConfig: JSON.stringify({ width: 800, height: 600, provider: "xvfb-x11vnc" }) });
    const res = await putScreen(id, ownerCookie, { width: 1024, height: 768 });
    expect(res.status).toBe(409);
    expect((await subshells.findById(id))!.screenConfig).toContain("800");
    expect(sim.countOf("launch")).toBe(0);
    sim.detach();
  });

  it("the node switch off refuses with the node's own word and writes nothing", async () => {
    const sim = attachScriptedNode(offNode, toggleHandlers());
    const id = await seedPane("switchoff", offNode);
    const res = await putScreen(id, ownerCookie, { width: 640, height: 480 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain("(preview-node-off)");
    expect((await subshells.findById(id))!.screenConfig).toBeNull(); // the spec's crux: refusal wrote nothing
    sim.detach();
  });

  it("an oversize width is refused at the schema before anything reads the row", async () => {
    const id = await seedPane("huge", agentNode);
    const res = await putScreen(id, ownerCookie, { width: 4097, height: 800 });
    expect(res.status).toBe(400);
    expect((await subshells.findById(id))!.screenConfig).toBeNull();
  });

  it("a view grantee is 403 and a stranger is 404, both leaving the row untouched", async () => {
    const id = await seedPane("access", agentNode);
    await shares.replaceForSubshell(id, [{ granteeUserId: viewerId, permission: "view" }], ownerId);
    expect((await putScreen(id, viewerCookie, { width: 640, height: 480 })).status).toBe(403);
    expect((await putScreen(id, strangerCookie, { width: 640, height: 480 })).status).toBe(404);
    expect((await subshells.findById(id))!.screenConfig).toBeNull();
  });

  it("an offline node refuses before the clear: 409 and no write", async () => {
    const id = await seedPane("offline", agentNode);
    // No attach at all: isNodeOffline reads the registry empty.
    const res = await putScreen(id, ownerCookie, { width: 640, height: 480 });
    expect(res.status).toBe(409);
    expect((await subshells.findById(id))!.screenConfig).toBeNull();
  });
});

describe("DELETE /api/subshells/:id/screen", () => {
  it("clears the desired state first and sends the close the pane owns", async () => {
    const sim = attachScriptedNode(agentNode, toggleHandlers());
    const id = await seedPane("off", agentNode);
    await subshells.update(id, { screenConfig: JSON.stringify({ width: 800, height: 600, provider: "xvfb-x11vnc" }) });
    const res = await deleteScreen(id, ownerCookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { closed: boolean }).closed).toBe(true); // the scripted answer
    expect((await subshells.findById(id))!.screenConfig).toBeNull();
    expect(sim.cmdsOf("preview_display_close")).toEqual([{ type: "preview_display_close", paneId: id }]);
    sim.detach();
  });

  it("with nothing allocated it is still a 200 and still sends the close (repeat-off converges)", async () => {
    const sim = attachScriptedNode(agentNode, toggleHandlers());
    const id = await seedPane("none", agentNode);
    const res = await deleteScreen(id, ownerCookie);
    expect(res.status).toBe(200);
    expect(sim.cmdsOf("preview_display_close").length).toBe(1);
    expect((await subshells.findById(id))!.screenConfig).toBeNull();
    sim.detach();
  });

  it("an offline node refuses BEFORE the clear: the saved wish survives", async () => {
    const id = await seedPane("off-offline", agentNode);
    await subshells.update(id, { screenConfig: JSON.stringify({ width: 800, height: 600, provider: "xvfb-x11vnc" }) });
    const res = await deleteScreen(id, ownerCookie);
    expect(res.status).toBe(409);
    expect((await subshells.findById(id))!.screenConfig).toContain("800");
  });

  it("a view grantee is 403 and a stranger is 404, config intact", async () => {
    const id = await seedPane("off-access", agentNode);
    await subshells.update(id, { screenConfig: JSON.stringify({ width: 800, height: 600, provider: "xvfb-x11vnc" }) });
    await shares.replaceForSubshell(id, [{ granteeUserId: viewerId, permission: "view" }], ownerId);
    expect((await deleteScreen(id, viewerCookie)).status).toBe(403);
    expect((await deleteScreen(id, strangerCookie)).status).toBe(404);
    expect((await subshells.findById(id))!.screenConfig).toContain("800");
  });
});
```

Two seeding details the suites share: declare `let agentNode`, `let offNode` (the second created with `virtualDisplayEnabled: 0`, its own id/name), and keep a module-level `const created: string[]` for row cleanup. `const { randomUUID } = require`-style import comes from `node:crypto` per the file's import block style. The node rows are deleted in `afterAll` (`nodes.deleteById`), the scripted sims detach per test.

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/server/api
env -u SHELLOPTS -u BASHOPTS bun test src/api/subshells/__tests__/subshell-screen-toggle.route.test.ts > /tmp/api-out.txt 2>&1; echo exit=$?; grep "(fail)" /tmp/api-out.txt | head
```

Expected: 404s from the route not existing (the composed app answers the SPA 404 or route-not-found — any non-expected status counts).

- [ ] **Step 3: Service methods**

In `subshells.service.ts`, beside `restartSubshell`, add (imports: `resolveNodeDisplayRequest`, `isNodeOffline`, `sendCommand`/`NodeRpcError`, `parseNodePreviewDisplayCloseResult` and `type VirtualDisplayRequest` from the protocol, `getLocalPreviewRuntime`, `LOCAL_NODE_ID`, `publishLive` — the file already imports `getPreviewBroker` and `publishLive`):

```ts
  /**
   * Turns a subshell's virtual display ON at runtime (spec 2026-11-06): writes
   * the resolved request as the row's desired screen state and applies it with
   * the ordinary in-place restart, because the pane's DISPLAY/XAUTHORITY are
   * baked at spawn. Any refusal rolls the column back, so a flip that never
   * started wrote nothing; a restart that started and then failed mid-revive
   * keeps the desired state (the next restart reallocates). An edit act, like
   * restart itself.
   */
  async setSubshellScreen(
    viewerId: string,
    id: string,
    request: VirtualDisplayRequest,
    actor: GuardActor,
    systemKeyPermissions: ApiKeyPermission[] | null = null,
  ): Promise<{ ok: true; screen: VirtualDisplayRequest & { provider: string } }> {
    const { row } = await this.#gate(viewerId, id, "edit", actor);
    if (row.ssh !== null) {
      throwApiError({
        code: BackendErrorCodes.SSH_NO_RESTART,
        message: "SSH panes do not have virtual displays; launch a new one to reconnect",
        doNotLog: true,
      });
    }
    if (row.screenConfig) {
      throwApiError({
        code: BackendErrorCodes.RESTART_IN_FLIGHT,
        message: "This subshell already has a virtual display. Turn it off first to change its provider or size.",
        doNotLog: true,
      });
    }
    // Offline refuses up front: the restart would refuse anyway, and the spec
    // keeps the row honest about what a dead node is currently running.
    if (row.nodeId !== LOCAL_NODE_ID && isNodeOffline(row.nodeId)) {
      throwApiError({
        code: BackendErrorCodes.NODE_OFFLINE,
        message: "This node is offline, but the subshell may still be running on it. Bring it online and toggle again.",
        doNotLog: true,
      });
    }
    const resolved = await resolveNodeDisplayRequest(row.nodeId, request, 409);
    const prior = row.screenConfig;
    await this.repos.subshells.update(id, { screenConfig: JSON.stringify(resolved) });
    try {
      // The restart carries every launch gate (lockdown, maintenance, local
      // switch) and announces the act; a refused one lands in the catch below.
      await this.restartSubshell(viewerId, id, actor, undefined, undefined, systemKeyPermissions);
    } catch (err) {
      await this.repos.subshells.update(id, { screenConfig: prior });
      throw err;
    }
    return { ok: true, screen: resolved };
  }

  /**
   * Turns a subshell's virtual display OFF at runtime (spec 2026-11-06):
   * clears the desired state FIRST, then tears the display down — on the node
   * for an agent row, directly for the built-in `local` one. Clearing first is
   * what makes a mid-flight failure converge rather than lie: the row never
   * wants a screen the user just dismissed, and the close is sent on EVERY
   * call (even with no config), so a repeated off finishes what a dropped one
   * left. The pane keeps running with its now-stale DISPLAY until it next
   * restarts; the docs say so out loud.
   */
  async clearSubshellScreen(
    viewerId: string,
    id: string,
    actor: GuardActor,
  ): Promise<{ ok: true; closed: boolean }> {
    const { row } = await this.#gate(viewerId, id, "edit", actor);
    if (row.ssh !== null) {
      throwApiError({
        code: BackendErrorCodes.SSH_NO_RESTART,
        message: "SSH panes do not have virtual displays; launch a new one to reconnect",
        doNotLog: true,
      });
    }
    if (row.nodeId !== LOCAL_NODE_ID && isNodeOffline(row.nodeId)) {
      throwApiError({
        code: BackendErrorCodes.NODE_OFFLINE,
        message: "This node is offline, but its display may still be running. Bring it online and turn it off again.",
        doNotLog: true,
      });
    }
    await this.repos.subshells.update(id, { screenConfig: null });
    publishLive({ kind: "subshell.changed", id });
    try {
      if (row.nodeId === LOCAL_NODE_ID) {
        const had = getLocalPreviewRuntime().displays.getFor(id) !== null;
        await getLocalPreviewRuntime().displays.closeFor(id);
        if (had) await getPreviewBroker().onDisplayClosed(id, "revoked");
        return { ok: true, closed: had };
      }
      const parsed = parseNodePreviewDisplayCloseResult(
        await sendCommand(row.nodeId, { type: "preview_display_close", paneId: id }),
      );
      // A malformed answer means the node predates the grammar (the version
      // gate should have held it); the display was asked to close regardless.
      const closed = parsed?.closed ?? false;
      if (closed) await getPreviewBroker().onDisplayClosed(id, "revoked");
      return { ok: true, closed };
    } catch (err) {
      if (err instanceof NodeRpcError) {
        throwApiError({
          code: BackendErrorCodes.NODE_OFFLINE,
          message: "The node dropped while its display was closing. The screen is cleared from the subshell; turn it off again once the node reconnects to free the processes.",
          doNotLog: true,
        });
      }
      throw err;
    }
  }
```

Adjust nothing in `restartSubshell`; the reuse is the design. If `BackendErrorCodes` has no reusable `RESTART_IN_FLIGHT`-family word that reads right for "already has a display", check the file for a closer code first; `RESTART_IN_FLIGHT` is chosen because the toggle IS a restart act and the SPA only needs the 409 — say so in the throw's comment if you keep it.

- [ ] **Step 4: Routes**

`set-subshell-screen.route.ts`:

```ts
import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/api/middleware/context.plugin.js";
import { apiModels } from "@/api/schemas/index.js";
import { VirtualDisplayRequestSchema } from "@/api/schemas/virtual-display.js";

/**
 * `PUT /api/subshells/:id/screen` — turn a live subshell's virtual display on
 * (spec 2026-11-06): the request becomes the row's desired screen state and
 * the subshell restarts in place to pick it up (same id, log retained, the
 * conversation resumes when the harness supports resume). A refusal at any
 * gate — visibility, edit access, ssh pane, an already-set display, the node
 * being offline, the node's own display policy — writes nothing.
 */
export const setSubshellScreenRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .put(
    "/:id/screen",
    async ({ params, body, user, actor, apiKeyPermissions, systemKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      return await ctx.services.subshells.setSubshellScreen(
        user.id,
        params.id,
        { width: body.width, height: body.height, ...(body.provider ? { provider: body.provider } : {}) },
        actor,
        systemKeyPermissions,
      );
    },
    {
      body: VirtualDisplayRequestSchema,
      response: {
        200: t.Object({
          ok: t.Literal(true, { description: "The display was set as desired state and the restart started" }),
          screen: t.Object({
            width: t.Number({ description: "The persisted display width" }),
            height: t.Number({ description: "The persisted display height" }),
            provider: t.String({ description: "The provider the plane pinned for this subshell" }),
          }),
        }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      systemPermission: "subshells:execute",
      detail: {
        operationId: "setSubshellScreen",
        tags: ["subshells"],
        description:
          "Give this subshell a virtual display now: stores the screen request as desired state and restarts the subshell in place so its process starts with the display. Refused while the node is offline or when a display is already set; a refusal changes nothing",
      },
    },
  );
```

If `VirtualDisplayRequestSchema` carries a `description` that fights the `body:` slot, wrap it: `t.Object({ ...VirtualDisplayRequestSchema.properties })` is NOT the way — import and pass it directly and adjust nothing; validation is the point.

`clear-subshell-screen.route.ts`:

```ts
import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/api/middleware/context.plugin.js";
import { apiModels } from "@/api/schemas/index.js";

/**
 * `DELETE /api/subshells/:id/screen` — turn a live subshell's virtual display
 * off (spec 2026-11-06): the desired state clears first, then the node closes
 * the display and frees its memory and CPU; the pane keeps running. Idempotent
 * by design — a pane with no display answers success, and the close command
 * rides every call so a repeated off converges after a dropped one. Refused
 * only at visibility, access, the ssh refusal, or an offline node, all before
 * anything is written.
 */
export const clearSubshellScreenRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .delete(
    "/:id/screen",
    async ({ params, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      return await ctx.services.subshells.clearSubshellScreen(user.id, params.id, actor);
    },
    {
      response: {
        200: t.Object({
          ok: t.Literal(true, { description: "The desired screen state is cleared" }),
          closed: t.Boolean({ description: "Whether a display was actually allocated and has been torn down" }),
        }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      systemPermission: "subshells:execute",
      detail: {
        operationId: "clearSubshellScreen",
        tags: ["subshells"],
        description:
          "End this subshell's virtual display while it keeps running: clears the saved screen and closes the allocated display, freeing its memory and CPU. Repeat-safe",
      },
    },
  );
```

Mount both in `src/api/subshells/index.ts` beside the other pane doors (`.use(setSubshellScreenRoute).use(clearSubshellScreenRoute)`).

Also update `src/db/types/subshells.db-types.ts` `screenConfig` JSDoc to: stored JSON `{width,height,provider}` provider-pinned; the row's DESIRED screen state (spec 2026-11-06) — written at create and by the toggle routes, read by every restart; null = no display wanted.

- [ ] **Step 5: Run the new suite, then the package once**

```bash
env -u SHELLOPTS -u BASHOPTS bun test src/api/subshells/__tests__/subshell-screen-toggle.route.test.ts > /tmp/api-out.txt 2>&1; echo exit=$?; grep "(fail)" /tmp/api-out.txt || echo "no failures"; tail -4 /tmp/api-out.txt
```

Iterate to green. Then `env -u SHELLOPTS -u BASHOPTS bun run test` for the package (capture + grep as in Global Constraints). A scoped-bearer note: the route declares `systemPermission: "subshells:execute"` like restart, so `api-surface-auth.test.ts` needs no inventory edit; if it fails, read what it demands before touching it.

- [ ] **Step 6: Commit**

```bash
git add apps/server/api
git commit -m 'feat(api): PUT and DELETE /api/subshells/:id/screen toggle the live virtual display'
```

---

### Task 4: MCP — `set_subshell_display` and the refusal pointer

**Files:**
- Modify: `packages/mcp-core/src/view-tools.ts` (new schema + handler; the `openSubshellView` refusal text ~lines 146-152)
- Modify: `packages/mcp-core/src/server.ts` (register beside `watch_subshell_browser` ~line 204)
- Test: `packages/mcp-core/src/__tests__/view-tools.test.ts` (fixture idiom already in the file), `packages/mcp-core/src/__tests__/server.test.ts` (the pinned tool-name set ~line 55)

**Interfaces:**
- Consumes: Task 3's two routes.
- Produces: MCP tool `set_subshell_display`.

- [ ] **Step 1: Write the failing tests**

In `view-tools.test.ts`:

```ts
it("set_subshell_display PUTs the request and DELETEs on null", async () => {
  const { deps, calls } = fixture(() => ({ ok: true }));
  await setSubshellDisplay(deps, { subshell_id: "s-1", screen: { width: 1280, height: 800 } });
  expect(calls[0]).toMatchObject({
    path: "/api/subshells/s-1/screen",
    method: "PUT",
    body: { width: 1280, height: 800 },
  });
  await setSubshellDisplay(deps, { subshell_id: "s-1", screen: null });
  expect(calls[1]).toMatchObject({ path: "/api/subshells/s-1/screen", method: "DELETE" });
});

it("set_subshell_display requires an explicit screen choice", () => {
  expect(SetSubshellDisplaySchema.safeParse({ subshell_id: "s-1" }).success).toBe(false);
  expect(
    SetSubshellDisplaySchema.safeParse({ subshell_id: "s-1", screen: { width: 4097, height: 800 } }).success,
  ).toBe(false);
});
```

In `server.test.ts`, add `"set_subshell_display"` to the pinned name set (read the surrounding expectation first; it is an exhaustive set).

- [ ] **Step 2: Run to verify failure**

```bash
cd packages/mcp-core
env -u SHELLOPTS -u BASHOPTS bun test src/__tests__/view-tools.test.ts src/__tests__/server.test.ts > /tmp/mcp-out.txt 2>&1; echo exit=$?; grep "(fail)\|Cannot find" /tmp/mcp-out.txt | head
```

- [ ] **Step 3: Implement**

`view-tools.ts` (imports: add `setSubshellDisplay`, `SetSubshellDisplaySchema` to exports; reuse `ScreenSchema`):

```ts
export const SetSubshellDisplaySchema = z.object({
  subshell_id: z.string().min(1),
  screen: ScreenSchema.nullable().describe(
    "A {width,height,provider?} request turns the display ON: the subshell restarts in place and its process starts holding the new screen (resuming harnesses continue the conversation). null turns it OFF immediately without a restart; apps drawing on the screen close and the node frees its memory and CPU. Both flips refuse while the node is offline",
  ),
});

/**
 * Toggle a live subshell's virtual display (spec 2026-11-06). Enabling
 * restarts the pane's process, so calling this on the pane you run in kills
 * the tool call with it — the way restart_subshell already does; the tool
 * description carries the warning, the HTTP semantics belong to the routes.
 */
export async function setSubshellDisplay(
  deps: ToolDeps,
  args: z.infer<typeof SetSubshellDisplaySchema>,
): Promise<unknown> {
  const path = `/api/subshells/${encodeURIComponent(args.subshell_id)}/screen`;
  if (args.screen === null) return deps.api.req(path, { method: "DELETE" });
  return deps.api.req(path, { method: "PUT", body: args.screen });
}
```

Registration in `server.ts`, beside `watch_subshell_browser`:

```ts
  server.registerTool(
    "set_subshell_display",
    {
      title: "Set subshell display",
      description:
        "Turn a live subshell's virtual display on or off without recreating it. Pass screen {width,height,provider?} to enable — the subshell restarts in place (same id and history; resuming harnesses continue the conversation) because a running process cannot be handed a new DISPLAY. Pass screen:null to disable — the display closes immediately and the pane keeps running, though processes started before this call keep a stale DISPLAY until the next restart. Enabling your OWN pane ends this tool call with the restart, like restart_subshell. Check get_node first for provider readiness. Both flips refuse while the node is offline.",
      inputSchema: SetSubshellDisplaySchema,
    },
    guard((args: z.infer<typeof SetSubshellDisplaySchema>) => setSubshellDisplay(deps, args)),
  );
```

And the `openSubshellView` refusal, replace the `!info.nodeEnabled || !info.screen` message with:

```ts
      throw new Error(
        "subshell: this subshell has no available virtual display; call set_subshell_display to turn one on (it restarts the subshell), or check get_node for provider requirements",
      );
```

- [ ] **Step 4: Run to verify pass**

```bash
env -u SHELLOPTS -u BASHOPTS bun run test > /tmp/mcp-out.txt 2>&1; echo exit=$?; grep "(fail)" /tmp/mcp-out.txt || echo "no failures"; tail -4 /tmp/mcp-out.txt
```

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-core
git commit -m 'feat(mcp): set_subshell_display toggles a live subshell virtual display'
```

---

### Task 5: SPA — the toggle in the "Open web preview or screen" picker

**Files:**
- Modify: `apps/server/web/src/lib/subshell-confirmations.ts` (two prompts)
- Create: `apps/server/web/src/components/preview/display-toggle.tsx`
- Modify: `apps/server/web/src/components/subshell-picker/virtual-display-field.tsx` (one added optional prop `disabledReason?: string`)
- Modify: `apps/server/web/src/components/preview/preview-chooser-dialog.tsx` (render the row)
- Test: `apps/server/web/src/components/preview/__tests__/display-toggle.test.tsx`

**Interfaces:**
- Consumes: Task 3's routes via `apiFetch`; `useSubshellPreview`'s `PreviewInfo` (`screen`, `virtualDisplayEnabled`, `nodeEnabled`, `reason`); `previewInfoQueryKey`; `VirtualDisplayField` + `useNodes`.
- Produces: nothing later tasks consume.

- [ ] **Step 1: Confirmations**

Append to `subshell-confirmations.ts`:

```ts
/**
 * Confirmation before turning a live subshell's virtual display ON
 * (spec 2026-11-06): enabling restarts its process, so the sentence is the
 * restart prompt's honest consequence, not a surprise after the click.
 */
export function confirmEnableVirtualDisplay(name: string): Promise<boolean> {
  return confirmAction({
    title: "Enable virtual display?",
    description: `"${name}" restarts to pick up the new screen: its process stops and starts again. Whether the agent can resume its conversation depends on the agent and its saved history.`,
    confirmLabel: "Enable display",
    danger: true,
  });
}

/** Confirmation before turning the display OFF: what's drawn on it dies. */
export function confirmDisableVirtualDisplay(name: string): Promise<boolean> {
  return confirmAction({
    title: "Turn off virtual display?",
    description: `Anything running on "${name}"'s virtual screen closes, and the node frees the memory and CPU it uses. The subshell keeps running.`,
    confirmLabel: "Turn off display",
    danger: true,
  });
}
```

- [ ] **Step 2: `disabledReason` on the field**

In `virtual-display-field.tsx`, add prop `disabledReason?: string` and, in the `control` render, extend the existing tooltip branch condition to `reason || disabledReason` (the tooltip content picks `disabledReason ?? reason`), and disable the Checkbox with `disabled={(Boolean(reason) || Boolean(disabledReason)) && !checked}` — a checked box stays live so a view-only grantee can still read the on state. Document the prop: "Why this control is off-limits for THIS viewer (access, not availability): the tooltip names it; availability reasons come from readiness."

- [ ] **Step 3: Write the failing component test**

`__tests__/display-toggle.test.tsx`, idiom from `preview-settings-dialog.test.tsx` (QueryClientProvider wrap, `globalThis.fetch` stub, `afterEach(cleanup)`):

```ts
/**
 * The picker's Virtual display row (spec 2026-11-06): the on/off flip rides
 * PUT/DELETE /:id/screen, always through the confirmation prompt, and the
 * caches that render the row's truth are invalidated after it.
 */
import { afterEach, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { NodesQueryMock } from "./display-toggle-test-helpers"; // see node-stub note below
import type { PreviewInfo } from "@/hooks/use-subshell-preview";
import { DisplayToggle } from "../display-toggle";

const offInfo: PreviewInfo = { nodeEnabled: true, ports: [], cdpPort: null, screen: null };
const onInfo: PreviewInfo = {
  ...offInfo,
  screen: { display: ":91", viewer: { protocol: "vnc", port: 5910 } },
};
const subshell = { id: "s-1", name: "worker", nodeId: "n-1", access: "owner", status: "running", alive: 1 };

function renderToggle(info: PreviewInfo, access: "owner" | "view" = "owner") {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <DisplayToggle subshellId="s-1" subshell={{ ...subshell, access }} info={info} />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}
```

The confirmation is driven through the real `ConfirmProvider` dialog, exactly as `routes/__tests__/settings-plugins.test.tsx` does for install-by-name (it asserts the dialog's body copy, then clicks its confirm button by role and name) - no seam, no stub of `confirmAction`. The node list the component reads comes from `useNodes` → `apiFetch("/api/nodes")`: stub `globalThis.fetch` to answer `{ nodes: [nodeFixture] }` for that path and record the toggle's own PUT/DELETE calls (the `preview-settings-dialog.test.tsx` fetch-stub idiom), and delete the helper import above if you inline the fixture instead of extracting it (recommended: inline).

Cases to write as real `it` bodies:
1. **off + owner, full flip:** control unchecked; clicking it opens the dialog whose title is "Enable virtual display?"; clicking "Cancel" (or closing) sends NO fetch to `/screen`; reopening and clicking the confirm button ("Enable display") records a fetch to `/api/subshells/s-1/screen` with `method: "PUT"` and a body of `{ width: 1280, height: 800 }` (provider omitted = node default). Await the recorded call (`waitFor`).
2. **on + owner, flip off:** the control reads checked; clicking opens "Turn off virtual display?"; confirming records `method: "DELETE"` to the same path.
3. **view access:** the control is aria-disabled and its accessible name/description contains "edit access".
4. **node switch off** (`virtualDisplayEnabled: false` on the node fixture): the field's existing reason/setup-link copy renders; clicking produces no PUT.

- [ ] **Step 4: Implement the component and wire it**

`display-toggle.tsx`:

```ts
import { apiFetch } from "@internal/node-admin";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { VirtualDisplayField } from "@/components/subshell-picker/virtual-display-field";
import { previewInfoQueryKey, type PreviewInfo } from "@/hooks/use-subshell-preview";
import { useNodes } from "@/hooks/use-nodes";
import { SUBSHELLS_QUERY_KEY, SUBSHELL_QUERY_KEY, WORKSPACE_QUERY_KEY } from "@/lib/query-keys";
import { confirmDisableVirtualDisplay, confirmEnableVirtualDisplay } from "@/lib/subshell-confirmations";
import type { SubshellView } from "@/types/subshell";

/**
 * The picker's Virtual display row (spec 2026-11-06). Off: the launch form's
 * own control, checked means "enable it" - the click confirms (the pane
 * restarts) and PUTs the request the field selected, with the launch form's
 * default size. On: unchecked means "turn it off" after its own confirm; the
 * display's processes close and the node frees them, the pane keeps running.
 * Both paths invalidate the preview and row caches the moment they land; the
 * restart's own live frames and the info poll make the row honest after.
 */
export function DisplayToggle({
  subshellId,
  subshell,
  info,
  onBusyChange,
}: {
  subshellId: string;
  subshell: SubshellView;
  info: PreviewInfo;
  onBusyChange?: (busy: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { data } = useNodes();
  const node = data?.nodes.find((n) => n.id === subshell.nodeId) ?? null;
  const [provider, setProvider] = useState<string | undefined>(undefined);
  const on = info.screen !== null;
  const mutate = useMutation({
    mutationFn: (enable: boolean) =>
      enable
        ? apiFetch(`/api/subshells/${subshellId}/screen`, {
            method: "PUT",
            body: JSON.stringify({ width: 1280, height: 800, ...(provider ? { provider } : {}) }),
          })
        : apiFetch(`/api/subshells/${subshellId}/screen`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: previewInfoQueryKey(subshellId) });
      // The row itself is the toggle's other read (the header badge, the
      // sidebar), and the restart moves the pane through workspaces: same
      // refresh set use-subshell-mutations' restart uses, for the same reason.
      void queryClient.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: SUBSHELL_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
    },
    onFinally: () => onBusyChange?.(false),
  });
  async function flip(wantOn: boolean) {
    onBusyChange?.(true);
    const ok = wantOn
      ? await confirmEnableVirtualDisplay(subshell.name)
      : await confirmDisableVirtualDisplay(subshell.name);
    if (!ok) {
      onBusyChange?.(false);
      return;
    }
    mutate.mutate(wantOn);
  }
  return (
    <VirtualDisplayField
      node={node}
      id={`preview-display-${subshellId}`}
      checked={on}
      onChange={(checked) => void flip(Boolean(checked))}
      provider={provider}
      onProviderChange={on ? undefined : setProvider}
      disabledReason={
        subshell.access === "view" ? "Turning a virtual display on or off needs edit access to this subshell." : undefined
      }
    />
  );
}
```

In `preview-chooser-dialog.tsx`, render it inside the `info && subshell &&` fragment after `<PortList ... />`:

```tsx
            {info && subshell && (
              <DisplayToggle subshellId={subshellId} subshell={subshell} info={info} onBusyChange={setBusy} />
            )}
```

(Exact placement: after PortList's block, before the "No apps or screens discovered" paragraph, so the row shows even when PortList renders nothing.)

- [ ] **Step 5: Run to green, then the web package once**

```bash
cd apps/server/web
env -u SHELLOPTS -u BASHOPTS bun test src/components/preview/__tests__/display-toggle.test.tsx > /tmp/spa-out.txt 2>&1; echo exit=$?; grep "(fail)" /tmp/spa-out.txt || echo "no failures"; tail -4 /tmp/spa-out.txt
```

Then `env -u SHELLOPTS -u BASHOPTS bun run test` and `bun run verify-types` for the package (captures, grep per Global Constraints). If the existing `port-list.test.tsx` or dialog-side snapshots broke on the new row, fix assertions to the new truth, never delete coverage.

- [ ] **Step 6: Commit**

```bash
git add apps/server/web
git commit -m 'feat(web): the view picker toggles a live subshell virtual display'
```

---

### Task 6: Documentation and the changeset

**Files:**
- Modify: `apps/docs/content/docs/previews/setup.mdx`, `previews/linux.mdx`, `previews/macos.mdx`, `previews/agents.mdx`, `mcp/tools.mdx`, `reference/node-protocol.mdx`
- Create: `.changeset/virtual-display-toggle.md`

- [ ] **Step 1: Prose edits** (voice: conversational, contractions, no em-dashes, verified control labels; check every UI label you name against the implementation from Tasks 3-5)

`previews/linux.mdx` — after the numbered "Launch and open a display" list, add:

```markdown
## Turn the display on or off later

You don't need a new subshell to change its screen. Open the subshell header's
Web previews & screens icon and use the **Virtual display** toggle:

- Turning it on restarts the subshell's process so it starts holding the new
  screen. Its history stays, and agents that support resume continue the
  conversation.
- Turning it off closes the screen right away and frees the memory and CPU it
  used. Apps running on the screen close; the subshell keeps working.
- Changing the size or provider means off, then on again.

Both flips need edit access to the subshell, and the node's virtual display
settings still apply. After turning a display off, programs that were already
running keep a stale display setting until the subshell next restarts.
```

`previews/setup.mdx` — extend the existing "Each subshell saves its provider and display size for restarts" paragraph with one more sentence: "That saved choice is now the subshell's live wish list, not a launch-time memory: the picker's **Virtual display** toggle updates it, and every restart reads it."

`previews/macos.mdx` — mirror the on/off section with its helper words ("turning it off stops the screen for the helper too; the Disable helper rules still apply"); read the page first and match its terminology.

`previews/agents.mdx` — one paragraph: an agent can ask for its own screen with the MCP `set_subshell_display` tool, and enabling its own pane ends that tool call with the restart (it resumes by the harness's own means).

`mcp/tools.mdx` — add the `set_subshell_display` entry in the same shape as its siblings: input `{subshell_id, screen | null}`, the enable-restarts/disable-keeps-running consequence, offline refusal.

`reference/node-protocol.mdx` — the signed-command table already carries a `preview_display_check` row (~line 211); add beside it:

```markdown
| `preview_display_close` | End a subshell's allocated virtual display without touching the pane; an unallocated pane answers `closed: false`. |
```

- [ ] **Step 2: Prose validation**

```bash
env -u SHELLOPTS -u BASHOPTS bun run lint:prose
env -u SHELLOPTS -u BASHOPTS bun run --cwd apps/docs test
```

Fix what they name (dashes, broken links, missing frontmatter). These are the checks a documentation-only change runs; no product suites for prose.

- [ ] **Step 3: The changeset**

Create `.changeset/virtual-display-toggle.md`:

```markdown
---
"@internal/server": minor
"@internal/node": minor
---

Turn a running subshell's virtual display on or off from the Web previews &
screens picker, or with the new set_subshell_display MCP tool. Turning a display
on restarts the subshell in place so its process starts on the new screen;
turning one off closes the screen immediately and frees the machine's memory
and CPU while the subshell keeps running. Nodes and the server must update
together (protocol 27).
```

(Protocol/pane-runtime/mcp-core work rides these two apps; `@internal/server-web` is changeset-ignored and its work is named here, per the rules.)

- [ ] **Step 4: Commit**

```bash
git add apps/docs .changeset
git commit -m 'docs: the virtual display toggle, its agent path, and the changeset'
```

---

### Task 7: Boundary verification and handoff

- [ ] **Step 1: The planner, then the affected build/test/lint sweep**

From the worktree root:

```bash
env -u SHELLOPTS -u BASHOPTS bun run test:changed -- --plan
env -u SHELLOPTS -u BASHOPTS bun run verify:changed > /tmp/verify-out.txt 2>&1; echo exit=$?; grep "(fail)\|error TS\|ERROR" /tmp/verify-out.txt | head -20; tail -6 /tmp/verify-out.txt
```

Fix everything relevant it reports (it covers typecheck/build of changed packages and transitive consumers, the selected tests, and Rust only if Rust changed — it didn't). Never report a blocked or partial sweep as clean.

- [ ] **Step 2: Biome read-only**

```bash
env -u SHELLOPTS -u BASHOPTS bun run lint:check > /tmp/lint-out.txt 2>&1; echo exit=$?; tail -6 /tmp/lint-out.txt
```

(Use `bun run lint` to fix while iterating, `lint:check` to verify — never ship a modified-files-behind state.)

- [ ] **Step 3: Final commit if fixes landed**

```bash
git add -A
git commit -m 'fix: verification sweep for the virtual display toggle'
```

- [ ] **Step 4: Report**

State the exact commands run and their results, list any check that couldn't run and why. The real-instance check (`e2e` or a live node flip) is deliberately NOT part of this plan's gates: the scripted-node tests carry the wire, and the node provider tests carry the Xvfb mechanics (the CI harness runs no real Xvfb; `e2e/tests/47-preview.spec.ts` never allocated a display before this feature).

## Out of scope (say so if asked)

- Resizing a live display (off-then-on only), the Linux pre-allocated-slot design (parked in the spec), macOS-specific UI beyond the shared picker row, mobile (the picker row rides the same components where the picker exists there).
