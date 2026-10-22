# Pane Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a dashboard user see what a pane's process is showing: proxy a pane's loopback server (Open), screencast a pane's browser over CDP (Watch), and view a Linux pane's virtual display (Screen).

**Architecture:** A preview lane generalizes the ssh relay lane: the plane brokers per-connection byte lanes to a node, the node dials `127.0.0.1:<port>` only, and three surfaces ride that lane or the `/ws/live` feed. Protocol bumps 22 -> 23 (exact-match gate). See the spec for the full design and its security argument.

**Tech Stack:** Bun, Elysia, TypeScript, React 19 (Vite SPA), tmux node agent, `@novnc/novnc` 1.7.0 (MPL-2.0), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-21-pane-preview-design.md` (approved; §12 settled). Read it before any task; this plan argues from it.

## Global Constraints

- Protocol doctrine: `NODE_PROTOCOL_VERSION` 22 -> 23 this round, exact-match gate at connect (server ships first; a lagging agent is held with an update message, never feature-gated). `MIN_NODE_VERSION` (`packages/subshell-protocol/src/versions.ts:123`) rises to `"2.4.0"` and `apps/node/agent/package.json` version rises to `"2.4.0"` **in the same commit as the bump** (both are already higher than the old floor by one, this keeps the pattern).
- Node executor contract (`apps/node/agent/AGENTS.md`): act only on verified commands, closed grammar at both ends, result-before-teardown, `pending: true` ack for slow off-chain work, self-expiring timers, never `process.exit`, refusals name the id and the remedy.
- Dialing is loopback-only (`127.0.0.1` / `::1`), both forward and CDP. Non-loopback is out of scope forever (spec §11).
- Close reasons are a closed set: `viewer-left`, `pane-gone`, `node-dropped`, `slow-link`, `over-cap`, `idle`, `revoked`, `target-gone` (the last one is decision 3 above).
- No dynamic `import()` in anything the compiled binaries bundle (server, node). The SPA has a sanctioned lazy-feature precedent at `apps/server/web/src/lib/ssh.ts`; only the SPA may code-split.
- Pinned dependency versions: after `bun add`, run `syncpack fix` then `bun install`; check with `bun run lint:lockfile`.
- Authz: watch streams require `view`, every lane (proxy bytes, display) requires `edit`; a foreign pane answers 404, never 403. `/ws/live` remains the second authorization path: any new broadcast must pass the viewer-vs-row diff test (the control behind `docs/security.md` §11.14; see `apps/server/api/src/ws/__tests__/live-consistency.test.ts`).
- Voice: no U+2014 anywhere authored (`bun run lint:prose`); UI copy rules in `AGENTS.md`; design tokens only (`bun run lint:design`).
- Tests run via scripts (`bun run test --filter=<pkg>`, never bare `bun test` for suites); invoke bash-shaped things with `env -u SHELLOPTS -u BASHOPTS`.
- Task boundary verification: `bun run verify-types && bun run lint:check && bun run lint:prose && bun run test`, plus `bunx turbo build` whenever `packages/` changed. No PR at any point (user tests first, on `feat/pane-preview`).

**Implementation decisions recorded against the spec (approve these as you review):**

1. Spec §12 said vendor noVNC's `core/` from git. It is published on npm as `@novnc/novnc` (v1.7.0, official repo's own package, `exports: "./core/rfb.js"`, MPL-2.0 text ships inside). We install the pinned dependency instead of copying files: same ruling (pinned, MPL retained, lazy chunk), fewer bytes and no drift.
2. Spec §6 implied one forward lane per session. A real dev server mixes keep-alive HTTP with a permanent HMR WebSocket, and one TCP lane serializes both, so the proxy opens **one node forward lane per inbound browser connection** (each gets its own fresh node ref; the session secret authorizes many lanes). Spec quotas stay, and bursts beyond them queue rather than fail.
3. The spec's named close-reason set has no member for "the proxied service itself hung up" (a dev server that exits while the pane lives). The set gains `target-gone`, and the node tells the plane about lane EOF with a new node->plane event `preview-closed { ref, reason }`: the ssh relay precedent has no such signal because its targets are agent-managed processes, while a preview lane's target dies freely.

---

## File Structure

**`packages/subshell-protocol/src/`**
- `node-frames.ts` (modify): version 23 + bump-history entry, five new commands, `PreviewDataFrame` link frame + `parsePreviewFrame`, `NodeEvent` members `preview-data` and `preview-stream`, `ready.previewEnabled`, `create_session` gains `screen`, new wire type `NodePreviewEnabledWire`.
- `live-frames.ts` (modify): server member `preview-stream`, client members `watch` / `unwatch`, parse arms.
- `ssh-limits.ts` (modify): `PREVIEW_*` constants.
- `versions.ts` (modify): floor 2.4.0.
- `__tests__/node-frames.test.ts`, `__tests__/live-frames.test.ts` (modify): census auto-extends; add explicit boundary cases.

**`apps/node/agent/src/`**
- `preview/flags.ts` (new): the `previewEnabled` mirror, cloned from wherever `sshEnabled` persists (find with `grep -rn sshEnabled apps/node/agent/src`).
- `preview/ports.ts`, `preview/forward.ts`, `preview/cdp-bridge.ts`, `preview/display.ts` (new): the four mechanisms.
- `commands/set-preview-enabled-exec.ts`, `commands/preview-open-exec.ts` (one arm, both `kind` branches), `commands/preview-close-exec.ts`, `commands/preview-ports-exec.ts` (new arms), `commands/index.ts` (dispatch), `commands/context.ts` (registry handles, mirroring the relay ones).
- `daemon.ts` (modify): `ready.previewEnabled`, inbound `preview_data` arm beside the relay arm, display orphan sweep timer.
- `tmux-runner.ts` / pane-create command (modify): inject `DISPLAY` when `screen` is set; pane-death hook calls `display.closeFor(paneId)`.
- `__tests__/preview-*.test.ts` (new).

**`apps/server/api/src/`**
- `services/nodes/preview-enabled.ts` (new, clones `nodes/ssh-enabled.ts` shape incl. its storage), route beside the ssh-enabled route.
- `services/preview-broker.ts` + `services/__tests__/preview-broker.test.ts` (new).
- `api/subshells/preview-info.route.ts`, `preview-open.route.ts`, `preview-close.route.ts`, `preview-watch-start.route.ts`, `preview-watch-stop.route.ts`, `api/subshells/index.ts` (mount), `api/subshells/__tests__/preview-routes-auth.test.ts`.
- `preview/lane-duplex.ts`, `preview/pv-http.ts`, `preview/pv-ws.ts` + `preview/__tests__/` (new): the `/pv` proxy.
- `ws/live-ws.ts` (modify): `watch`/`unwatch` client frames; `ws/live-registry.ts` (modify): targeted send; `ws/__tests__/live-ws.test.ts`, `live-consistency.test.ts` (modify).
- `api/users/set-user-disabled.route.ts`, `set-user-role.route.ts`, shares route (modify): revoke hook beside the existing `dropLiveSocketsFor` calls.
- Node link intake (the call site that feeds `routeRelayFrame` in `services/ssh-relay.service.ts:512`): route `preview-data`/`preview-stream` events to the broker beside it.

**`apps/server/web/src/`**
- `hooks/use-subshell-preview.ts`, `lib/preview-bus.ts` (new); `components/preview/preview-section.tsx`, `port-list.tsx`, `watch-viewer.tsx`, `screen-viewer.tsx`, `preview-toggle.tsx` (new); `routes/subshells_.$id.tsx`, create/launch dialog, node settings page (modify); `hooks/use-live-subshells-feed.tsx` (modify: dispatch `preview-stream` to the bus).

**Docs and release:** `apps/server/api/AGENTS.md` (audit inventory + preview rules), `docs/security.md` (preview lane paragraph), `apps/node/agent/AGENTS.md` (executor note), `apps/docs/content/docs/` (user page), `.changeset/` (one changeset for `@internal/server` + `@internal/node`).

---

### Task 1: Protocol contract (frames, commands, limits, version floor)

**Files:**
- Modify: `packages/subshell-protocol/src/node-frames.ts` (version at :187, bump history near :80, command union and `parseNodeCommandBody`, `NodeEvent` at :1540, `parseNodeEvent` at :2048, `RelayFrame` region :1451 as the shape to clone, ready member region, `create_session` command)
- Modify: `packages/subshell-protocol/src/ssh-limits.ts`
- Modify: `packages/subshell-protocol/src/versions.ts:123`
- Modify: `apps/node/agent/package.json` (`"version": "2.3.0"` -> `"2.4.0"`)
- Test: `packages/subshell-protocol/src/__tests__/node-frames.test.ts`

**Interfaces:**
- Produces (Tasks 3-11 import these names): `NODE_PROTOCOL_VERSION = 23`; `NodePreviewEnabledWire { on: boolean; changedAt: string }`; commands `SetPreviewEnabledCommand`, `PreviewOpenCommand` (one command, kinds `forward` | `screencast`, exactly as spec §4 defines), `PreviewPortsGetCommand`, `PreviewCloseCommand`, `PreviewCloseReason`; link frame `PreviewDataFrame` + `parsePreviewFrame(raw: string | object): PreviewDataFrame | null`; `NodeEvent` members `preview-data`, `preview-stream`, and `preview-closed` (node -> plane lane EOF: `{ type: "preview-closed"; ref: string; reason: PreviewCloseReason }`, decision 3); ready member `previewEnabled?: NodePreviewEnabledWire`; `create_session` optional `screen?: { width: number; height: number }`; constants `PREVIEW_DATA_MAX_BYTES`, `PREVIEW_WATCH_FPS_DEFAULT`, `PREVIEW_WATCH_FPS_MAX`, `PREVIEW_WATCH_JPEG_QUALITY`, `PREVIEW_WATCH_FRAMES_BUFFERED`, `PREVIEW_FORWARD_SESSIONS_PER_PANE`, `PREVIEW_SESSIONS_PER_NODE`, `PREVIEW_WATCH_SUBSCRIBERS_MAX`, `PREVIEW_IDLE_MS`, `PREVIEW_LIFETIME_MAX_MS`, `PREVIEW_REF_RE`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing grammar tests.** Append to `node-frames.test.ts` (mirror how it tests `relay` frames and the command census):

```ts
describe("preview commands", () => {
  test("parses preview_open round trip", () => {
    const cmd = { type: "preview_open", ref: "a".repeat(32), kind: "forward", paneId: "p1", port: 5173, lifetimeMs: 3_600_000 };
    expect(parseNodeCommandBody(JSON.stringify(cmd))).toEqual(cmd);
  });
  test("refuses a port out of range", () => {
    expect(parseNodeCommandBody(JSON.stringify({ type: "preview_open", ref: "a".repeat(32), kind: "forward", paneId: "p", port: 70000, lifetimeMs: 60_000 }))).toBeNull();
    expect(parseNodeCommandBody(JSON.stringify({ type: "preview_open", ref: "a".repeat(32), kind: "forward", paneId: "p", port: 1.5, lifetimeMs: 60_000 }))).toBeNull();
  });
  test("refuses a short or long ref", () => {
    expect(parseNodeCommandBody(JSON.stringify({ type: "preview_close", ref: "x", reason: "user" }))).toBeNull();
  });
  test("the kind decides whether fps may appear", () => {
    expect(parseNodeCommandBody(JSON.stringify({ type: "preview_open", ref: "a".repeat(32), kind: "screencast", paneId: "p", port: 9222, fps: 99, lifetimeMs: 60_000 }))).toBeNull(); // over PREVIEW_WATCH_FPS_MAX
    expect(parseNodeCommandBody(JSON.stringify({ type: "preview_open", ref: "a".repeat(32), kind: "screencast", paneId: "p", port: 9222, lifetimeMs: 60_000 }))).toBeNull(); // screencast requires fps
    expect(parseNodeCommandBody(JSON.stringify({ type: "preview_open", ref: "a".repeat(32), kind: "forward", paneId: "p", port: 8080, fps: 5, lifetimeMs: 60_000 }))).toBeNull(); // forward forbids fps
    expect(parseNodeCommandBody(JSON.stringify({ type: "preview_open", ref: "a".repeat(32), kind: "screencast", paneId: "p", port: 9222, fps: 5, lifetimeMs: 60_000 }))).toEqual({ type: "preview_open", ref: "a".repeat(32), kind: "screencast", paneId: "p", port: 9222, fps: 5, lifetimeMs: 60_000 });
  });
  test("refuses a lifetime outside the window", () => {
    expect(parseNodeCommandBody(JSON.stringify({ type: "preview_open", ref: "a".repeat(32), kind: "forward", paneId: "p", port: 80, lifetimeMs: 1000 }))).toBeNull();
  });
  test("create_session accepts a screen size and bounds it", () => {
    // clone the existing create_session parse test; add screen {width:1280,height:720} passes, width 100 fails
  });
});
describe("preview link frames", () => {
  const frame = { type: "preview_data", ref: "a".repeat(32), dir: "in", seq: 7, blob: Buffer.alloc(10).toString("base64") };
  test("round trips and enforces the raw blob cap", () => {
    expect(parsePreviewFrame(frame)).toEqual(frame);
    const tooBig = { ...frame, blob: Buffer.alloc(PREVIEW_DATA_MAX_BYTES + 1).toString("base64") };
    expect(parsePreviewFrame(tooBig)).toBeNull();
    const exactlyCap = { ...frame, blob: Buffer.alloc(PREVIEW_DATA_MAX_BYTES).toString("base64") };
    expect(parsePreviewFrame(exactlyCap)).not.toBeNull(); // cap measured on RAW bytes, like RelayFrame's base64RawLength
  });
  test("preview-stream node event parses", () => {
    const ev = { type: "preview-stream", ref: "a".repeat(32), seq: 1, w: 800, h: 600, ts: 123, blob: "AAA=" };
    expect(parseNodeEvent(ev)).toEqual(ev);
  });
});
```

- [ ] **Step 2: Run to verify it fails:** `env -u SHELLOPTS -u BASHOPTS bun test packages/subshell-protocol/src/__tests__/node-frames.test.ts` (expect parse results `null` / unknown command).
- [ ] **Step 3: Add constants** to `ssh-limits.ts`:

```ts
/** Byte cap on a preview lane frame's RAW payload, base64 aside. Shared by both ends. */
export const PREVIEW_DATA_MAX_BYTES = 262_144;
/** Screencast defaults and ceilings for the CDP watch bridge. */
export const PREVIEW_WATCH_FPS_DEFAULT = 5;
export const PREVIEW_WATCH_FPS_MAX = 15;
export const PREVIEW_WATCH_JPEG_QUALITY = 60;
/** Frames the bridge may have in flight toward the plane before it starts dropping. */
export const PREVIEW_WATCH_FRAMES_BUFFERED = 5;
/** Lane quotas: per pane, per node, and per watch bridge. */
export const PREVIEW_FORWARD_SESSIONS_PER_PANE = 4;
export const PREVIEW_SESSIONS_PER_NODE = 16;
export const PREVIEW_WATCH_SUBSCRIBERS_MAX = 8;
/** A forward lane with no bytes both ways for this long self-closes. */
export const PREVIEW_IDLE_MS = 900_000;
/** Lanes are minted with a lifetime inside this window; the command refuses outside it. */
export const PREVIEW_LIFETIME_MAX_MS = 4 * 3_600_000;
export const PREVIEW_LIFETIME_MIN_MS = 60_000;
/** Lane refs double as proxy path secrets: 128 bits of hex. */
export const PREVIEW_REF_RE = /^[0-9a-f]{32}$/;
```

- [ ] **Step 4: Add the grammar** to `node-frames.ts`. Clone the `RelayFrame` validation style exactly (strict base64 via `base64RawLength`, ref via `PREVIEW_REF_RE`):

```ts
/** What a `preview_open` asks for: the raw byte lane, or the read-only CDP screencast. Spec §4's kind union. */
export type PreviewLaneKind = "forward" | "screencast";

/**
 * Opens one preview lane inside the pane's node. For "forward" the node dials
 * 127.0.0.1:<port>; for "screencast" <port> is the CDP port and `fps` is
 * required and bounded. The node never reaches beyond loopback either way.
 */
export interface PreviewOpenCommand {
  type: "preview_open";
  ref: string;
  kind: PreviewLaneKind;
  paneId: string;
  /** Dial target (forward) or devtools port (screencast). Loopback only. */
  port: number;
  /** Screencast only: frames per second the bridge emits; it drops extras before acking. */
  fps?: number;
  /** Self-expiry. The node closes the lane by this deadline whatever the plane does. */
  lifetimeMs: number;
}

/** Asks what the pane's process tree is listening on, plus the CDP port and display if any. */
export interface PreviewPortsGetCommand { type: "preview_ports_get"; paneId: string }

/** The per-node preview switch. Cloned from set_ssh_enabled, same mirror semantics. */
export interface SetPreviewEnabledCommand { type: "set_preview_enabled"; on: boolean; changedAt: string }

/** Why a lane ended. Closed set; spec §6 names them for the UI. */
export type PreviewCloseReason = "viewer-left" | "pane-gone" | "node-dropped" | "slow-link" | "over-cap" | "idle" | "revoked";

/** Plane -> node teardown. Never access-gated: an unknown ref answers closed:false. */
export interface PreviewCloseCommand { type: "preview_close"; ref: string; reason: PreviewCloseReason }
```

Plus, in `NodeCommand`: add all four (`preview_open`, `preview_close`, `preview_ports_get`, `set_preview_enabled`). In `NodeEvent`: add

```ts
| { type: "preview-data"; ref: string; dir: "in" | "out"; seq: number; blob: string }
| { type: "preview-stream"; ref: string; seq: number; w: number; h: number; ts: number; blob: string }
| { type: "preview-closed"; ref: string; reason: PreviewCloseReason }
```

and in the `ready` member block: `previewEnabled?: NodePreviewEnabledWire` (clone how `sshEnabled` rides ready, `daemon.ts:416` sends it). `export interface NodePreviewEnabledWire { on: boolean; changedAt: string }` beside `NodeSshEnabledWire` in the same file. In `create_session`: `/** When set the node allocates a virtual display and exports DISPLAY for the pane's shell. */ screen?: { width: number; height: number }`, bounded 320..4096 both.

Export `PreviewLaneKind` etc. from `src/index.ts`. Do NOT touch `src/index.ts` in a way that pulls a `node:*` builtin into the barrel (mobile Metro rule, `.claude/rules/verification.md`); these files are pure.

- [ ] **Step 5: Wire parses and bump.** Add the four command arms to `parseNodeCommandBody` (the `preview_open` arm enforces the kind-shape rule its test pins: `fps` iff `kind === "screencast"`, bounded), the three arms (`preview-data`, `preview-stream`, `preview-closed`) to `parseNodeEvent` (clone the relay arm), export `parsePreviewFrame` cloning `parseRelayFrame` verbatim with `PREVIEW_DATA_MAX_BYTES`. Then: `NODE_PROTOCOL_VERSION = 23` with this bump-history entry appended where the history lists 21->22:

> **22 -> 23:** the preview surface. Four new commands (`preview_open` with its `forward`/`screencast` kinds, `preview_close`, `preview_ports_get`, `set_preview_enabled`), the `preview_data` link frame and the `preview-data` / `preview-stream` / `preview-closed` node events, the `previewEnabled` ready field, and `create_session`'s optional `screen`. Additive, and breaking anyway: an agent that has not rebuilt never sends the new events, but the gate is exact-match, so it is refused at connect and told to update. Server ships first.

Then `MIN_NODE_VERSION = "2.4.0"` (`versions.ts:123`) and `apps/node/agent/package.json` `"version": "2.4.0"`.

- [ ] **Step 6: Run the census + whole package:** `env -u SHELLOPTS -u BASHOPTS bun run test --filter=@internal/subshell-protocol` (the census test auto-iterates commands; fix every fixture that pins version 22 or the old floor - `bun run test` for `@internal/server` and `@internal/node` will surface them; update in this commit, per doctrine).
- [ ] **Step 7: Build + commit:**

```bash
bunx turbo build --filter=@internal/subshell-protocol
git add packages/subshell-protocol apps/node/agent/package.json
git commit -m "feat(protocol): preview lanes, watches, and displays (protocol 23, floor 2.4.0)"
```

---

### Task 2: Live feed grammar (watch subscribe frames + stream frame)

**Files:**
- Modify: `packages/subshell-protocol/src/live-frames.ts`
- Test: `packages/subshell-protocol/src/__tests__/live-frames.test.ts`

**Interfaces:**
- Produces: `LiveServerFrame` member `{ type: "preview-stream"; id: string; ref: string; seq: number; w: number; h: number; blob: string }` (`id` is the subshell id; a viewer subscribes by pane, never by ref); `LiveClientFrame` members `{ type: "watch"; id: string }`, `{ type: "unwatch"; id: string }`; `parseLiveClientFrame` arms.
- Consumes: Task 1 for the blob concept only.

- [ ] **Step 1: Failing tests** in `live-frames.test.ts`: `parseLiveClientFrame` accepts `{"type":"watch","id":"s1"}` and `{"type":"unwatch","id":"s1"}`, rejects a missing `id`, rejects an extra key, and the file's existing exact-shape style rejects `preview-stream` on the CLIENT leg. Assert the server-frame serializer carries `blob` untouched.
- [ ] **Step 2: Run, watch them fail** (`env -u SHELLOPTS -u BASHOPTS bun test packages/subshell-protocol/src/__tests__/live-frames.test.ts`).
- [ ] **Step 3: Implement** the three union members and the two parse arms. Add JSDoc: the stream frame is only ever published to sockets whose holder has `view` on the row (broker enforces; the frame is not addressed).
- [ ] **Step 4: Rerun the package tests, turbo build the protocol package, commit** `git commit -m "feat(protocol): live watch and preview-stream frames"`.

---

### Task 3: The per-node preview switch, end to end

**Files:**
- Read first (the clone source, mirror it exactly including storage): `apps/server/api/src/services/nodes/ssh-enabled.ts`, its route (`grep -rn "set_ssh_enabled" apps/server/api/src/api/`), its route test; node side: `grep -rn "sshEnabled" apps/node/agent/src` and the set_ssh_enabled executor in `apps/node/agent/src/commands/`.
- Create: `apps/node/agent/src/preview/flags.ts`, `apps/node/agent/src/commands/set-preview-enabled-exec.ts`, `apps/server/api/src/services/nodes/preview-enabled.ts`, the route file beside the ssh one.
- Modify: `apps/node/agent/src/commands/index.ts` (arm), `apps/node/agent/src/daemon.ts` (ready field), `apps/server/api/src/api/index.ts` or wherever the ssh toggle route mounts.
- Test: `apps/server/api/src/api/nodes/__tests__/preview-enabled-route.test.ts` (clone the ssh-enabled route test), `apps/node/agent/src/__tests__/preview-flags.test.ts`.

**Interfaces:**
- Consumes: `SetPreviewEnabledCommand`, `NodePreviewEnabledWire` (Task 1).
- Produces: node `preview/flags.ts`: `getPreviewEnabled(): { on: boolean; changedAt: string } | undefined`, `setPreviewEnabled(state)`, `previewEnabledWire(): NodePreviewEnabledWire | undefined`; plane `preview-enabled.ts`: `getPreviewEnabled(nodeId): Promise<{ on: boolean }>` (row absent = OFF), `setPreviewEnabled(nodeId, userId, on): Promise<void>`.

- [ ] **Step 1: Read the clone source** (`ssh-enabled.ts` both halves and both tests). Note how it persists plane-side state, how it sends the command, how it audits `node.ssh_enabled.update`, and how the node mirror survives restart and drift.
- [ ] **Step 2: Failing route test** cloning the ssh one: cookie actor flips the switch -> 200 + audit row `node.preview_enabled.update` + `sendCommand` (from `@/services/nodes/node-rpc.js`) called with `{type:"set_preview_enabled", on, changedAt}`; system key 403; GET answers `{on:false}` with no row (fail-closed default).
- [ ] **Step 3: Implement the plane half** (clone storage shape verbatim - same table/column kind the ssh switch uses, named `preview_enabled`), then the node half: executor gate-first pattern from the ssh executor (verified cmd only; store mirror file with mode 0600 exactly where the ssh mirror lives; result-before-teardown), `flags.ts` owning the in-process copy, `daemon.ts` ready frame gains `...(previewEnabledWire() ? { previewEnabled: previewEnabledWire() } : {})`.
- [ ] **Step 4: Mirror-drift test** (node side): an external edit to the mirror file between commands is re-read and re-reported, same as the ssh mirror test asserts.
- [ ] **Step 5: Focused runs then commit:** `env -u SHELLOPTS -u BASHOPTS bun run test --filter=@internal/server --filter=@internal/node` (or the two files), `git commit -m "feat: per-node preview switch mirroring the ssh enable posture"`.

---

### Task 4: Port discovery (node)

**Files:**
- Create: `apps/node/agent/src/preview/ports.ts`, `apps/node/agent/src/commands/preview-ports-exec.ts`
- Modify: `apps/node/agent/src/commands/index.ts`, `apps/node/agent/src/commands/context.ts`
- Test: `apps/node/agent/src/__tests__/preview-ports.test.ts`

**Interfaces:**
- Consumes: pane pid from the tmux runner (`TmuxRunner.panePid`, `apps/node/agent/src/tmux-runner.ts:447`), display registry (Task 7; before it exists the `screen` field is `null`).
- Produces: `scanPanePorts(opts: { procRoot?: string; panePid: number })` -> `{ ports: { proto: "tcp" | "tcp6"; port: number; pid: number }[]; cdpPort: number | null; screen: { display: string; rfbPort: number } | null }`; refuses on non-Linux with error id `preview-ports-unsupported`. The `preview_ports_get` command result carries exactly that object. Plane Task 9 caches it 5 s per pane.

- [ ] **Step 1: Failing unit tests** over a fixture `/proc` written into a temp dir:

```ts
// fixture: root/<pid>/stat "pid (name) S ppid ...", root/<pid>/cmdline, root/<pid>/fd/N -> "socket:[INODE]" (symlink target need not exist for readlink), root/net/tcp with "state" column 0A LISTEN rows and the inode column.
test("attributes a listening socket to the deepest descendant that owns it", async () => {
  const r = await scanPanePorts({ procRoot, panePid: 100 });
  expect(r.ports).toEqual([{ proto: "tcp", port: 3000, pid: 102 }]);
});
test("finds the CDP port from a descendant's --remote-debugging-port flag", async () => {
  // fixture: pid 102's cmdline is "chromium --remote-debugging-port=9222" and 9222 is LISTEN
  expect((await scanPanePorts({ procRoot, panePid: 100 })).cdpPort).toBe(9222);
});
test("a socket owned by an outsider never appears", async () => {
  // fixture: socket:[8888] is LISTEN on port 8080 but owned by pid 999, a sibling of the pane subtree
  const r = await scanPanePorts({ procRoot, panePid: 100 });
  expect(r.ports.some((p) => p.port === 8080)).toBe(false);
});
test("no listeners answers with empty arrays, not an error", async () => {
  const r = await scanPanePorts({ procRoot: emptyProcRoot, panePid: 100 });
  expect(r.ports).toEqual([]);
  expect(r.cdpPort).toBeNull();
  expect(r.screen).toBeNull();
});
test("a listening IPv6 loopback row parses", async () => {
  // net/tcp6 fixture row with "::1" local address, state 0A, owned by a descendant
  const r = await scanPanePorts({ procRoot, panePid: 100 });
  expect(r.ports).toContainEqual({ proto: "tcp6", port: 4321, pid: 102 });
});
```

- [ ] **Step 2: Run, fail.**
- [ ] **Step 3: Implement `ports.ts`:** parse `net/tcp` + `net/tcp6` (`state === "0A"`, `local_address` hex `port:ip`; only accept ip `0100007F`/`00000000...1` loopback AND `00000000` - an all-zeros bind still counts, the node will dial loopback regardless), build ppid map from `*/stat`, BFS descendants of `panePid`, read each pid's `fd/*` readlinks, intersect inodes, take the deepest pid per inode. `cdpPort`: descendant `cmdline` containing `--remote-debugging-port=N` AND N in the port list. `screen`: `display.getFor(paneId)` (returns null until Task 7). Non-Linux: throw the named refusal before touching fs. `procRoot` exists only so tests can fake the tree; default `"/proc"`.
- [ ] **Step 4: Executor arm:** gate-first (preview switch ON else refuse naming remedy "turn on Preview for this node"; pane must have a live pid - `preview-ports-pane-gone`), result = `scanPanePorts` output. Slow-work rule: keep it under the chain budget - one pass reading only the pane subtree, `pending: true` ack NOT needed (it is fast), but cap the fd walk (`ports.ts` bounds: max 512 pids scanned; over-cap answers `preview-ports-overcap`).
- [ ] **Step 5: Green + commit** `feat(node): attribute pane subtrees' listening sockets, with CDP and display discovery`.

---

### Task 5: Forward lanes (node executor)

**Files:**
- Read first: `apps/node/agent/src/commands/ssh-relay-exec.ts` + `apps/node/agent/src/relay-send.ts` (the pump, gate-first, pending-ack, close-not-gated, tombstone shapes to clone).
- Create: `apps/node/agent/src/preview/forward.ts`, `apps/node/agent/src/commands/preview-open-exec.ts` (dispatches on `kind`; this task lands the `forward` branch, Task 6 adds `screencast`), `apps/node/agent/src/commands/preview-close-exec.ts`
- Modify: `commands/index.ts`, `commands/context.ts` (a `previewForward` registry in ctx), `daemon.ts` (inbound `preview_data` frame arm beside the relay intake; node->plane `preview-data` emission uses the same sender as relay emission).
- Test: `apps/node/agent/src/__tests__/preview-forward.test.ts` (the `commands-ssh-relay.test.ts` precedent; find with `ls apps/node/agent/src/__tests__/ | grep relay`).

**Interfaces:**
- Consumes: `PreviewOpenCommand`, `PreviewCloseCommand`, `PreviewDataFrame`, `preview-data` NodeEvent, limits (Task 1).
- Produces: `forward.ts`: `openLane({ref, port, paneId, lifetimeMs}): Promise<void>` (dials and registers), `closeLane(ref, reason): { closed: boolean }`, `ingestInboundFrame(frame: PreviewDataFrame): void`, `laneCount(paneId?)`, `closeAllForNode(reason)` (daemon link-drop hook). Result of `preview_open`: `{ ok: true }` after dial connects, or refusal ids `preview-target-refused`, `preview-node-off` (switch), `preview-lane-over-node-cap`, `preview-lane-over-pane-cap`, `preview-pane-gone`.

- [ ] **Step 1: Failing tests.** Start a real in-test echo server (`Bun.serve` or `net.createServer` on an ephemeral loopback port). Build a fake command context capturing emitted `preview-data` events. Assert: (a) open echoes inbound bytes to the target and target bytes back as `dir:"out"` with monotonic `seq`; (b) dial to a closed port answers the refusal, registers nothing; (c) `closeLane` on an unknown ref answers `closed:false` (tombstone) and `preview_close` is NOT access-gated (assert no enabled check on the close path); (d) node quota: the 17th open refuses with the named id, per-pane the 5th; (e) EOF: when the target socket ends, the lane is deregistered and the node emits `{ type: "preview-closed", ref, reason: "target-gone" }`; lifetime expiry emits `preview-closed` with `idle` when no bytes flowed (and no event at all if `preview_close` already landed first); (f) slow-link: with `PREVIEW_*` overridden low, an overflowing outbound pump closes the lane and emits `preview-closed` with `slow-link`.
- [ ] **Step 2: Fail.** - [ ] **Step 3: Implement `forward.ts`:** map ref->lane; dial `net.connect({ host: "127.0.0.1", port })`, on error retry `host:"::1"` once, both failures = refused (loopback-only: never accept a host from the wire, port comes from the verified command). Socket data -> base64 -> emit `preview-data` event, seq per lane monotonic; if the link's buffered amount crosses `PREVIEW_DATA_MAX_BYTES * PREVIEW_WATCH_FRAMES_BUFFERED`, close `slow-link`. `ingestInboundFrame` (dir "in") writes the socket; writes count as activity; idle timer `PREVIEW_IDLE_MS` self-closes with `preview-closed` reason `idle`. Every lane death (socket end/error, idle, slow-link, forced close) deregisters first, then emits exactly one `preview-closed` event with its reason. Result-before-teardown and pending-ack exactly as `ssh-relay-exec.ts` does them. Wire `preview_open` result as the post-connect ack (the dial is the chain's work; it is fast, no pending needed, matching relay's connect behavior - read ssh-relay-exec and copy its verdict).
- [ ] **Step 4: Wire intake:** daemon inbound parser: where relay frames route (`parseRelayFrame` call site in `daemon.ts`), add `parsePreviewFrame` -> `ctx.previewForward.ingestInboundFrame`; `preview_close` command arm calls `closeLane` unconditionally.
- [ ] **Step 5: Green + commit** `feat(node): forward preview lanes over loopback sockets with named slow-link teardown`.

---

### Task 6: CDP watch bridge (node executor)

**Files:**
- Create: `apps/node/agent/src/preview/cdp-bridge.ts`
- Modify: `apps/node/agent/src/commands/preview-open-exec.ts` (add the `screencast` kind branch)
- Modify: `commands/index.ts`, `daemon.ts` (emit `preview-stream` with the same sender as Task 5's events)
- Test: `apps/node/agent/src/__tests__/preview-watch-exec.test.ts`

**Interfaces:**
- Consumes: `PreviewOpenCommand` (`kind: "screencast"`, `port` is the CDP port, `fps` from the wire), `preview-stream` NodeEvent, `PREVIEW_WATCH_*` (Task 1).
- Produces: `startBridge({ref, cdpPort, fps, lifetimeMs}): Promise<void>`, `stopBridge(ref)`, `bridgeCount()`; refusals `preview-cdp-unreachable` (remedy text names launching chromium with `--remote-debugging-port`), switch-off and per-node cap reuse Task 5's ids (bridges count toward `PREVIEW_SESSIONS_PER_NODE`).
- Emission contract (Task 11 depends on it): one `preview-stream` per delivered frame with `seq` monotonic per ref, `w/h` from the CDP frame metadata, `ts = Date.now()`, `blob` the JPEG base64.

- [ ] **Step 1: Failing test with a fake CDP endpoint.** In-test: `Bun.serve` answering `/json/list` with `[{ type: "page", webSocketDebuggerUrl: wsUrl }]` and a `Bun.serve({ websocket: ... })` handler that records received messages and pushes three `Page.screencastFrame` notifications with tiny JPEG payloads. Assert: start sends `Page.startScreencast` with `{ format: "jpeg", quality: PREVIEW_WATCH_JPEG_QUALITY }` and `everyNthFrame: 1`; each frame is acked with `Page.screencastFrameAck` (`sessionId` echoed) even when its `preview-stream` emission is dropped by the fps throttle (fps 1, three frames in quick succession -> exactly one emission, three acks); socket close mid-stream stops the bridge and (clone Task 5's death-notification mechanism) tells the plane; `stopBridge` closes cleanly.
- [ ] **Step 2: Fail.**
- [ ] **Step 3: Implement.** Global `fetch` + global `WebSocket` (both exist under bun on the node; no new deps). Sequence: GET `http://127.0.0.1:${cdpPort}/json/list` (loopback literal, never the wire value), prefer `type === "page"`, else first target, none -> `preview-cdp-unreachable`. Open WS to `webSocketDebuggerUrl` (validate it starts `ws://127.0.0.1:` or `ws://localhost:` before dialing - the port came from /proc, the URL comes from a socket answer; distrust it). Then: `Page.enable`, `Page.startScreencast {format:"jpeg", quality, everyNthFrame: 1}`. On `Page.screencastFrame` notification: ack immediately (always ack, even when dropping), throttle emissions to `fps` (interval floor `Math.ceil(1000 / fps)`), enforce `PREVIEW_WATCH_FRAMES_BUFFERED` in flight. Idle: no frame for 60s -> self-close (browser closed). Lifetime timer. Refusals/teardown exactly the executor contract.
- [ ] **Step 4: Executor branch** (`preview-open-exec.ts`, `kind === "screencast"`): gate-first, pane pid check, counts toward node caps. Add one unit test that the same open refuses a screencast whose `fps` is absent (grammar already rejects it; assert the branch's own bounds message is never reached with junk).
- [ ] **Step 5: Green + commit** `feat(node): CDP screencast bridge with always-ack and fps throttle`.

---

### Task 7: Virtual displays (node) and launch-time `screen`

**Files:**
- Create: `apps/node/agent/src/preview/display.ts` (no new command arm: displays come up through `create_session.screen`, and `preview_ports_get` reports one via its `screen` field, both spec-shaped)
- Modify: `commands/index.ts`, pane-create path in tmux-runner (find: `grep -rn "DISPLAY\|create_session" apps/node/agent/src/tmux-runner.ts` and the command that owns pane creation), daemon startup (hourly orphan sweep), pane-death hook (grep the exit-status path in tmux-runner).
- Test: `apps/node/agent/src/__tests__/preview-display.test.ts`

**Interfaces:**
- Consumes: `create_session.screen`, `dataDir` (the daemon's data dir - same root `<dataDir>/ssh/<paneId>/` uses; grep its derivation once and reuse the helper).
- Produces: `display.openFor(paneId, {width,height}, deps?): Promise<{display: string; rfbPort: number}>`, `display.getFor(paneId)`, `display.closeFor(paneId, reason)`, `display.sweepOrphans(alivePaneIds)`; `deps` injects `{ spawn, which, sleep, now }` so unit tests fake Xvfb.

- [ ] **Step 1: Failing unit tests** (fake `which`/`spawn`): allocation picks `:90` then the next free (a lockfile that exists is taken); state dir is created 0700 with log files 0600; missing `Xvfb` -> refusal `preview-display-missing-binaries` whose message names the remedy (install `xvfb` and `x11vnc`) and touches nothing; non-Linux -> `preview-display-unsupported` by name; readiness waits for the X socket then the rfb port and refuses `preview-display-not-ready` after the budget; `sweepOrphans` tears down and releases every display whose pane id is absent from the alive list; rfb port chooser re-tries on a collision.
- [ ] **Step 2: Fail.**
- [ ] **Step 3: Implement:** numbers `:90..:199`, lock `<dataDir>/displays/.display-NN.lock` opened `wx` (EEXIST = taken); state `<dataDir>/displays/<paneId>/`; spawn `Xvfb :NN -screen 0 WxHx24 -nolisten tcp` (logfile inside state dir), poll `/tmp/.X11-unix/XNN`; pick rfb port from 5910+ by `net.listen` probe, then spawn `x11vnc -display :NN -rfbport P -localhost -forever -shared -bg`-less (keep the child, `-forever`, no `-auth`, logfile); `Bun.which` both first. `closeFor`: SIGTERM both, unlink lock, drop the dir's logs. Register in the in-process map AND return `screen` to `ports.ts` (Task 4's `screen` field goes live here).
- [ ] **Step 4: `create_session.screen`:** bounded in grammar already (Task 1). In the pane-create path: if `screen` present, `openFor` BEFORE spawn and inject `DISPLAY=:NN` into the pane env beside the SUBSHELL_* credentials (same env builder); if `openFor` refuses, fail the create with its named reason; pane-exit path calls `closeFor(paneId)`. Non-Linux + screen set: create refuses with `preview-display-unsupported` (never silently drop it).
- [ ] **Step 5: Sweep timer** in daemon startup: hourly, `sweepOrphans(live pane ids)` (clone the ssh per-pane-dir retention sweep's shape if one exists; else an interval beside the other self-timers).
- [ ] **Step 6: Green + commit** `feat(node): Xvfb+x11vnc virtual displays per pane, DISPLAY injected at launch`.

---

### Task 8: The preview broker (plane)

**Files:**
- Create: `apps/server/api/src/services/preview-broker.ts`, `apps/server/api/src/services/__tests__/preview-broker.test.ts`
- Modify: the node-link event intake (the caller that feeds `routeRelayFrame`, `ssh-relay.service.ts:512`; put `preview-stream` -> `broker.onStreamEvent`, `preview-data` -> the pv proxy's lane pump (Task 10 consumes `broker.subscribeLane`); link-drop hook -> `broker.onNodeDropped(nodeId)`), `api/users/set-user-disabled.route.ts` + `set-user-role.route.ts` (add `closeAllForUser(userId, "revoked")` beside their `dropLiveSocketsFor` calls), the shares route likewise.
- Test helper: `@/__tests__/helpers/test-database.js` for audit rows.

**Interfaces:**
- Produces (Tasks 9-11): `openForward({ viewerUserId, paneId, nodeId, port }): Promise<{ ref }>` (edit-gated by the route, not the broker), `openLaneForConnection(ref): Promise<{ laneRef }>` + `subscribeLane(ref, cb: (e: { bytes: Uint8Array } | { closed: PreviewCloseReason }) => void): () => void` (the broker maps node `preview-closed` events to `closed`; lane bytes arrive as `bytes`) + `sendLaneBytes(laneRef, bytes)`, `closeForward(ref, viewerUserId, reason)`, `startWatch({ viewerUserId, paneId, nodeId, cdpPort }): Promise<{ ref }>` (dedupes per pane+cdpPort; joins the viewer set, cap `PREVIEW_WATCH_SUBSCRIBERS_MAX` -> refusal `preview-watch-over-cap`), `stopWatch(viewerUserId, ref)`, `dropViewer(viewerUserId)` (socket close), `sessionFor(ref)`, `getPorts(nodeId, paneId)` (5 s cache, RPC via `sendCommand` from `@/services/nodes/node-rpc.js`), `closeAllForNode(nodeId, reason)`, `closeAllForUser(userId, reason)`, `onStreamEvent(ev)`; `PreviewSession { ref, kind, paneId, nodeId, port, createdBy, createdAt, viewers: Set<string>, lastActivity }`.
- Consumes: `sendCommand`, Task 1 grammar, audit pattern from `ssh-relay.service.ts:437-455` (actorUserId null, metadata `{ ref, paneId, nodeId, viewerUserId, lifetimeMs }`).

- [ ] **Step 1: Failing tests** (fake `sendCommand`, real test DB for audit): open sends `preview_open` with a fresh 32-hex ref, mints session, audits `node.preview_forward.open`; refusal propagates the node's id (no session recorded); per-pane cap 4 / node cap 16 (counting lanes too - a lane beyond cap queues up to 8 waiters then answers `preview-lane-over-cap`); watch dedupe: second viewer does NOT re-send `preview_open` (kind `screencast`, `port: cdpPort`, `fps: PREVIEW_WATCH_FPS_DEFAULT`), its join returns the existing ref; last viewer leaving sends `preview_close` reason `viewer-left` and audits `node.preview_watch.close`; stream fan-out: `onStreamEvent` delivers `{id: paneId, ref, seq, w, h, blob}` to each viewer's injected sender exactly once and counts activity; idle sweep (injected clock) closes at `PREVIEW_IDLE_MS` with reason `idle`; `closeAllForUser` audits closes with `revoked`; `closeAllForNode` does the same with `node-dropped`; `getPorts` caches for 5 s then re-RPCs.
- [ ] **Step 2: Fail.**
- [ ] **Step 3: Implement** with module-singleton pattern + `resetForTests` per `.claude/rules/code-style.md`; lane machinery: a per-ref emitter the proxy subscribes to; every node command via `sendCommand`; every close path audits the pair (`node.preview_forward.open|close`, `node.preview_watch.open|close`, `node.preview_display.open|close`); timers self-expire like the ssh broker's do (read `ssh-relay.service.ts` broker for the exact habit).
- [ ] **Step 4: Green + commit** `feat(server): preview broker with quotas, refcounted watches, and revocation`.

---

### Task 9: REST surface and authz matrix

**Files:**
- Create: `api/subshells/preview-info.route.ts`, `preview-open.route.ts`, `preview-close.route.ts`, `preview-watch-start.route.ts`, `preview-watch-stop.route.ts`, `api/subshells/index.ts` (mount), `api/subshells/__tests__/preview-routes-auth.test.ts`
- Modify: `api/subshells/create-subshell.route.ts` (+ `screen` body field -> service -> `create_session` command; find where the service builds the command: `grep -rn "create_session" apps/server/api/src/services/ | head`)
- Test: the auth matrix file (clone the actor-table shape from `__tests__/subshell-input-ssh.test.ts` and `subshell-view-ssh.test.ts`).

**Interfaces:**
- Consumes: broker (Task 8), `loadSubshellAccess` + `accessAtLeast` (`src/lib/subshell-access.ts:32/:72`), disabledReason from `getPreviewEnabled` (Task 3) + node online + ready `previewEnabled` presence (older-but-23 agents that predate the field don't exist; absence means an agent that never flipped - treat missing as OFF).
- Produces (spec §6's exact paths): `GET /api/subshells/:id/preview` -> `{ disabledReason: "preview-disabled" | "node-offline" | "pane-gone" | null, ports, cdpPort, screen, access }`; `POST /:id/preview/open` body `{port}` -> `{ proxyBase: "/pv/<ref>/" }`; `DELETE /:id/preview/open/:ref` -> `{ closed: boolean }`; `POST /:id/preview/watch` body `{cdpPort}` -> `{ ref }`; `DELETE /:id/preview/watch/:ref`; create-subshell body gains optional `screen: {width,height}`.

- [ ] **Step 1: Write the auth matrix test first** (it is the deliverable's spine). For each route row: owner/`edit` grant -> 200 (POST/DELETE as specified); `view` grant -> 200 on GET and POST/DELETE watch, 403 on forward; foreign account -> 404 on ALL five; another pane's own subshell token -> resolves as its OWNER with shares off (the §4 sibling posture): 200 on rows for the OWNER's own panes, 404 on foreign ones; pin both halves and cite `docs/security.md` §4 in the test comment; node key -> 403 (permanent guard rejection §5.5); system key -> the full human gate as the `system` service user: nowhere without a deliberate grant, and a granted `edit` row DOES reach it (spec §6; assert the positive too, so the rule is pinned in both directions). Forward body bounds: port 0 / 70000 / 1.5 / string -> 400 at the schema (Elysia `t.Integer({ minimum: 1, maximum: 65535, description: ... })`, every property described per code-style rule).
- [ ] **Step 2: Fail.** - [ ] **Step 3: Implement routes** (each its own file, schemas as named constants, `detail: { operationId, tags: ["subshells"] }`); disabledReason computed BEFORE any node RPC (offline pane = cheap 404s first). Mount into the already-mounted subshells instance in `index.ts` (avoid the Elysia `App` TS2589 trap; new route files folded into an existing mounted group are the sanctioned shape).
- [ ] **Step 4: create flow:** body schema optional `screen` with 320..4096 bounds on both fields, passed through to `create_session`; refusal from the node surfaces as the create error verbatim.
- [ ] **Step 5: Green + commit** `feat(api): preview REST surface with the view/edit authz split`.

---

### Task 10: The /pv proxy

**Files:**
- Create: `apps/server/api/src/preview/lane-duplex.ts`, `preview/pv-http.ts`, `preview/pv-ws.ts`, `preview/__tests__/pv-proxy.test.ts`
- Modify: server bootstrap (mount HTTP `.all("/pv/:session/*")` route and a ws handler on the same wildcard path beside the ws plugin's routes), `package.json` (add `ws@8.22.0` - current latest, then `syncpack fix`; used ONLY with its documented stream override so it rides a lane duplex: `new WebSocket(url, { net: { createConnection: () => laneDuplex } })`; verify that override reads in `node_modules/ws/lib/websocket.js` before coding against it - the option name is the public one, the file is the proof).

**Interfaces:**
- Consumes: `broker.sessionFor(ref)`, `broker.openLaneForConnection(refSession): Promise<{ laneRef }>` + `broker.subscribeLane(refSession, cb)` where cb receives `{ bytes: Uint8Array } | { closed: PreviewCloseReason }` (broker maps the node's `preview-closed` onto it), `broker.sendLaneBytes(laneRef, bytes)`, `PreviewDataFrame` (Task 1).
- Produces: `lane-duplex.ts`: `class LaneDuplex extends Duplex` (constructor takes `{ pushOut(bytes), onBytes(cb), onClose(cb), pause(): void }`; `_write` frames through `sendLaneBytes`; inbound lane bytes `push`).

- [ ] **Step 1: Failing unit tests** for the pieces that carry security meaning (run over a real in-proc `Bun.serve` target and a fake "node" = a helper that pumps `preview_data` frames to a loopback socket, ~25 lines of the Task 5 pump repeated in-test):
  - outbound `Set-Cookie` gets `Path=/pv/<ref>/` forced, `Domain` and `Secure` flags preserved otherwise untouched;
  - inbound request carries a `Cookie` header rebuilt from the per-session jar only; the browser's own `Cookie` header NEVER reaches the target (send `Cookie: session=<plane-cookie>` and assert the target saw only jar contents);
  - `Host` arrives at the target as `127.0.0.1:<port>`;
  - an upstream `Content-Security-Policy` keeps every directive EXCEPT `frame-ancestors` which is stripped (a test CSP with three directives -> two survive);
  - a relative `Location: /foo` comes back prefixed `/pv/<ref>/foo`;
  - a WS upgrade carrying binary frames round-trips a payload byte-exact (fake target echoes);
  - an upgrade whose `Origin` differs from the plane's own origin is refused (and same-origin is not);
  - an unknown `/pv/<secret>/` answers 404 with nothing leaked.
- [ ] **Step 2: Fail.**
- [ ] **Step 3: Implement `pv-http.ts`:** resolve session (404 if unknown ref); `openLaneForConnection` (cap/queue rules live in the broker - proxy just awaits); build `LaneDuplex`; `node:http.request({ createConnection: () => duplex, method, path: strippedPath + query, headers: transformed })`; transform: strip `cookie`, set `host` literal `127.0.0.1:${port}`, drop `connection`/`keep-alive` (one-shot lane per connection, the lane closes after the response completes - the browser reconnects per request, the jar carries state); response: strip hop-by-hops, rewrite `set-cookie` Path, rewrite `location`, strip `frame-ancestors` from both `content-security-policy` and `content-security-policy-report-only`; stream body straight through; on lane `closed` before the body completes -> 502 with a plain-text line naming the reason (do NOT retry mid-stream: a POST may have landed).
- [ ] **Step 4: Implement `pv-ws.ts`:** ws handler on `/pv/:session/*` (Elysia `.ws` on the same wildcard, beside the ws plugin's registrations; the upgrade path check must accept any suffix - noVNC and Vite HMR each dial their own path): check `Origin` against the plane's own origin (same rule `/ws/live` uses), resolve session, open a dedicated lane, dial `new WebSocket(wsUrl, { net: { createConnection: () => laneDuplex } })` with `wsUrl = ws://127.0.0.1:${port}/${restPathFromUpgradeUrl}`; pump both ways with the duplex backpressure (buffer beyond `PREVIEW_DATA_MAX_BYTES * 4` -> close both `slow-link`); close either side -> close both, reason `viewer-left`.
- [ ] **Step 5: Green; `bun run lint:lockfile` if the dependency was added; commit** `feat(server): same-origin /pv proxy with cookie jar, CSP carve-out, and WS tunneling`.

---

### Task 11: Live feed plumbing and the §11.14 control

**Files:**
- Modify: `ws/live-ws.ts` (client frame switch), `ws/live-registry.ts` (add `sendToUsers(userIds: Iterable<string>, frame: LiveServerFrame)` iterating the existing userId->sockets map), `ws/__tests__/live-ws.test.ts`, `ws/__tests__/live-consistency.test.ts`, `services/live-bus.ts` ONLY if the publish path needs the frame type in its union.
- Test: extend the two files.

**Interfaces:**
- Consumes: Tasks 2 (frames), 8 (`startWatch/stopWatch/dropViewer`), `loadSubshellAccess`.
- Produces: for a socket holder with `view`+ access, `{"type":"watch","id":paneId}` -> broker dedupe + later frames arrive as `{"type":"preview-stream","id","ref","seq","w","h","blob"}` via `sendToUsers`; socket close -> `dropViewer`.

- [ ] **Step 1: Extend `live-ws.test.ts`:** watch from a view grant delivers a stream frame whose `blob` passes untouched; watch from a foreign pane never reaches the broker (spy) and the frame is ignored without dropping the socket; unwatch stops delivery; close drops the viewer.
- [ ] **Step 2: Extend `live-consistency.test.ts` (THE control; read its current matrix first, do not weaken any row):** add, for every (viewer, access) pair already in it, a watch case asserting the set of sockets that receive `preview-stream` for pane P is EXACTLY the set that has `view`-+ access to P through the REST path's own resolver - no more (not admins! not the owner's other sockets that never sent `watch`), no less. A revocation mid-stream (grant removed) must reach the already-open live socket as a stream-stop: reuse whatever mechanism the matrix uses for access changes; the pane row itself surviving is the rule (the socket stays open; frames just stop).
- [ ] **Step 3: Implement** (small): two arms in live-ws's parsed-frame switch calling broker + `sendToUsers`; the diff-test rows drive any broker-side leak fixes.
- [ ] **Step 4: Green + commit** `feat(server): /ws/live watch subscriptions gated through the live authorization control`.

---

### Task 12: Dashboard preview section, hook, and Watch viewer

**Files:**
- Create: `apps/server/web/src/hooks/use-subshell-preview.ts`, `lib/preview-bus.ts`, `components/preview/preview-section.tsx`, `components/preview/port-list.tsx`, `components/preview/watch-viewer.tsx`, `components/preview/preview-toggle.tsx`
- Modify: `routes/subshells_.$id.tsx` (compose the section), `hooks/use-live-subshells-feed.tsx` (dispatch `preview-stream` frames into the bus), node settings page (find the ssh toggle's component via `grep -rln ssh apps/server/web/src/components | head`; the preview toggle sits beside it, same disabled/tooltip posture), create/launch dialog (optional virtual display checkbox -> `screen` body field).
- Test: `components/preview/__tests__/preview-section.test.tsx` (clone whatever render harness `routes/__tests__/setup.test.tsx` uses; if the SPA has a lighter component-test precedent, follow it - list `find apps/server/web/src -name "*.test.ts*"` and imitate).

**Interfaces:**
- Consumes: Task 9 routes (via the Eden treaty client - after adding routes, `bunx turbo build --filter=@internal/server` so types flow, per `.claude/rules/build.md`), Task 11 frames via the bus.
- Produces: bus API `subscribePreview(paneId, cb): () => void`; hook API `{ info, isLoading, openPort, closePort, startWatch, stopWatch }`.

- [ ] **Step 1: Tests** (render-level): a `view`-access render shows Watch toggles and NO Open buttons; `edit` adds Open (it opens `info.proxyBase` in a new tab via `window.open`, assert the spy); `disabledReason` renders the actual reason string as a disabled tooltip, not a mystery (`"preview-disabled"` -> the switch's remedy wording, per AGENTS disabled-control rule); a stale `ports` list older than 5 s (fake clock + fake fetch) re-requests on section focus; Watch viewer swaps its `src` to the newest frame blob's `data:image/jpeg;base64,${blob}` and ignores a lower `seq` (out-of-order arrival).
- [ ] **Step 2: Fail.**
- [ ] **Step 3: Implement.** Port rows are `label` over `detail` per the design system; badges `server` / `browser-debug` / `screen`; the section header follows the short-fixed-title rule ("Preview" is fine as a section heading; per-action copy names the act: "Open in a new tab", "Watch", "Stop watching"). `watch-viewer.tsx` renders an `<img>` sized to the latest `{w,h}`, with the fps and pane name in `detail`. No em dashes in copy.
- [ ] **Step 4: `bunx turbo build` then green tests + commit** `feat(web): preview section with port list, watch viewer, and the node switch`.

---

### Task 13: Screen viewer with @novnc/novnc

**Files:**
- Create: `apps/server/web/src/components/preview/screen-viewer.tsx`
- Modify: `apps/server/web/package.json` (`bun add @novnc/novnc` then `syncpack fix` && `bun install`; pin exact `1.7.0`), `preview-section.tsx` (Screen action when `info.screen` and `edit`: open a dialog hosting the viewer)
- Test: `components/preview/__tests__/screen-viewer.test.tsx` (mock the lazy import; assert connect URL is `${wsProto}//${location.host}${proxyBase}` and disconnect reasons render: `slow-link`, `revoked`, `viewer-left` each with a human line and the retry that is safe to offer).

**Interfaces:** Consumes: forward lane (`proxyBase` from the existing forward-open call for `info.screen.rfbPort` - Screen REUSES the forward lane, zero new protocol); produces `screen-viewer.tsx` component.

- [ ] **Step 1: Read the library's shape:** `sed -n 1,80p node_modules/@novnc/novnc/core/rfb.js` (constructor `(target, url, options)`; check what option names it takes for a raw path). The connect URL is the lane's WS tunnel root: `new RFB(el, \`wss?://host/pv/<ref>/\`)`, `scaleViewport = true`, `focusOnClick = true`, shared-viewer default.
- [ ] **Step 2: Failing test** (mock `import("@novnc/novnc")`; the component calls it only on mount).
- [ ] **Step 3: Implement** with `const { default: RFB } = await import("@novnc/novnc")` inside the dialog mount effect (SPA precedent `lib/ssh.ts` does exactly this for its lazy feature; the no-dynamic-import rule governs the bun-compiled binaries, and Vite chunks it - state that reason in the component's JSDoc). Cleanup disconnects RFB (lane `viewer-left`).
- [ ] **Step 4: MPL attribution:** the package ships `LICENSE.txt`; check whether the repo keeps a third-party notices file (`grep -rn -il "third.?party\|THIRD_PARTY" apps/website apps/docs docs | head`) - if one exists, append the `@novnc/novnc` MPL-2.0 entry; if not, the package.json license field plus `bun run lint:licenses` is the record. Say which in the commit body.
- [ ] **Step 5: Green + commit** `feat(web): noVNC-backed screen viewer over the forward lane`.

---

### Task 14: e2e, docs, changeset, boundary verification

**Files:**
- Create: `e2e/preview.spec.ts` (gated like the suite's existing skip rules; `e2e/AGENTS.md` governs), `apps/docs/content/docs/preview.mdx` (user procedure: enable per node, watch a browser, open a server, screen on Linux), changeset via `bunx changeset` (`@internal/server` minor + `@internal/node` minor, one file, describes the feature once; never hand-edit CHANGELOGs).
- Modify: `apps/server/api/AGENTS.md` (audit inventory gains the six `node.preview_*` actions + a preview-lane rules paragraph: plane sees proxied bytes deliberately, spec §8; the §11.14 control now covers watch frames), `docs/security.md` (pointer paragraph, matching how the relay lane is accounted), `apps/node/agent/AGENTS.md` (preview executors join the executor inventory; loopback-only invariant; Xvfb/x11vnc as optional runtime deps with named refusals).

- [ ] **Step 1: e2e, API-level through `e2e/stack.ts` (async helpers only - the sync-spawn starvation trap):** launch a terminal pane running `bun -e 'Bun.serve({port:4123, fetch: () => new Response("ok")})'`; poll `GET /api/subshells/:id/preview` (as owner cookie) until `ports` includes 4123; `POST forward {port:4123}`; fetch `http://localhost:3199/pv/<ref>/` and assert body `ok` and the proxied response's `set-cookie` path rewrite by setting a cookie from the target (extend the fake? no: the e2e target can just `Set-Cookie: t=1`); watch/unwatch round trip asserts the live socket receives one `preview-stream` when a fake stream event is injected through the broker seam (a real CDP chromium leg is the container run below, not the shared CI container); clean up every session at the end.
- [ ] **Step 2: Real-leg container run (manual, record results in the PR-free branch log):** on this host or a Linux container with `xvfb`, `x11vnc`, and `chromium`: launch a pane with `screen`, run `chromium --remote-debugging-port=9222 http://localhost:4123` in it, verify Watch frames arrive (screenshot diff), Screen lane connects a noVNC RFB handshake (assert `RFB 003.008` greeting through `/pv/`), ports list shows `{4123, 9222, screen}`. On the mac node: verify every preview route answers its named refusal (`preview-ports-unsupported`, `preview-display-unsupported`) - never a hang.
- [ ] **Step 3: Docs paragraphs** in the four files; voice rules; no em dashes (`bun run lint:prose`).
- [ ] **Step 4: Full boundary:** `bun run verify-types && bun run lint:check && bun run lint:prose && bun run test` (then `bunx turbo build` once more; if `bun run test` surfaces the protocol-23 fixtures nobody updated, fix and re-run).
- [ ] **Step 5: Commit** `docs+test: preview e2e, security accounting, and the user guide`, then push `feat/pane-preview`. **No PR** - hand the user the test checklist (node switch UI, watch a live browser pane, open a dev server, screen on Linux, refusals on mac).
