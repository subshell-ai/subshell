# Remote harness install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a node's owner or Manage grantee install a built-in harness CLI on an enrolled node from the node page, through a signed `harness_install` command.

**Architecture:** Add protocol-29 command `harness_install`, executed by the node under the existing bounded runner and on the same package-manager chain as `harness_update`. The plane adds `POST /api/nodes/:id/harnesses/:pluginId/install`, gated to the node's manage band, sharing the per-node harness run lock with Update. The SPA reuses the harness card's Install row, choosing the setup route for `local` and the node route for an agent.

**Tech Stack:** Bun, TypeScript, Elysia, TanStack Query, React, `@internal/pane-runtime` `runBounded`.

**Spec:** `docs/superpowers/specs/2026-11-09-remote-harness-install-design.md`

## Global Constraints

- Protocol `NODE_PROTOCOL_VERSION = 29`; `MIN_NODE_VERSION = "3.6.0"`; `apps/node/agent/package.json` version `3.6.0`.
- Install command comes only from a BUILT-IN plugin's `subshell.install.command`. Never accept a command from a request.
- New route is browser-cookie only; an enrolled node requires `gate.canManage` (owner or `manage`). `local` keeps `POST /api/setup/agents/:pluginId/install`.
- Bound every run at 10 minutes; the RPC waits 30 seconds longer. `runBounded` supplies the allowlisted environment, login-shell PATH, closed stdin, and 64 KiB per-stream cap.
- One harness run per node at a time, shared by install and update. Refuse before the response body opens.
- NDJSON frames: `{type:"waiting"}` every 5 s, then exactly one `{type:"done", ...result}` or `{type:"error", message}`. Cap relayed error text at 4096 characters.
- Never log installer output. Audit actions: `node.harness.install` and `node.harness.install.unknown` only for timeout/dropped socket.
- Follow the repo's conversational writing voice in UI copy and comments.
- Run focused tests with `bun test <file>` in the package; never a bare `bun test` for a suite.

## Review Focus

- A `view` or `edit` grantee, a machine bearer, or a non-built-in plugin reaching the install command. Expected: refused before any body opens.
- Install racing Update, or two installs, on one node. Expected: one runs; the other gets 409 with the holder named, and pane effects never wait behind it.
- Pressing Install on an offline or held node. Expected: disabled with a reason in the page; the route answers 409 if asked directly.
- Installer output or a command line leaking into logs/audit. Expected: output stays in the caller's bounded stream; audit carries only plugin id and outcome.
- An old node receiving `harness_install`. Expected: exact-match handshake holds it at protocol 29; the floor names 3.6.0.

---

### Task 1: Protocol 29 frame and version floor

**Files:**
- Modify: `packages/subshell-protocol/src/node-frames.ts:246-256` (version comment/constant), `:1038-1060` (command union), `:2260-2268` (parser)
- Modify: `packages/subshell-protocol/src/versions.ts:144-166` (floor and comment)
- Modify: `apps/node/agent/package.json:3`
- Test: `packages/subshell-protocol/src/__tests__/node-frames.test.ts:357-448,164-172`

**Interfaces:**
- Produces: `NodeCommandBody` member `{ type: "harness_install"; harnessId: string; command: string }`; `NODE_PROTOCOL_VERSION = 29`; `MIN_NODE_VERSION = "3.6.0"`.

- [ ] **Step 1: Write the failing tests**

In `node-frames.test.ts`, extend the `harness_update` shape test and the pinned version test:

```ts
it("accepts harness_install and rejects an empty id or blank command", () => {
  // A harness install is the same shape as an update: the plane sends the
  // built-in manifest's installer line; there is nothing to run without both.
  expect(
    parseNodeCommandBody({ type: "harness_install", harnessId: "claude-code", command: "curl -fsSL https://example.test/i | sh" }),
  ).toEqual({ type: "harness_install", harnessId: "claude-code", command: "curl -fsSL https://example.test/i | sh" });
  expect(parseNodeCommandBody({ type: "harness_install", harnessId: "", command: "true" })).toBeNull();
  expect(parseNodeCommandBody({ type: "harness_install", harnessId: "claude-code", command: "  " })).toBeNull();
  expect(parseNodeCommandBody({ type: "harness_install", harnessId: "claude-code" })).toBeNull();
});

// in "pins the protocol version"
// 29 is harness installs: `harness_install` runs a built-in manifest's
// installer line on the node that holds the harness. An older node answers
// `unsupported`, so the exact-match handshake refuses it before it is sent.
expect(NODE_PROTOCOL_VERSION).toBe(29);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/subshell-protocol && bun test src/__tests__/node-frames.test.ts`
Expected: FAIL — `harness_install` parses to `null`, and the pinned protocol is still 28.

- [ ] **Step 3: Implement the frame, version, and floor**

In `node-frames.ts`, add the union member after `harness_update`, mirroring its doc but saying "installer line" and "install". Add the parser case next to `harness_update` with the same id/command checks. Bump the constant and extend the version history:

```ts
/**
 * **28 -> 29:** harness installs become a first-class action. A
 * `harness_install` command runs a built-in harness's `install.command` on the
 * node that holds it. An older node answers `unsupported`, which is why the
 * exact-match handshake refuses it before it is sent. The floor and
 * `apps/node/agent/package.json` move to 3.6.0 in this commit, one minor above
 * the published 3.5.1.
 */
export const NODE_PROTOCOL_VERSION = 29;
```

In `versions.ts`, append the protocol-29 paragraph and set `MIN_NODE_VERSION = "3.6.0"`. In `apps/node/agent/package.json`, set `"version": "3.6.0"`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/subshell-protocol && bun test src/__tests__/node-frames.test.ts src/__tests__/versions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/subshell-protocol/src/node-frames.ts packages/subshell-protocol/src/versions.ts packages/subshell-protocol/src/__tests__/node-frames.test.ts apps/node/agent/package.json
git commit -m "feat(protocol): add harness_install command (protocol 29)"
```

---

### Task 2: Node executor and shared package-manager chain

**Review:** per-task — concurrency

**Files:**
- Create: `apps/node/agent/src/commands/harness-run.ts`
- Create: `apps/node/agent/src/commands/harness-install.ts`
- Modify: `apps/node/agent/src/commands/harness-update.ts`
- Modify: `apps/node/agent/src/commands/index.ts:15,92-95,126-129`
- Modify: `apps/node/agent/src/daemon.ts:754-762,1177-1193`
- Test: `apps/node/agent/src/__tests__/commands-basics.test.ts:556-581`
- Test: `apps/node/agent/src/__tests__/daemon.test.ts:1451-1484`
- Modify: `apps/node/agent/AGENTS.md:187-205`

**Interfaces:**
- Consumes: `Cmd<"harness_install">` from Task 1.
- Produces: `execHarnessInstall(ctx: CommandContext, cmd: Cmd<"harness_install">): Promise<CommandResult>`; both harness executors call `runHarnessLine(harnessId, command, label)`.

- [ ] **Step 1: Write the failing executor test**

Add after the `harness_update` describe in `commands-basics.test.ts`:

```ts
describe("harness_install (protocol 29)", () => {
  it("runs the installer line through sh and reports the exit code and output", async () => {
    const { ctx } = makeCtx({}, []);
    const ok = await dispatchCommand(ctx, {
      type: "harness_install",
      harnessId: "claude-code",
      command: "printf 'installed\\n'",
    });
    expect(ok.ok).toBe(true);
    const answered = ok.ok ? parseNodeHarnessUpdateResult(ok.data) : null;
    expect(answered).toMatchObject({ harnessId: "claude-code", ok: true, exitCode: 0, timedOut: false });
    expect(answered?.output).toContain("installed");

    const failed = await dispatchCommand(ctx, {
      type: "harness_install",
      harnessId: "codex",
      command: "printf 'install failed\\n' >&2; exit 9",
    });
    expect(failed.ok).toBe(true);
    const failure = failed.ok ? parseNodeHarnessUpdateResult(failed.data) : null;
    expect(failure).toMatchObject({ harnessId: "codex", ok: false, exitCode: 9 });
    expect(failure?.output).toContain("install failed");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/node/agent && bun test src/__tests__/commands-basics.test.ts`
Expected: FAIL — `harness_install` is not in the switch, so it answers `unsupported`.

- [ ] **Step 3: Implement the executor and chain**

Create `commands/harness-run.ts` with one bounded runner:

```ts
export async function runHarnessLine(harnessId: string, command: string, label: "update" | "installer") {
  const result = await runBounded(["sh", "-c", command], { timeoutMs: 10 * 60 * 1000 });
  return {
    ok: true as const,
    data: { harnessId, ...summarizeBoundedRun(result, 10 * 60 * 1000, label) },
  };
}
```

Make `execHarnessUpdate` call `runHarnessLine(cmd.harnessId, cmd.command, "update")`. Create `commands/harness-install.ts` calling it with `"installer"`. Wire both into the switch in `commands/index.ts`.

In `daemon.ts`, rename `updateChain` to `harnessRunChain` and route both types through it:

```ts
if (outcome.claims.cmd.type === "harness_update" || outcome.claims.cmd.type === "harness_install") {
  harnessRunChain = harnessRunChain
    .then(() => execute(ws, outcome.claims))
    .catch((err: unknown) => log(`command execution failed: ${String(err)}`));
  return;
}
```

Update the comments to say installs and updates share one chain; a ten-minute package-manager run never holds pane effects.

- [ ] **Step 4: Add the shared-chain test**

In `daemon.test.ts`, after the slow-update test:

```ts
test("harness_install queues behind harness_update on the same chain", async () => {
  // They share a filesystem and a package manager. The chain is the node's
  // backstop, so a fast install sent second must still answer second.
  const h = await startDaemon();
  await waitFor(h, (e) => e.type === "inventory", "connect inventory push");
  await signAndSend(
    h,
    { type: "harness_update", harnessId: "claude-code", command: "sleep 1; echo done" },
    { jti: "upd-shared", seq: 1 },
  );
  await signAndSend(
    h,
    { type: "harness_install", harnessId: "codex", command: "echo installed" },
    { jti: "ins-shared", seq: 2 },
  );
  const ins = await waitFor<Extract<NodeEvent, { type: "result" }>>(
    h,
    (e) => e.type === "result" && e.ref === "ins-shared",
    "harness install result",
  );
  expect(ins).toMatchObject({ ok: true });
  expect(
    eventsAs(h, "result")
      .filter((e) => e.ref === "upd-shared" || e.ref === "ins-shared")
      .map((e) => e.ref),
  ).toEqual(["upd-shared", "ins-shared"]);
});
```

- [ ] **Step 5: Run the node tests**

Run: `cd apps/node/agent && bun test src/__tests__/commands-basics.test.ts src/__tests__/daemon.test.ts`
Expected: PASS.

- [ ] **Step 6: Update the node's AGENTS section**

Rename the section to "Harness CLI installs and updates" and state that `harness_install` runs the built-in manifest's installer line, shares the update chain, and uses the same bounded runner. No new secrets or paths.

- [ ] **Step 7: Commit**

```bash
git add apps/node/agent/src/commands/harness-run.ts apps/node/agent/src/commands/harness-install.ts apps/node/agent/src/commands/harness-update.ts apps/node/agent/src/commands/index.ts apps/node/agent/src/daemon.ts apps/node/agent/src/__tests__/commands-basics.test.ts apps/node/agent/src/__tests__/daemon.test.ts apps/node/agent/AGENTS.md
git commit -m "feat(node): run harness_install under the shared harness chain"
```

---

### Task 3: Shared run lock and server install service

**Review:** per-task — concurrency

**Files:**
- Create: `apps/server/api/src/modules/plugins/harness-run-lock.ts`
- Create: `apps/server/api/src/modules/plugins/harness-install.service.ts`
- Modify: `apps/server/api/src/modules/plugins/harness-update.service.ts:6,44-98,150-151`
- Modify: `apps/server/api/src/api/nodes/harness-update.route.ts:12-16,108-110`
- Test: `apps/server/api/src/modules/plugins/__tests__/harness-update.service.test.ts`
- Test: `apps/server/api/src/modules/plugins/__tests__/harness-install.service.test.ts`

**Interfaces:**
- Produces:
  - `claimHarnessRun(nodeId: string, id: string, verb: "install" | "update"): HarnessRunClaim | HarnessRunRefused`
  - `HarnessRunClaim { release(): void }`; `HarnessRunRefused extends Error`, `status: 409`
  - `harnessInstallCommand(id: string): Promise<string | undefined>`
  - `refuseHarnessInstall(id: string): Promise<HarnessInstallRefused | undefined>`
  - `installHarnessOnNode(nodeId: string, id: string, claim?: HarnessRunClaim, deps?: HarnessInstallDeps): Promise<NodeHarnessUpdateResult>`
  - `HarnessInstallDeps { send?: typeof sendCommand; detect?: typeof detectOnNode }`

- [ ] **Step 1: Write the failing service tests**

Create `harness-install.service.test.ts`:

```ts
import { describe, expect, it, mock } from "bun:test";
import {
  harnessInstallCommand,
  installHarnessOnNode,
  refuseHarnessInstall,
} from "@/modules/plugins/harness-install.service.js";
import { claimHarnessRun, HarnessRunRefused } from "@/modules/plugins/harness-run-lock.js";

describe("harnessInstallCommand", () => {
  it("answers the built-in installer line and nothing for a shell or unknown id", async () => {
    expect(await harnessInstallCommand("claude-code")).toContain("claude.ai/install.sh");
    expect(await harnessInstallCommand("terminal")).toBeUndefined();
    expect(await harnessInstallCommand("not-a-plugin")).toBeUndefined();
  });
});

describe("refuseHarnessInstall", () => {
  it("refuses an unknown id and a plugin that drives no program", async () => {
    expect((await refuseHarnessInstall("not-a-plugin"))?.status).toBe(404);
    expect((await refuseHarnessInstall("terminal"))?.status).toBe(400);
  });
});

describe("installHarnessOnNode", () => {
  it("sends harness_install with the manifest line, validates the id, and refreshes detection", async () => {
    const send = mock(async (_nodeId: string, cmd: { type: string; harnessId: string; command: string }) => {
      expect(cmd.type).toBe("harness_install");
      expect(cmd.harnessId).toBe("claude-code");
      expect(cmd.command).toContain("claude.ai/install.sh");
      return { harnessId: "claude-code", ok: true, exitCode: 0, output: "installed", durationMs: 5, timedOut: false };
    });
    const detect = mock(async () => {});
    const result = await installHarnessOnNode("node-a", "claude-code", undefined, { send: send as never, detect });
    expect(result).toMatchObject({ harnessId: "claude-code", ok: true });
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it("throws on a malformed answer or an echoed id for another harness", async () => {
    await expect(
      installHarnessOnNode("node-a", "claude-code", undefined, {
        send: (async () => ({ nope: true })) as never,
        detect: async () => {},
      }),
    ).rejects.toThrow(/malformed/);
    await expect(
      installHarnessOnNode("node-a", "claude-code", undefined, {
        send: (async () => ({
          harnessId: "codex",
          ok: true,
          exitCode: 0,
          output: "",
          durationMs: 1,
          timedOut: false,
        })) as never,
        detect: async () => {},
      }),
    ).rejects.toThrow(/codex/);
  });
});

describe("claimHarnessRun", () => {
  it("shares one slot across install and update, names the holder, and releases", () => {
    const first = claimHarnessRun("node-a", "claude-code", "update");
    if (first instanceof HarnessRunRefused) throw new Error("first claim refused");
    const second = claimHarnessRun("node-a", "codex", "install");
    expect(second).toBeInstanceOf(HarnessRunRefused);
    if (second instanceof HarnessRunRefused) expect(second.message).toContain("claude-code");
    first.release();
    const after = claimHarnessRun("node-a", "codex", "install");
    expect(after).not.toBeInstanceOf(HarnessRunRefused);
    if (!(after instanceof HarnessRunRefused)) after.release();
  });
});
```

Update `harness-update.service.test.ts` imports from `harness-run-lock.js` and rename `claimHarnessUpdate` → `claimHarnessRun(..., "update")`; leave the plugin refusal tests on `HarnessUpdateRefused`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/server/api && bun test src/modules/plugins/__tests__/harness-install.service.test.ts src/modules/plugins/__tests__/harness-update.service.test.ts`
Expected: FAIL — the lock module and install service do not exist.

- [ ] **Step 3: Implement the lock and service**

Move the map/local-slot logic from `harness-update.service.ts` into `harness-run-lock.ts`, recording `{ id, verb }` and wording refusals as `"${id}" is already being installed/updated on this node.` Keep the local `claimLocalRun` behavior and the `The control-plane host is busy with …` message.

In `harness-install.service.ts`:

```ts
export async function harnessInstallCommand(id: string): Promise<string | undefined> {
  const harness = getHarness(id);
  if (harness?.type !== "agent-harness") return undefined;
  if (!(await builtInIds()).includes(id)) return undefined;
  const command = harness.installHint.command.trim();
  return command === "" ? undefined : command;
}
```

`refuseHarnessInstall` distinguishes unknown (404), not built-in (400, "only built-in harness plugins can be installed from here"), not offered by the instance (404, using `enabledHarnessPlugins()`), and no command (400).

`installHarnessOnNode` claims the shared slot when no claim is passed, resolves the command, sends `{ type: "harness_install", harnessId: id, command }` with `HARNESS_INSTALL_RPC_TIMEOUT_MS`, parses with `parseNodeHarnessUpdateResult`, checks the echoed id, refreshes detection best-effort (log and continue on failure), and releases in `finally`.

Change the update service to import and use the shared lock. Update `harness-update.route.ts`'s claim import and `instanceof` check to `HarnessRunRefused`.

- [ ] **Step 4: Run the service tests**

Run: `cd apps/server/api && bun test src/modules/plugins/__tests__/harness-install.service.test.ts src/modules/plugins/__tests__/harness-update.service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/src/modules/plugins/harness-run-lock.ts apps/server/api/src/modules/plugins/harness-install.service.ts apps/server/api/src/modules/plugins/harness-update.service.ts apps/server/api/src/api/nodes/harness-update.route.ts apps/server/api/src/modules/plugins/__tests__/harness-install.service.test.ts apps/server/api/src/modules/plugins/__tests__/harness-update.service.test.ts
git commit -m "feat(server): add harness install service and shared run lock"
```

---

### Task 4: Node install route, frames, and security docs

**Review:** per-task — authentication/security

**Files:**
- Create: `apps/server/api/src/api/nodes/harness-run-frames.ts`
- Create: `apps/server/api/src/api/nodes/harness-install.route.ts`
- Modify: `apps/server/api/src/api/nodes/harness-update.route.ts:34-37,113-201`
- Modify: `apps/server/api/src/api/nodes/index.ts:9,71`
- Test: `apps/server/api/src/api/nodes/__tests__/harness-install.route.test.ts`
- Modify: `apps/server/api/docs/plugins-on-the-plane.md:38-61`
- Modify: `docs/security.md:3032-3060,3381-3431`

**Interfaces:**
- Consumes: `refuseHarnessInstall`, `installHarnessOnNode`, `claimHarnessRun`, `HarnessRunRefused`.
- Produces: `HARNESS_RUN_HEARTBEAT_MS = 5_000`, `HARNESS_RUN_ERROR_MAX = 4096`.

- [ ] **Step 1: Write the failing route tests**

Mirror the update route test setup in `harness-install.route.test.ts` with `POST /api/nodes/:id/harnesses/:pluginId/install`:

```ts
it("refuses a caller with no session", async () => {
  expect((await post(agentNode, "claude-code")).status).toBe(401);
});

it("refuses a machine bearer", async () => {
  expect((await postBearer(agentNode, "claude-code", bearerKey)).status).toBe(403);
});

it("refuses the control-plane host: the setup route owns that install", async () => {
  expect((await post("local", "claude-code", adminToken)).status).toBe(400);
});

it("refuses view and edit grantees: installing software is the manage band", async () => {
  // grant view, then edit, assert 403 for both
});

it("refuses an unknown plugin, a terminal, and an offline node in that order", async () => {
  expect((await post(agentNode, "not-a-plugin", ownerToken)).status).toBe(404);
  expect((await post(agentNode, "terminal", ownerToken)).status).toBe(400);
  expect((await post(agentNode, "claude-code", ownerToken)).status).toBe(409);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/server/api && bun test src/api/nodes/__tests__/harness-install.route.test.ts`
Expected: FAIL — 404 from the missing route.

- [ ] **Step 3: Implement the shared frame constants and the route**

Move `UPDATE_HEARTBEAT_MS` and `UPDATE_ERROR_MAX` into `harness-run-frames.ts` as `HARNESS_RUN_HEARTBEAT_MS` / `HARNESS_RUN_ERROR_MAX`; import them in the update route.

Create the install route mirroring the update route's rejection order:

```ts
requireCookieActor(actor, "Harness installs are restricted to browser sessions");
const gate = await loadNodeGate(user.id, params.id);
if (!gate) return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
if (gate.row.kind !== "agent") {
  return status(400, apiErrorBody({
    code: BackendErrorCodes.INPUT_VALIDATION_ERROR,
    message: "The control-plane host installs through the setup screen.",
  }));
}
if (!gate.canManage) throw new ForbiddenError();
const refusal = await refuseHarnessInstall(params.pluginId);
if (refusal) return status(refusal.status, apiErrorBody({ code: codeForRefusalStatus(refusal.status), message: refusal.message }));
if (getLive(gate.row.id) === undefined) {
  return status(409, apiErrorBody({ code: BackendErrorCodes.NODE_OFFLINE, message: `Node "${gate.row.id}" is offline. Wait for it to reconnect before installing.` }));
}
const claim = claimHarnessRun(gate.row.id, params.pluginId, "install");
if (claim instanceof HarnessRunRefused) {
  return status(409, apiErrorBody({ code: BackendErrorCodes.EXISTS_ERROR, message: claim.message }));
}
```

Stream with the same heartbeat/frame/close discipline as update. The run is:

```ts
const result = await installHarnessOnNode(gate.row.id, params.pluginId, claim);
await audit({
  actorUserId: user.id,
  action: "node.harness.install",
  targetType: "node",
  targetId: gate.row.id,
  metadataJson: JSON.stringify({ pluginId: params.pluginId, ok: result.ok, exitCode: result.exitCode, durationMs: result.durationMs, timedOut: result.timedOut }),
});
send({ type: "done", ...result });
```

On `NodeRpcError` with `timeout`/`offline`, write `node.harness.install.unknown` with only `{ pluginId }`. Bound the error message to `HARNESS_RUN_ERROR_MAX`.

Register `.use(harnessInstallRoute)` beside `harnessUpdateRoute`. Document the route/gate in `plugins-on-the-plane.md`, and add the security accounting to §11.10c (or a §11.10d) with the gate, built-in-only rule, bounds, lock, audit, and residual.

- [ ] **Step 4: Run the route tests**

Run: `cd apps/server/api && bun test src/api/nodes/__tests__/harness-install.route.test.ts src/api/nodes/__tests__/harness-update.route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/src/api/nodes/harness-run-frames.ts apps/server/api/src/api/nodes/harness-install.route.ts apps/server/api/src/api/nodes/harness-update.route.ts apps/server/api/src/api/nodes/index.ts apps/server/api/src/api/nodes/__tests__/harness-install.route.test.ts apps/server/api/docs/plugins-on-the-plane.md docs/security.md
git commit -m "feat(server): install a harness CLI on an enrolled node"
```

---

### Task 5: Harness card Install button on enrolled nodes

**Files:**
- Modify: `apps/server/web/src/hooks/use-install-agent.ts:6-16,45-70`
- Modify: `apps/server/web/src/components/nodes/node-harness-card.tsx:134-145,192-198,225-230,405-533`
- Test: `apps/server/web/src/hooks/__tests__/use-install-agent.test.ts`
- Test: `apps/server/web/src/components/nodes/__tests__/node-harness-card.test.tsx:451-603`

**Interfaces:**
- Consumes: `POST /api/nodes/:nodeId/harnesses/:pluginId/install` and its NDJSON done frame.
- Produces: `useInstallAgent(onLine?, nodeId?)`; result `harness?: HarnessInfo`, `timedOut?: boolean`.

- [ ] **Step 1: Write the failing card tests**

Replace the existing `it("never offers it on an enrolled node, whoever is looking", …)`
test: the behavior it pins is what this task reverses. Add to the test mock a
branch for `/api/nodes/node1/harnesses/:id/install` that answers the same
NDJSON frames as the setup-install branch, then add inside the `Install`
describe:

```ts
it("offers Install on an enrolled node to its owner and POSTs the node route", async () => {
  const { calls, restore } = await mount({
    ...localOpts,
    kind: "agent",
    access: "owner",
    canManage: true,
  });
  try {
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/nodes/node1/harnesses/claude/install")).toBe(true),
    );
  } finally {
    restore();
  }
});

it("offers it to a Manage grantee", async () => {
  const { restore } = await mount({ ...localOpts, kind: "agent", access: "manage", canManage: true });
  try {
    expect(await screen.findByRole("button", { name: "Install" })).toBeDefined();
  } finally {
    restore();
  }
});

it("never offers it to an edit or view grantee on an enrolled node", async () => {
  for (const access of ["edit", "view"] as const) {
    const { restore } = await mount({ ...localOpts, kind: "agent", access, canManage: false });
    try {
      expect(await screen.findByText((c) => c === "Claude")).toBeDefined();
      expect(screen.queryByRole("button", { name: /install/i })).toBeNull();
    } finally {
      restore();
    }
  }
});

it("disables Install on an offline node with the reason, rather than a 409 press", async () => {
  const { restore } = await mount({ ...localOpts, kind: "agent", access: "owner", status: "offline" });
  try {
    const btn = await screen.findByRole("button", { name: "Install" });
    expect(btn.matches(":disabled, [aria-disabled=true]")).toBe(true);
    expect(btn.getAttribute("aria-description")).toContain("offline");
  } finally {
    restore();
  }
});

it("reports a failed remote run under the row", async () => {
  const { restore } = await mount({
    ...localOpts,
    kind: "agent",
    access: "owner",
    installFrames: [
      `${JSON.stringify({ type: "done", harnessId: "claude", ok: false, exitCode: 1, output: "no package", durationMs: 4, timedOut: false })}\n`,
    ],
  });
  try {
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    expect(await screen.findByText(/exited with code 1/)).toBeDefined();
    expect(screen.getByText("no package")).toBeDefined();
  } finally {
    restore();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/server/web && bun test src/components/nodes/__tests__/node-harness-card.test.tsx`
Expected: FAIL — the card still hides Install on `agent`.

- [ ] **Step 3: Implement the hook path and the card gate**

In `use-install-agent.ts`, accept an optional `nodeId`; choose the path and add `timedOut?: boolean` plus `harness?: HarnessInfo`. In `onSettled`, invalidate `HARNESS_QUERY_KEY` and, when a node id was given, `[...NODE_QUERY_KEY, nodeId]`.

In `node-harness-card.tsx`:

```ts
const installNodeId = data?.kind === "agent" ? nodeId : undefined;
const install = useInstallAgent((id, line) => { /* unchanged */ }, installNodeId);

const canInstallHere =
  data !== undefined &&
  (data.kind === "local" ? data.canManage : data.access === "owner" || data.access === "manage");
const installReachable =
  data?.kind === "local" || (data?.status === "online" && data?.held === null);
```

Use `installReachable` in the Install button's disabled expression and reason (`"The node is offline. Wait for it to reconnect before installing."`). Keep `offerInstall` unchanged otherwise. Show "Running the installer on this node…" while an enrolled-node run is pending; keep "Starting the installer…" for `local`. Render a `timedOut` result as "The installer timed out. It may still be running." Explain the run as "on this node, as the user the subshell daemon runs as" when `data.kind === "agent"`; keep the server-user wording for `local`.

- [ ] **Step 4: Run the web tests**

Run: `cd apps/server/web && bun test src/components/nodes/__tests__/node-harness-card.test.tsx src/hooks/__tests__/use-install-agent.test.ts src/components/sidebar/__tests__`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/web/src/hooks/use-install-agent.ts apps/server/web/src/components/nodes/node-harness-card.tsx apps/server/web/src/hooks/__tests__/use-install-agent.test.ts apps/server/web/src/components/nodes/__tests__/node-harness-card.test.tsx
git commit -m "feat(web): offer Install on enrolled-node harness rows"
```

---

### Task 6: Reference docs, changeset, lockfile

**Files:**
- Modify: `apps/docs/content/docs/reference/node-protocol.mdx:115,117,130,178`
- Modify: `apps/server/api/docs/plugins-on-the-plane.md` if Task 4 left a protocol number
- Create: `.changeset/remote-harness-install.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Update the protocol reference**

State that `harness_install` uses the installer budget and the harness queue, add it to the Harness CLIs family, and set the implemented protocol to **29**.

- [ ] **Step 2: Write the changeset**

```markdown
---
"@internal/server": minor
"@internal/node": patch
"@internal/desktop-server": patch
"@internal/desktop-client": patch
"@internal/docs": patch
---

Harness rows on an enrolled node now offer Install, for the node's owner or a Manage grantee. It runs the built-in plugin's own installer on that machine, under the same ten-minute bounded runner as the local installer, and reports the result on the row. The node protocol moves to 29, so enrolled nodes need subshell 3.6.0; older nodes are held for their own update until they catch up. Third-party plugin install commands remain copy-only guidance.
```

- [ ] **Step 3: Resync the lockfile version**

Run: `bun run lint:lockfile:fix`
Expected: `apps/node/agent`'s recorded version matches `3.6.0`.

- [ ] **Step 4: Run the doc and lock checks**

Run: `bun run lint:lockfile && bun run lint:design`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/docs/content/docs/reference/node-protocol.mdx apps/server/api/docs/plugins-on-the-plane.md .changeset/remote-harness-install.md bun.lock
git commit -m "docs: document harness installs and protocol 29"
```

---

### Task 7: Whole-change verification

- [ ] **Step 1: Run the affected package tests**

```bash
cd packages/subshell-protocol && bun test src/__tests__/node-frames.test.ts src/__tests__/versions.test.ts
cd ../../apps/node/agent && bun test src/__tests__/commands-basics.test.ts src/__tests__/daemon.test.ts
cd ../server/api && bun test src/modules/plugins/__tests__/harness-install.service.test.ts src/modules/plugins/__tests__/harness-update.service.test.ts src/api/nodes/__tests__/harness-install.route.test.ts src/api/nodes/__tests__/harness-update.route.test.ts
cd ../web && bun test src/components/nodes/__tests__/node-harness-card.test.tsx src/hooks/__tests__/use-install-agent.test.ts src/components/sidebar/__tests__
```

Expected: PASS in each.

- [ ] **Step 2: Run the repo's changed verification**

Run: `bun run verify:changed`
Expected: PASS (build, type-check, lint for affected packages).

- [ ] **Step 3: Commit only fixes the verifier actually made**

Run `git status --short`. If a formatter or lockfile step rewrote a tracked
file, stage exactly those paths by name and commit; if the tree is clean,
skip this step. Never use `git add -A`.

---

## Self-Review

- **Spec coverage:** goals map to Tasks 1–5; security accounting to Tasks 3–4; test plan to Tasks 1–5 and 7; release to Task 6.
- **Step scan:** every step names a file, signature, exact value, or command.
- **Type consistency:** `HarnessRunRefused`, `claimHarnessRun`, `HarnessInstallDeps`, `installHarnessOnNode`, and the `harness_install` frame use one spelling throughout.
- **Review Focus:** auth/security → Task 4; concurrency → Tasks 2–3; offline press → Task 5; output/audit → Task 4; protocol mismatch → Task 1.
- **Review marks:** Tasks 3 and 4 are per-task reviewed for concurrency and security; Task 2 for concurrency; the rest ride the whole-branch review.
