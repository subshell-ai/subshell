# Pane Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a dashboard user see what a pane's process is showing: proxy a pane's loopback server (Open), screencast a pane's browser over CDP (Watch), and view a Linux pane's virtual display (Screen).

**Architecture:** A preview lane generalizes the ssh relay lane: the plane brokers byte lanes keyed by opaque ref, the node dials `127.0.0.1:<port>` only, and three surfaces ride that lane or the `/ws/live` feed. Protocol bumps 22 -> 23 (exact-match gate). See the spec for the full design and its security argument.

**Tech Stack:** Bun, Elysia, TypeScript, React 19 (Vite SPA), tmux node agent, `@novnc/novnc` 1.7.0 (MPL-2.0), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-21-pane-preview-design.md` (approved; §12 settled). Read it before any task; this plan argues from it. The pane-launch command on disk is `launch` (`node-frames.ts:784`), so where the spec's §12 summary or older notes say "create_session", read `launch`.

## Global Constraints

- Protocol doctrine (spec §4): `NODE_PROTOCOL_VERSION` 22 -> 23 this round, exact-match gate at connect (server ships first; a lagging agent is held with an update message, never feature-gated). `MIN_NODE_VERSION` (`packages/subshell-protocol/src/versions.ts:123`, today `"2.2.0"`) and `apps/node/agent/package.json` (today `"2.3.0"`) rise to `"2.4.0"` **in the same commit as the bump**; after this the floor equals the shipping version, which is how the floor crosses an exact-match protocol.
- Node executor contract (spec §5 + `apps/node/agent/AGENTS.md`): act only on verified commands, result before anything long-running (`pending: true` + off-chain work), self-expiring timers, never `process.exit`, refusals name ids and remedies. The forward lane's connect MUST follow the `ssh-relay-exec.ts` A-branch (`:101` returns `{ ok: true, data: { ..., pending: true } }` and connects off the exec chain): a SYN-blackholed target must not park unrelated commands.
- Dialing is loopback-only (`127.0.0.1` / `::1`), both forward and CDP; the bridge also distrusts any `webSocketDebuggerUrl` not aimed at loopback. Non-loopback is out of scope forever (spec §11).
- Close reasons are a closed set (spec §6's seven, plus `not-cdp` from its §9 error table and `target-gone` from decision 3): `viewer-left`, `pane-gone`, `node-dropped`, `slow-link`, `over-cap`, `idle`, `revoked`, `not-cdp`, `target-gone`.
- Watch fps is clamped node-side to `[PREVIEW_WATCH_FPS_MIN, PREVIEW_WATCH_FPS_MAX]` = [1, 5] (spec §4/§12.2); `fps` is OPTIONAL on the wire and defaults to 5.
- NO dynamic `import()` anywhere in the repo except `packages/pane-runtime/src/plugin-runtime.ts` (the one named exception in `.claude/rules/code-style.md`). The SPA has no code-splitting precedent on disk; noVNC ships as a static import (decision 4).
- Pinned dependency versions: after `bun add`, run `syncpack fix` then `bun install`; check with `bun run lint:lockfile`.
- Authz: watch streams require `view`, every lane (proxy bytes, display) requires `edit`; a foreign pane answers 404, never 403. `/ws/live` remains the second authorization path: any new broadcast must pass the viewer-vs-row diff control in `apps/server/api/src/ws/__tests__/live-consistency.test.ts` (spec §6: "grows preview rows as a required task, not a follow-up"; `docs/security.md` §11.14).
- Voice: no U+2014 anywhere authored (`bun run lint:prose`); UI copy rules in `AGENTS.md`; design tokens only (`bun run lint:design`).
- Tests run via scripts (`bun run test --filter=<pkg>`, never bare `bun test` for suites); invoke bash-shaped things with `env -u SHELLOPTS -u BASHOPTS`.
- Task boundary verification: `bun run verify-types && bun run lint:check && bun run lint:prose && bun run test`, plus `bunx turbo build` whenever `packages/` changed. No PR at any point (user tests first, on `feat/pane-preview`).

**Implementation decisions recorded against the spec (approve these as you review):**

1. Spec §12.4 / §7 said vendor noVNC's `core/` from git. It is published on npm as `@novnc/novnc` (v1.7.0, the official repo's own package: `type: module`, `exports: "./core/rfb.js"`, MPL-2.0 text ships inside, all internal imports relative). We install the pinned dependency instead of copying files: same ruling (pinned, MPL retained), fewer bytes and no drift.
2. Spec §6 describes `POST /preview/open` sending `preview_open` and awaiting the ack (kept as a reachability/gate probe: the ack lands before the node's dial of the target settles, so a refused port surfaces later as `target-gone`, never on the POST - Task 5). One TCP lane cannot carry a dev server's keep-alive HTTP and its permanent HMR WebSocket at once, so **browser connections beyond the probe each open their own node lane** (`preview_open` with a fresh 32-hex ref registered under the same session; the session secret authorizes many lanes; the probe lane closes as soon as it is acked). Spec quotas still count lanes; a burst beyond the cap queues up to 8 waiters instead of failing.
3. Two wire additions the spec text lacks: the node must tell the plane when a lane or bridge dies on its own (the ssh relay never needs this because its targets are agent-managed), so a node->plane event `preview_closed { ref, reason }` joins the grammar; and the close-reason set gains `target-gone` (the proxied service hung up while the pane lives). Both are spelled `snake_case` to match the NodeEvent convention on disk (`ssh_enabled`, `subshells_report`, `relay`), as is `preview_stream` itself. Spec §7's "polling-routes exclusion" names a mechanism that DOES exist (`REQUEST_LOG_IGNORE`, `apps/server/api/src/plugins/context.plugin.ts:32`, exported and pinned by `plugins/__tests__/request-log-ignore.test.ts`, whose comment's reason is exactly "POLLED by a page somebody leaves open"), and this feature joins it twice: the info poll for noise, and the `/pv` path for a credential reason - the session secret rides the URL, so a debug request line would log a live credential (an earlier revision of this plan claimed the mechanism was missing; that claim was wrong, verified against disk 2026-10-22). Visible throttling (one request per five seconds) is implemented too, as the same sentence asks.
4. Spec §12.4 asked for noVNC as a "lazy-loaded chunk". `.claude/rules/code-style.md` forbids dynamic import with one named exception and says a second exception is a design question, so RFB is a STATIC import. Bundle cost (~250 KB pre-gzip, one page's worth) is accepted; if a chunk boundary is wanted later it is a design question for the rules file, not this plan's call.
5. Spec §4's command bullet writes `set_preview_enabled { enabled }` while the same sentence says "the `set_ssh_enabled` shape exactly", and the disk shape is `{ on, changedAt }` (`node-frames.ts:1294` `NodeSshEnabledWire`). The plan follows the disk precedent; the `{ enabled }` shorthand is the outlier.
6. Spec §5 calls the `/pv/:session/` upgrade "the raw tunnel for everything websocket-shaped ... bytes pump both directions blind" - but one blind mode cannot serve both of its named consumers. A raw byte pump carries noVNC (x11vnc speaks raw RFB and would read the plane's WS handshake as a bogus version and hang up) but breaks Vite HMR and app sockets, whose targets are WS servers needing their own upgrade. So the browser's upgrade always terminates plane-side, and the TARGET leg branches by `PreviewSession.mode`: `raw` (blind byte pump, websockify semantics) when the session's port is the pane's registered screen `rfbPort`, `http` (a `ws` client redials `ws://127.0.0.1:<port>/<path>` over the lane) for everything else. The broker learns the screen port by consulting the pane's LIVE `getPorts` screen record first and falling back to the launch-time `onDisplayOpened` memory (Task 8), so no REST or protocol field is added and a PLANE RESTART cannot downgrade a live display to `http` (in-process memory is empty after a restart, but the node still reports the screen port; memory-only would re-handshake raw RFB); the spec's §6 body stays `{ port }`.

**Naming note.** The word "preview" already names the pane's screen-thumbnail cache on disk (`apps/server/api/src/services/nodes/preview-cache.ts`). The approved spec chose "preview" for this feature anyway; keep it (renaming now churns more than it saves), but say in the new code's JSDoc which preview it means, and keep the docs page titled "Pane preview" so a reader meets the distinction in prose before code.

---

## File Structure

**`packages/subshell-protocol/src/`**
- `node-frames.ts` (modify): version 23 + bump-history entry, four new commands into `NodeCommandBody` (:781), `PreviewDataFrame` + `parsePreviewFrame`, `NodeEvent` members `preview_data` / `preview_stream` / `preview_closed`, `launch` gains `screen`, `ready.previewEnabled`, `NodePreviewEnabledWire`.
- `node-results.ts` (modify): answer validators for the four new commands (file header rule: both sides validate `data`) and the `launch` result's optional `screen` echo.
- `live-frames.ts` (modify): server member `preview-stream`, client members `watch` / `unwatch`, parse arms.
- `ssh-limits.ts` (modify): `PREVIEW_*` constants (spec §4 makes this file the home of shared link-lane limits).
- `versions.ts` (modify): floor 2.4.0.
- `__tests__/node-frames.test.ts`, `__tests__/live-frames.test.ts` (modify): new hand-pinned census + boundary cases (the census tests in this file enumerate by hand and the count is the tripwire, `node-frames.test.ts:1105-1120`).

**`apps/node/agent/src/`**
- `preview/flags.ts`, `preview/ports.ts`, `preview/forward.ts`, `preview/cdp-bridge.ts`, `preview/display.ts` (new): the four mechanisms plus the mirror.
- `commands/set-preview-enabled-exec.ts`, `commands/preview-open-exec.ts` (one arm, both `kind` branches), `commands/preview-close-exec.ts`, `commands/preview-ports-exec.ts` (new arms); `commands/index.ts` (dispatch); `commands/context.ts` (registry handles, mirroring the relay pair `ssh-relay.ts` + `ssh-relay-exec.ts`).
- `commands/launch.ts` (modify): `screen` handling, switch gate, DISPLAY/XAUTHORITY env injection, result echo.
- `daemon.ts` (modify): `ready.previewEnabled`, inbound `preview_data` arm beside the relay intake, display orphan sweep timer.
- `__tests__/preview-*.test.ts` (new).

**`apps/server/api/src/`**
- `services/nodes/preview-enabled.ts` (new, clones `nodes/ssh-enabled.ts` shape incl. its storage) + route file beside the ssh-enabled route.
- `services/preview-broker.ts` + `services/__tests__/preview-broker.test.ts` (new).
- `services/nodes/preview-frames.ts` (new): the plane->node `preview_data` byte sender, a clone of `sendRelayFrameOverNodeSocket` - lane bytes ride link frames, never `sendCommand`.
- `api/subshells/preview-info.route.ts`, `preview-open.route.ts`, `preview-watch.route.ts` (POST + DELETE in one route module, or two files - follow the single-flat-route rule: it is one resource, the directory exists), `api/subshells/index.ts` (mount), `api/subshells/__tests__/preview-routes-auth.test.ts`.
- `api/subshells/create-subshell.route.ts` + `services/nodes/remote-launcher.ts` (modify): `screen` body field into the `launch` command, display audit on ack, refusal surfaced.
- `api/subshells/subshell-exit.route.ts` (modify): `broker.closeForPane(paneId, "pane-gone")` beside the death handling (it covers the display audit via `onDisplayClosed` and every lane/bridge of the pane).
- `preview/lane-duplex.ts`, `preview/pv-http.ts`, `preview/pv-ws.ts` + `preview/__tests__/` (new): the `/pv` proxy.
- `ws/live-ws.ts` (modify): `watch`/`unwatch` client frames; `ws/live-registry.ts` (modify): targeted send; `ws/__tests__/live-ws.test.ts`, `ws/__tests__/live-consistency.test.ts` (modify).
- `api/users/set-user-disabled.route.ts`, `set-user-role.route.ts` (modify): broker revoke cuts beside the existing `dropLiveSocketsFor` calls.
- `services/subshells.service.ts` (modify): the share-revocation cut goes INSIDE `setShares`, beside the `subshell.shares-changed` `publishLive` at :1245 - the shares route delegates to this service and touches no socket itself, and package doctrine puts the cut in the service that owns the act.
- `services/nodes/relay-frames.ts` (modify): the node-link intake that calls `getRelayBroker().routeRelayFrame(nodeId, frame)` grows a preview sibling routing `preview_data` / `preview_stream` / `preview_closed` to the preview broker.
- `services/nodes/node-ws-handler.ts` (modify): the event switch's `case "relay":` arm (:1196, delegating to `onRelayFrame` from relay-frames.ts) is where every node event is dispatched - the switch has NO default branch, so an event type with no arm here is silently dropped. The three preview event types need their own arms; without them the plane discards every preview frame while unit tests that call the intake function directly stay green.

**`apps/server/web/src/`**
- `hooks/use-subshell-preview.ts`, `lib/preview-bus.ts` (new); `components/preview/preview-section.tsx`, `port-list.tsx`, `open-panel.tsx`, `watch-viewer.tsx`, `screen-launch-hint.tsx`, `screen-viewer.tsx` (new; `screen-launch-hint.tsx` arrives with Task 12, `screen-viewer.tsx` with Task 13); `routes/subshells_.$id.tsx`, create/launch dialog, node settings page (modify); `hooks/use-live-subshells-feed.tsx` (modify: dispatch `preview-stream` frames to the bus; export its `send()` client-frame helper so `watch`/`unwatch` can actually be sent).

**Docs and release:** `apps/server/api/AGENTS.md` (audit inventory + preview-lane rules), `docs/security.md` (preview-lane paragraph), `apps/node/agent/AGENTS.md` (preview executors join the inventory; loopback invariant; xvfb/x11vnc/xauth optional runtime deps with named refusals), `apps/docs/content/docs/` (user page), `.changeset/` (one changeset: `@internal/server` minor + `@internal/node` minor).

---

### Task 1: Protocol contract (frames, commands, result validators, limits, version floor)

**Files:**
- Modify: `packages/subshell-protocol/src/node-frames.ts` (version at :187, bump history near :80, `NodeCommandBody` at :781 and `parseNodeCommandBody`, `NodeEvent` at :1540, `parseNodeEvent` at :2048, `RelayFrame` region :1446 as the shape to clone, ready member region beside `sshEnabled`, the `launch` command member at :784)
- Modify: `packages/subshell-protocol/src/node-results.ts` (validators; read its header first: `launch` sits on its DATALESS list today - success is just `{ ok: true }`, no validator - so the `screen` echo below is the first data field that command ever carried, and `parseNodeSshExecKick` models the hand-rolled validator style)
- Modify: `packages/subshell-protocol/src/ssh-limits.ts`
- Modify: `packages/subshell-protocol/src/versions.ts:123` (and its "Raised to..." comment)
- Modify: `apps/node/agent/package.json` (`"version": "2.3.0"` -> `"2.4.0"`)
- Test: `packages/subshell-protocol/src/__tests__/node-frames.test.ts`

**Interfaces:**
- Produces (Tasks 3-11 import these names): `NODE_PROTOCOL_VERSION = 23`; `NodePreviewEnabledWire { on: boolean; changedAt: string }`; commands `PreviewOpenCommand` (`kind: "forward" | "screencast"`, optional `fps`), `PreviewCloseCommand`, `PreviewPortsGetCommand`, `SetPreviewEnabledCommand` (`{ type, on, changedAt }`, decision 5), `PreviewCloseReason` (nine members, Global Constraints); `PreviewLaneKind`; `PREVIEW_CLOSE_REASONS` (runtime list beside the union); link frame `PreviewDataFrame { type: "preview_data"; ref; dir: "in" | "out"; blob }` (NO seq - lane order is the link's order, spec §4's shape) + `parsePreviewFrame(raw: string | object): PreviewDataFrame | null`; `NodeEvent` members `preview_data`, `preview_stream` (`{ ref, seq, w, h, ts, blob }`), `preview_closed` (`{ ref, reason }`); `launch` gains `screen?: { width: number; height: number }` (320..4096 both) and its result validator gains optional `screen?: { display: string; rfbPort: number }`; ready member `previewEnabled?: NodePreviewEnabledWire`; constants `PREVIEW_FRAME_MAX_BYTES`, `PREVIEW_LANE_BUFFER_MAX_BYTES`, `PREVIEW_WATCH_FPS_MIN`, `PREVIEW_WATCH_FPS_DEFAULT`, `PREVIEW_WATCH_FPS_MAX`, `PREVIEW_FPS_GRAMMAR_MAX`, `PREVIEW_WATCH_JPEG_QUALITY`, `PREVIEW_WATCH_FRAMES_BUFFERED`, `PREVIEW_FORWARD_SESSIONS_PER_PANE`, `PREVIEW_SESSIONS_PER_NODE`, `PREVIEW_WATCH_SUBSCRIBERS_MAX`, `PREVIEW_IDLE_MS`, `PREVIEW_LIFETIME_MIN_MS`, `PREVIEW_LIFETIME_MAX_MS`, `PREVIEW_LANE_QUEUE_MAX`, `PREVIEW_STREAM_DEBT_MAX` (per-viewer-socket queued-bytes ceiling on the live feed - 4 MiB: ~10 s of q60 screencast at the 5 fps cap, generous against Bun's own WS backpressure), `PREVIEW_REF_RE`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing grammar tests.** Append to `node-frames.test.ts`, cloning the file's own style (the `relay` tests for frames, the hand-pinned `SSH_COMMAND_TYPES` census at :1105 for the census - write a `PREVIEW_COMMAND_TYPES` list with the four types and `expect(...).toHaveLength(4)` so the count is a tripwire, not a claim; follow the disk pattern exactly on LOCATION: `SSH_COMMAND_TYPES` is exported from `node-frames.ts` and re-exported through the `src/index.ts` barrel (`:292`), imported by the test at :32, so do the same - package-exported, test-imported, not a test-local constant). Add `parsePreviewFrame`, `PREVIEW_CLOSE_REASONS`, and every `PREVIEW_*` constant you reference to the file's existing named-import block:

```ts
describe("preview commands", () => {
  test("preview_open round trips, both kinds", () => {
    const fwd = { type: "preview_open", ref: "a".repeat(32), kind: "forward", paneId: "p1", port: 5173, lifetimeMs: 3_600_000 };
    expect(parseNodeCommandBody(JSON.stringify(fwd))).toEqual(fwd);
    const sc = { type: "preview_open", ref: "a".repeat(32), kind: "screencast", paneId: "p1", port: 9222, fps: 5, lifetimeMs: 3_600_000 };
    expect(parseNodeCommandBody(JSON.stringify(sc))).toEqual(sc);
  });
  test("the kind decides whether fps may appear", () => {
    const noFpsScreencast = { type: "preview_open", ref: "a".repeat(32), kind: "screencast", paneId: "p", port: 9222, lifetimeMs: 60_000 };
    expect(parseNodeCommandBody(JSON.stringify(noFpsScreencast))).toEqual(noFpsScreencast); // fps optional, spec §4; the arm defaults it
    const fpsOnForward = { type: "preview_open", ref: "a".repeat(32), kind: "forward", paneId: "p", port: 8080, fps: 5, lifetimeMs: 60_000 };
    expect(parseNodeCommandBody(JSON.stringify(fpsOnForward))).toBeNull();
  });
  test("refuses out-of-range numbers", () => {
    const base = { type: "preview_open", ref: "a".repeat(32), kind: "forward", paneId: "p", lifetimeMs: 60_000 };
    expect(parseNodeCommandBody(JSON.stringify({ ...base, port: 70_000 }))).toBeNull();
    expect(parseNodeCommandBody(JSON.stringify({ ...base, port: 1.5 }))).toBeNull();
    expect(parseNodeCommandBody(JSON.stringify({ type: "preview_open", ref: "a".repeat(32), kind: "screencast", paneId: "p", port: 9222, fps: PREVIEW_FPS_GRAMMAR_MAX + 1, lifetimeMs: 60_000 }))).toBeNull();
    expect(parseNodeCommandBody(JSON.stringify({ ...base, lifetimeMs: PREVIEW_LIFETIME_MIN_MS - 1 }))).toBeNull();
    expect(parseNodeCommandBody(JSON.stringify({ ...base, lifetimeMs: PREVIEW_LIFETIME_MAX_MS + 1 }))).toBeNull();
  });
  test("refuses a short or malformed ref", () => {
    expect(parseNodeCommandBody(JSON.stringify({ type: "preview_close", ref: "x", reason: "viewer-left" }))).toBeNull();
  });
  test("launch accepts a screen size and bounds it", () => {
    // base mirrors the file's own launch fixture (:47-54) - copy its remaining fields if the parser demands them
    const base = { type: "launch", subshellId: "s1", socket: "subshell-abc", cwd: "/home/u/repo", harnessId: "claude-code", preset: { name: "P", env: {}, flags: [], settings: null, configIsolation: false }, subshellEnv: { SUBSHELL_API_KEY: "subshell_x" } };
    expect(parseNodeCommandBody(JSON.stringify({ ...base, screen: { width: 1280, height: 720 } }))).toMatchObject({ screen: { width: 1280, height: 720 } });
    expect(parseNodeCommandBody(JSON.stringify({ ...base, screen: { width: 100, height: 720 } }))).toBeNull();
    expect(parseNodeCommandBody(JSON.stringify({ ...base, screen: { width: 1280, height: 5000 } }))).toBeNull();
    expect(parseNodeCommandBody(JSON.stringify(base))).toMatchObject({ type: "launch" });
  });
  test("the close-reason census is pinned", () => {
    // the SSH_RELAY_CLOSE_REASONS loop at :1412 is the pattern: every member round trips, one bogus reason is refused
    for (const reason of PREVIEW_CLOSE_REASONS) {
      expect(parseNodeCommandBody(JSON.stringify({ type: "preview_close", ref: "a".repeat(32), reason }))).toEqual({ type: "preview_close", ref: "a".repeat(32), reason });
    }
    expect(parseNodeCommandBody(JSON.stringify({ type: "preview_close", ref: "a".repeat(32), reason: "because" }))).toBeNull();
  });
});
describe("preview link frames and events", () => {
  const frame = { type: "preview_data", ref: "a".repeat(32), dir: "in", blob: Buffer.alloc(10).toString("base64") };
  test("round trips and enforces the raw blob cap", () => {
    expect(parsePreviewFrame(frame)).toEqual(frame);
    expect(parsePreviewFrame({ ...frame, blob: Buffer.alloc(PREVIEW_FRAME_MAX_BYTES + 1).toString("base64") })).toBeNull();
    expect(parsePreviewFrame({ ...frame, blob: Buffer.alloc(PREVIEW_FRAME_MAX_BYTES).toString("base64") })).not.toBeNull(); // cap on RAW bytes, like RelayFrame's base64RawLength
  });
  test("the three node events parse", () => {
    expect(parseNodeEvent({ ...frame })).toEqual(frame);
    expect(parseNodeEvent({ type: "preview_stream", ref: "a".repeat(32), seq: 1, w: 800, h: 600, ts: 123, blob: "AAA=" })).toEqual({ type: "preview_stream", ref: "a".repeat(32), seq: 1, w: 800, h: 600, ts: 123, blob: "AAA=" });
    expect(parseNodeEvent({ type: "preview_closed", ref: "a".repeat(32), reason: "target-gone" })).toEqual({ type: "preview_closed", ref: "a".repeat(32), reason: "target-gone" });
  });
});
```

- [ ] **Step 2: Run to verify it fails:** `env -u SHELLOPTS -u BASHOPTS bun test packages/subshell-protocol/src/__tests__/node-frames.test.ts`.
- [ ] **Step 3: Add constants** to `ssh-limits.ts`:

```ts
/** Byte cap on a preview lane frame's RAW payload, base64 aside (spec §4). Shared by both ends. */
export const PREVIEW_FRAME_MAX_BYTES = 262_144;
/** Bytes the link will not take before a lane calls it slow-link (spec §5: 1 MiB, both sides). */
export const PREVIEW_LANE_BUFFER_MAX_BYTES = 1_048_576;
/** Screencast rates. The bridge CLAMPS the wire fps into [MIN, MAX]; the grammar is looser. */
export const PREVIEW_WATCH_FPS_MIN = 1;
export const PREVIEW_WATCH_FPS_DEFAULT = 5;
export const PREVIEW_WATCH_FPS_MAX = 5;
export const PREVIEW_FPS_GRAMMAR_MAX = 60;
export const PREVIEW_WATCH_JPEG_QUALITY = 60;
/** Frames the bridge may have in flight toward the plane before it starts dropping. */
export const PREVIEW_WATCH_FRAMES_BUFFERED = 5;
/** Lane quotas: per pane, per node, and per watch bridge. */
export const PREVIEW_FORWARD_SESSIONS_PER_PANE = 4;
export const PREVIEW_SESSIONS_PER_NODE = 16;
export const PREVIEW_WATCH_SUBSCRIBERS_MAX = 8;
/** Lane waiters queued beyond the pane cap before a refusal (decision 2's burst posture). */
export const PREVIEW_LANE_QUEUE_MAX = 8;
/** A forward lane with no bytes either way for this long self-closes (spec §6: 15 min). */
export const PREVIEW_IDLE_MS = 900_000;
/** Lanes ride a lifetime inside this window; the command refuses outside it. */
export const PREVIEW_LIFETIME_MIN_MS = 60_000;
export const PREVIEW_LIFETIME_MAX_MS = 4 * 3_600_000;
/** Lane refs double as proxy path secrets: 128 bits of lowercase hex. */
export const PREVIEW_REF_RE = /^[0-9a-f]{32}$/;
```

- [ ] **Step 4: Add the command and frame grammar** to `node-frames.ts`, cloning the `RelayFrame` validation style exactly (strict base64 via `base64RawLength`, ref via `PREVIEW_REF_RE`):

```ts
/** What a preview_open asks for: the raw loopback lane, or the read-only CDP screencast (spec §4). */
export type PreviewLaneKind = "forward" | "screencast";

/** Opens one preview lane inside the pane's node. */
export interface PreviewOpenCommand {
  type: "preview_open";
  /** Opaque lane ref: 32 lowercase hex, also the proxy path secret family. */
  ref: string;
  kind: PreviewLaneKind;
  /** Attribution + liveness check on the node, never a routing target. */
  paneId: string;
  /** Dial target (forward) or devtools port (screencast). The node dials loopback only. */
  port: number;
  /** Screencast only; the bridge clamps it to [1, 5] and defaults it. Forward forbids it. */
  fps?: number;
  /** Self-expiry: the node closes the lane by this deadline whatever the plane does. */
  lifetimeMs: number;
}

/** Why a lane or bridge ended. Closed set; the UI maps them (spec §6/§9). */
export type PreviewCloseReason =
  | "viewer-left" | "pane-gone" | "node-dropped" | "slow-link" | "over-cap" | "idle" | "revoked"
  | "not-cdp" | "target-gone";

/** The runtime list beside the union, per the enums rule: one edit site, and the tests' census iterates it. */
export const PREVIEW_CLOSE_REASONS: readonly PreviewCloseReason[] = ["viewer-left", "pane-gone", "node-dropped", "slow-link", "over-cap", "idle", "revoked", "not-cdp", "target-gone"];

/** Lane teardown. Never access-gated (the set_ssh_enabled doctrine); an unknown ref answers closed:false. */
export interface PreviewCloseCommand { type: "preview_close"; ref: string; reason: PreviewCloseReason }

/** One pass: what the pane's process tree is listening on, plus the CDP and display hints (spec §4). */
export interface PreviewPortsGetCommand { type: "preview_ports_get"; paneId: string }

/** The per-machine owner switch, plane sole author. Mirrors set_ssh_enabled's shape (decision 5). */
export interface SetPreviewEnabledCommand { type: "set_preview_enabled"; on: boolean; changedAt: string }

/** The preview lane frame: one capped base64 blob, both legs, parsed like RelayFrame (no seq; order is the link's). */
export interface PreviewDataFrame {
  type: "preview_data";
  ref: string;
  /** in = toward the node's dialled socket, out = back toward the plane. */
  dir: "in" | "out";
  blob: string;
}
```

Into `NodeCommandBody` (:781) add all four; add `screen?: { width: number; height: number }` to the `launch` member with JSDoc "Allocates a virtual display and starts the pane on it. Linux only; a machine with the switch off refuses before spawning (spec §4)." Into `NodeEvent` (:1540) add `PreviewDataFrame` (the `preview_data` member, exactly as `relay` joins it) plus

```ts
| { type: "preview_stream"; ref: string; seq: number; w: number; h: number; ts: number; blob: string }
| { type: "preview_closed"; ref: string; reason: PreviewCloseReason }
```

and in the `ready` member block `previewEnabled?: NodePreviewEnabledWire` beside `sshEnabled` (`daemon.ts:416` sends the latter). `export interface NodePreviewEnabledWire { on: boolean; changedAt: string }` beside `NodeSshEnabledWire` (:1294). Export the new symbols from `src/index.ts`; touch nothing that pulls a `node:*` builtin into the barrel (the mobile Metro rule in `.claude/rules/verification.md`).

- [ ] **Step 5: Wire parses, bump, results.** Add the four arms to `parseNodeCommandBody` (the `preview_open` arm enforces the kind-shape rule its test pins: `fps` iff `kind === "screencast"`, integer 1..`PREVIEW_FPS_GRAMMAR_MAX`), the three arms to `parseNodeEvent` (clone the `relay` arm at :2163), export `parsePreviewFrame` cloning `parseRelayFrame` with `PREVIEW_FRAME_MAX_BYTES`. Then `NODE_PROTOCOL_VERSION = 23` with the spec §4 bump entry VERBATIM:

> **22 -> 23:** the preview surface. `preview_open` / `preview_close` signed commands and the `preview_data` link frame carry a gated byte lane between a dashboard viewer and a pane's loopback port (forward and CDP bridge kinds); the `preview_stream` event carries read-only screencast frames; `preview_ports_get` reports a pane's listening ports and CDP/screen hints; `set_preview_enabled` mirrors a per-machine owner switch; a launch may carry a `screen` request. An agent below 23 understands none of it, and the exact-match gate is what refuses pairing before any of it is sent.

(Plus one sentence appended for decision 3's `preview_closed`.) Then `MIN_NODE_VERSION = "2.4.0"` with its comment updated ("raised with protocol 23; the floor equals the shipping agent") and `apps/node/agent/package.json` to `"2.4.0"`. In `node-results.ts`: validators for `preview_open` (forward: `{ ref, pending: true }`; screencast: `{ ref, subscribers: number }`), `preview_close` (`{ ref, closed: boolean }`), `preview_ports_get` (`{ ports, cdpPort, screen }` exactly as spec §4's answer), `set_preview_enabled` gets NO validator and its ack is never read: the ssh precedent fires its command best-effort and discards the result (`ssh-enabled.ts:48` + `:138`), the plane's truth is its own DB row, and a dataless command has no entry here by the file's own header rule. `launch`'s data gains `screen?: { display: string; rfbPort: number }` (the display the node allocated, so the plane can audit it on ack - a post-ack `getPorts` would race the 5 s cache on a pane that just started), which makes `launch` the first data-carrying command on the header's dataless list: write `parseNodeLaunchResult` in the file's hand-rolled style, validate on BOTH ends per the header contract, and update the header's dataless sentence to drop `launch` from it.

- [ ] **Step 6: Run the whole protocol package, then the suites that pin the version:** `env -u SHELLOPTS -u BASHOPTS bun run test --filter=@internal/subshell-protocol`; then `bun run test` for `@internal/server` and `@internal/node` and fix every fixture that pins protocol 22 or the old floor, IN THIS COMMIT (bump doctrine).
- [ ] **Step 7: Build + commit:**

```bash
bunx turbo build --filter=@internal/subshell-protocol
git add -A packages/subshell-protocol apps/node/agent/package.json
# plus EVERY apps/ fixture step 6 actually fixed, by PATH (run
# `git status --short apps/` and add exactly the files you edited - typically
# the node-gates/version fixtures under apps/server/api/src/services/nodes/
# __tests__ and apps/node/agent/__tests__). Whole directories must NEVER be
# staged: this tree is shared with concurrent workstreams and uncommitted WIP
# sits under apps/server/api (auth-guard.ts, ws.plugin.ts, ssh-relay.service.ts
# as of 2026-10-22). Before committing, `git status --short` must show no
# staged file you did not touch.
git commit -m "feat(protocol): preview lanes, screencast events, and the owner switch (protocol 23, floor 2.4.0)"
```

(Step 6's version-pin fixture fixes in `apps/` ship IN this commit - the bump doctrine means HEAD is only green when the floor, the version, and every fixture that pins them land together.)

---

### Task 2: Live feed grammar (watch subscribe frames + stream frame)

**Files:**
- Modify: `packages/subshell-protocol/src/live-frames.ts` (server union beside `subshell-recheck` (:63) and `preview` (:69); client union; `parseLiveClientFrame`)
- Test: `packages/subshell-protocol/src/__tests__/live-frames.test.ts`

**Interfaces:**
- Produces: `LiveServerFrame` member `{ type: "preview-stream"; id: string; seq: number; w: number; h: number; blob: string }` (`id` is the subshell id; per spec §6 the live frame carries NO ref - subscribers address panes, refs stay plane-side); `LiveClientFrame` members `{ type: "watch"; id: string }`, `{ type: "unwatch"; id: string }`; `parseLiveClientFrame` arms.
- Consumes: nothing (the blob is a string).

- [ ] **Step 1: Failing tests** in `live-frames.test.ts`: `parseLiveClientFrame` accepts `{"type":"watch","id":"s1"}` and `{"type":"unwatch","id":"s1"}`; rejects a missing or non-string `id`; rejects unknown client types exactly as its current cases do (read the file's existing style first and clone it).
- [ ] **Step 2: Run, watch them fail** (`env -u SHELLOPTS -u BASHOPTS bun test packages/subshell-protocol/src/__tests__/live-frames.test.ts`).
- [ ] **Step 3: Implement** the union members and parse arms. JSDoc: the stream frame is published only to sockets the broker has verified hold `view` on the row; it carries no `ref` on purpose.
- [ ] **Step 4: Package tests, turbo build, commit** `feat(protocol): live watch subscriptions and preview-stream frames`.

---

### Task 3: The per-node preview switch, end to end

**Files (read the clone source first, mirror it exactly including its storage):**
- Read: `apps/server/api/src/services/nodes/ssh-enabled.ts`, its route and test (`grep -rln "set_ssh_enabled" apps/server/api/src/api apps/server/api/src/services`), node half: `grep -rn "sshEnabled" apps/node/agent/src`, the `set_ssh_enabled` executor in `apps/node/agent/src/commands/`.
- Create: `apps/node/agent/src/preview/flags.ts`, `apps/node/agent/src/commands/set-preview-enabled-exec.ts`, `apps/server/api/src/services/nodes/preview-enabled.ts`, the route file beside the ssh one, `apps/server/api/src/db/migrations/0062-node-preview-enabled.ts` (+ its migration test, cloning `migrations/__tests__/0047-node-ssh-enabled.test.ts`).
- Modify: `apps/node/agent/src/commands/index.ts`, `apps/node/agent/src/daemon.ts` (ready field, mirror the `sshEnabled` wiring at :362/:416), the route mount, `apps/server/api/src/db/migrate.ts` (register `0062-node-preview-enabled` in the provider map - name and key must match), `apps/server/api/src/db/types/` node row type + `apps/server/api/src/db/repositories/nodes.repository.ts` (`setPreviewEnabled` beside `setSshEnabled` at :279, same `{on, changedAt}` contract whose comment explains the caller-supplied stamp).
- Test: plane route test + `apps/node/agent/src/__tests__/preview-flags.test.ts`.

**Interfaces:**
- Consumes: `SetPreviewEnabledCommand`, `NodePreviewEnabledWire` (Task 1).
- Produces: node `preview/flags.ts`: `getPreviewEnabled(): NodePreviewEnabledWire | undefined`, `setPreviewEnabled(state: NodePreviewEnabledWire): void` (mirrors `preview_closed`-free naming: this is just the mirror); plane `preview-enabled.ts`: `getPreviewEnabled(nodeId): Promise<boolean>` (row absent = OFF, fail-closed), `setPreviewEnabled(nodeId, actorUserId, on): Promise<void>`.

- [ ] **Step 1: Read the clone source** both halves and both tests; note how it persists plane-side state, sends the command (`sendCommand` from `@/services/nodes/node-rpc.js`), audits `node.ssh_enabled.update`, and survives mirror drift.
- [ ] **Step 2: Failing tests, BOTH halves.** Plane: clone the ssh route test - cookie actor flips -> 200 + audit `node.preview_enabled.update` + `sendCommand` called with `{type:"set_preview_enabled", on, changedAt}`; system key 403; default read `{on:false}` with no row. Node: a verified `set_preview_enabled` flips the mirror (0600); `getPreviewEnabled` ALLOWS ONLY a parsed `{on:true}` mirror - absent, unreadable, and malformed all read as OFF, the same assertions `apps/node/agent/src/__tests__/ssh-enabled.test.ts:178` makes for its twin (no gated preview command exists yet - command gates arrive with Tasks 4/5/7, each tested there); an external edit to the mirror file between commands is re-read and re-reported (copy the ssh mirror test).
- [ ] **Step 3: Implement the plane half.** "Clone the storage mechanism" concretely means: the `sshEnabled`/`sshEnabledAt` column PAIR on `nodes` cloned as `previewEnabled`/`previewEnabledAt` (integer 0/1 + ISO stamp, 0047's shape) via the new 0062 migration registered in `migrate.ts`, the repository member, then the service. If any curated-`:memory:` suite comes to read or write the new columns, add 0062's `.up()` to that file's hand-curated list (the 0039 precedent in `.claude/rules/testing.md`). Plane tests green.
- [ ] **Step 4: Run the node tests to see them fail, then implement the node half:** executor gate-first + mirror file with mode 0600 exactly where the ssh mirror lives; `daemon.ts` ready gains `...(previewFlags() ? { previewEnabled: previewFlags() } : {})`.
- [ ] **Step 5: Focused green, commit** `feat: per-node preview switch mirroring the ssh enable posture`.

---

### Task 4: Port discovery (node)

**Files:**
- Create: `apps/node/agent/src/preview/ports.ts`, `apps/node/agent/src/commands/preview-ports-exec.ts`
- Modify: `apps/node/agent/src/commands/index.ts`, `commands/context.ts` (pane registry handle - read how `commands/launch.ts` reaches the tmux runner; `TmuxRunner.panePid(socket, subshellName)` is at `packages/pane-runtime/src/tmux-runner.ts:447`)
- Test: `apps/node/agent/src/__tests__/preview-ports.test.ts`

**Interfaces:**
- Produces: `scanPanePorts(opts: { procRoot?: string; panePid: number; probe?: (port: number) => Promise<boolean>; screen?: { display: string; rfbPort: number } | null }): Promise<{ ports: { proto: "tcp" | "tcp6"; port: number; pid: number }[]; cdpPort: number | null; screen: { display: string; rfbPort: number } | null }>`; refuses on non-Linux with `preview-ports-unsupported`; command result validated by Task 1's `node-results` entry. The CDP probe default is a loopback `GET /json/version` with a 400 ms budget (spec §4); `probe` exists so tests fake it.
- Consumes: pane pid (above), display registry (Task 7; before it exists, `screen` is null).

- [ ] **Step 1: Failing unit tests** over a fixture `/proc` in a temp dir (write `root/<pid>/stat` with the ppid field, `root/<pid>/cmdline`, `root/<pid>/fd/N` symlinks whose target is the string `socket:[INODE]`, and `root/net/tcp` + `net/tcp6` LISTEN rows with the inode column):

```ts
test("attributes a listening socket to the deepest descendant that owns it", async () => {
  const r = await scanPanePorts({ procRoot, panePid: 100, probe: async () => false });
  expect(r.ports).toEqual([{ proto: "tcp", port: 3000, pid: 102 }]);
});
test("cdpPort is the LISTEN port whose /json/version probe answers", async () => {
  const r = await scanPanePorts({ procRoot, panePid: 100, probe: async (p) => p === 9222 });
  expect(r.cdpPort).toBe(9222);
});
test("a socket owned by an outsider never appears", async () => {
  const r = await scanPanePorts({ procRoot, panePid: 100, probe: async () => false });
  expect(r.ports.some((p) => p.port === 8080)).toBe(false);
});
test("no listeners answers with empty arrays, not an error", async () => {
  const r = await scanPanePorts({ procRoot: emptyProcRoot, panePid: 100, probe: async () => false });
  expect(r.ports).toEqual([]); expect(r.cdpPort).toBeNull(); expect(r.screen).toBeNull();
});
test("an IPv6 loopback listener parses", async () => {
  const r = await scanPanePorts({ procRoot, panePid: 100, probe: async () => false });
  expect(r.ports).toContainEqual({ proto: "tcp6", port: 4321, pid: 102 });
});
```

Executor level too (fake context, the `commands-ssh-relay.test.ts` habit): switch OFF refuses naming the remedy; a dead pane refuses `preview-ports-pane-gone`; a successful answer passes Task 1's `node-results` validator (the shape is contract, not vibes).

- [ ] **Step 2: Fail.**
- [ ] **Step 3: Implement `ports.ts`:** one pass (spec §5: stateless), parse `net/tcp`/`net/tcp6` state `0A`, hex `local_address:port`, collect inodes; ppid map from `<pid>/stat`; BFS descendants of `panePid` (cap: 512 pids, refusal `preview-ports-overcap`); readlink `fd/*`, intersect, deepest descendant per inode; CDP probe each listed port with the injected default `GET http://127.0.0.1:<port>/json/version` (400 ms, `AbortSignal.timeout`, accept when the JSON has a `Browser` field); non-Linux refuses BEFORE touching fs. `procRoot` and `probe` exist only for tests.
- [ ] **Step 4: Executor arm:** gate-first (switch OFF refuses naming the remedy "turn on Preview for this node"; dead pane refuses `preview-ports-pane-gone`); result = scan output with the display registry's `screen` for that pane.
- [ ] **Step 5: Green + commit** `feat(node): attribute pane subtrees' listening sockets, probing CDP per spec`.

---

### Task 5: Forward lanes (node executor)

**Files:**
- Read first: `apps/node/agent/src/commands/ssh-relay-exec.ts` (the A-branch: gate-first, `pending: true`, off-chain connect, close-not-gated, tombstone) and `apps/node/agent/src/relay-send.ts` (the deliver-or-throw pump).
- Create: `apps/node/agent/src/preview/forward.ts`, `apps/node/agent/src/commands/preview-open-exec.ts` (this task lands the `forward` branch; Task 6 adds `screencast`), `apps/node/agent/src/commands/preview-close-exec.ts`
- Modify: `commands/index.ts`, `commands/context.ts` (a `previewForward` registry), `daemon.ts` (inbound `preview_data` arm beside the relay intake; emissions use the same sender as relay events)
- Test: `apps/node/agent/src/__tests__/preview-forward.test.ts` (the `__tests__/commands-ssh-relay.test.ts` precedent)

**Interfaces:**
- Consumes: `PreviewOpenCommand` (`kind: "forward"`), `PreviewCloseCommand`, `PreviewDataFrame` + `preview_data` NodeEvent, `preview_closed` NodeEvent, limits.
- Produces: `forward.ts`: `openLane({ ref, port, paneId, lifetimeMs, hooks, deps }): void` (registers SYNCHRONOUSLY then dials off-chain; the hooks carry the ack result), `closeLane(ref, reason): { closed: boolean }`, `ingestInboundFrame(frame): void`, `laneCount(paneId?): number`, `closeAll(reason): void`; refusals `preview-node-off`, `preview-lane-over-node-cap`, `preview-lane-over-pane-cap`, `preview-pane-gone` (there is no host-refusal: the wire carries a port, never a host, and the grammar bounds it, so a non-loopback dial is unrepresentable). The `deps` seam (`{ connect?, now?, timer? }`, same style as Task 7's) is how the tests hold a connect open, fake the clock, and shrink the idle/lifetime/slow-link budgets - module-level `export const` limits are not overridable from a test.

- [ ] **Step 1: Failing tests** (real in-test echo server on an ephemeral loopback port; fake context capturing emitted events; tiny injected idle/lifetime budgets for the timer cases):
  - (a) ack is `{ ok: true, data: { ref, pending: true } }` and returns BEFORE the dial settles: assert the dispatch of `preview_open` against an address that never answers (a non-routable loopback port with a held connect via injected `connect`) does not block a following command on the fake chain, and the eventual connect failure emits `preview_closed` `target-gone` - the A-branch contract tested the way `commands-ssh-relay.test.ts` tests it.
  - (b) connected lane echoes: inbound `preview_data` dir "in" reaches the socket, socket bytes leave as `preview_data` dir "out" events.
  - (c) `preview_close` is NOT access-gated (assert no switch check on the close path) and an unknown ref answers `{ closed: false }` (tombstone).
  - (d) quotas: the 17th concurrent lane refuses `preview-lane-over-node-cap`, per-pane the 5th `preview-lane-over-pane-cap`.
  - (e) idle: injected small idle budget self-closes with `preview_closed` reason `idle`; target socket end emits `preview_closed` `target-gone` exactly once per lane; a `preview_close` that lands first suppresses the later EOF event (assert one emission total).
  - (f) slow-link: with `PREVIEW_LANE_BUFFER_MAX_BYTES` overridden small, an overflowing outbound pump closes with `slow-link`.
- [ ] **Step 2: Fail.**
- [ ] **Step 3: Implement `forward.ts`:** map ref->lane. Register + ack first (A-branch), then dial `net.connect({ host: "127.0.0.1", port })`, retry once on `::1`, both failures = `target-gone` (loopback literals only - the wire carries a port, never a host). Socket data -> base64 -> `preview_data` out event via the relay pump (deliver-or-throw); unaccepted bytes accumulate and past `PREVIEW_LANE_BUFFER_MAX_BYTES` close `slow-link` (spec §5's number). `ingestInboundFrame` (dir "in") writes the socket; both directions count as idle-timer activity. Every death path deregisters, then emits exactly one `preview_closed`. Lifetime timer; `closeAll` on daemon link-drop. Result-before-teardown and the seam-cast posture copied from `ssh-relay-exec.ts` verbatim.
- [ ] **Step 4: Wire intake:** in `daemon.ts` beside the `parseRelayFrame` call site, add `parsePreviewFrame` -> `ctx.previewForward.ingestInboundFrame`; `preview_close` arm calls `closeLane` unconditionally.
- [ ] **Step 5: Green + commit** `feat(node): pending-ack forward lanes with off-chain dial and 1 MiB slow-link pump`.

---

### Task 6: CDP watch bridge (node side)

**Files:**
- Create: `apps/node/agent/src/preview/cdp-bridge.ts`
- Modify: `apps/node/agent/src/commands/preview-open-exec.ts` (the `screencast` branch), `apps/node/agent/src/commands/preview-close-exec.ts` (after the forward lane reports `closed: false`, consult the bridge registry: `stopBridge(ref, reason)` answers `closed: true`; unknown in both registries keeps the tombstone contract), `daemon.ts` (emit `preview_stream`/`preview_closed` via the same sender; the link-drop hook that Task 5 wires `closeAll` into must ALSO call `bridgeCloseAll(reason)` - without this a continuous-repaint page screencasts forever after the plane closes the watch)
- Test: `apps/node/agent/src/__tests__/preview-cdp-bridge.test.ts`

**Interfaces:**
- Consumes: `PreviewOpenCommand` (`kind: "screencast"`), `preview_stream` + `preview_closed` NodeEvents, `PREVIEW_WATCH_*`.
- Produces: `startBridge({ ref, cdpPort, fps, lifetimeMs, emitStream, emitClosed, deps }): Promise<{ subscribers: number }>` (`deps` carries `{ fetch?, WebSocketImpl?, now?, timer? }` so the handshake, the 60 s idle, and the fps throttle are all testable without a real browser or clock); `stopBridge(ref, reason): boolean` (false when the ref is not a bridge, so the close executor can fall through); `bridgeCloseAll(reason)`; `bridgeCount()`; `clampFps(fps: number): number` (pure, exported for its test). Handshake budget 3 s; a port that fails `GET /json/list` or the budget closes with `not-cdp`. Emission contract (Task 11 leans on it): one `preview_stream` per emitted frame, `seq` monotonic per ref, `w/h` from frame metadata, `ts = Date.now()`, `blob` the base64 JPEG.

- [ ] **Step 1: Failing tests.** Fake CDP in-proc: `Bun.serve` answering `/json/list` with `[{ type: "page", webSocketDebuggerUrl }]` and a websocket handler that records messages and pushes three `Page.screencastFrame` notifications. Assert: start sends `Page.startScreencast { format: "jpeg", quality: PREVIEW_WATCH_JPEG_QUALITY, everyNthFrame: 1 }` (after `Page.enable`); every frame is acked with `Page.screencastFrameAck` (`sessionId` echoed) EVEN when the fps throttle drops its emission (fps clamp 5, three frames in one tick -> at most one stream emission, three acks); `webSocketDebuggerUrl` pointing at a non-loopback host is refused `not-cdp` (the port came from /proc; the URL is answered by a socket - distrust it); CDP socket close mid-stream emits `preview_closed target-gone` once; a target whose `/json/list` 404s closes `not-cdp`; `clampFps(0) === 1`, `clampFps(15) === 5`, absent fps defaults to 5; `preview_close` on a BRIDGE ref stops it exactly once (forward miss -> bridge hit -> `{ closed: true }`) while an unknown-in-both ref keeps `{ closed: false }`; `bridgeCloseAll("node-dropped")` stops every bridge with one emission each; lifetime expiry (fake clock) emits `preview_closed` with `idle`; a bridge whose target sends NO frames stays alive past the old 60 s traffic window (the anti-test for traffic-idle: zero frames, zero closes).
- [ ] **Step 2: Fail.**
- [ ] **Step 3: Implement** with global `fetch` + global `WebSocket` (bun provides both; no new dependency). Sequence per spec §5: `GET http://127.0.0.1:<port>/json/list` -> newest `type === "page"` target (else first) -> validate the ws URL host is `127.0.0.1`/`localhost` -> `Page.enable` -> `Page.startScreencast { format: "jpeg", quality: PREVIEW_WATCH_JPEG_QUALITY, everyNthFrame: 1 }`. On frame notifications: ack immediately, always; throttle emissions to `clampFps(fps)` (`Math.ceil(1000 / fps)` interval, extras dropped); no more than `PREVIEW_WATCH_FRAMES_BUFFERED` un-acked-by-link frames in flight (drop, never backpressure the browser - spec §5). NO traffic-based self-close: a static page repaints nothing and must keep its watch, and the spec's 60 s idle (spec §5) is ZERO-SUBSCRIBER idle, which is plane-side refcount state the node cannot see - the plane already closes the bridge on last-unsubscribe. Self-close only on lifetime expiry (emit `preview_closed` with `idle`) and target death (`target-gone`).
- [ ] **Step 4: Branch wiring:** `preview-open-exec.ts` screencast branch: gate-first, pane-pid check, counts toward `PREVIEW_SESSIONS_PER_NODE`, result `{ ref, subscribers: 1 }` per Task 1's validator.
- [ ] **Step 5: Green + commit** `feat(node): CDP screencast bridge, always-ack with dropping backpressure`.

---

### Task 7: Virtual displays (node) and the gated `launch.screen`

**Files:**
- Create: `apps/node/agent/src/preview/display.ts`
- Modify: `apps/node/agent/src/commands/launch.ts` (the `screen` path + the `extraEnv` pass-in at :209/:224), `packages/pane-runtime/src/launch.ts` (optional `extraEnv` layer on `paneEnvFor` and `assembleHarnessCommand`, appended last in the spread chain so a display value never loses to a preset), `daemon.ts` (hourly orphan sweep), the pane-death path `launch.ts`/reportDeath already used for plane death hooks (read how pane death is reported; spec §5 names `reportDeath`)
- Test: `apps/node/agent/src/__tests__/preview-display.test.ts`, `packages/pane-runtime/src/__tests__/launch.test.ts` (the extraEnv layer: pane sees DISPLAY/XAUTHORITY, the exit-hook env from :224 agrees, and with no display the chain is byte-identical to today)

**Interfaces:**
- Consumes: `launch.screen`, `launch` result `screen` echo (Task 1), `dataDir` (grep how `<dataDir>/ssh/<paneId>/` derives it and reuse the helper), `preview/flags.ts`.
- Produces: `display.openFor(paneId, { width, height }, deps?): Promise<{ display: string; rfbPort: number }>` (`deps` injects `{ spawn, spawnSync, which, sleep, now }` for fakes - `which(name)` is the ONE binary-lookup seam wrapping `Bun.which`), `display.getFor(paneId)`, `display.closeFor(paneId): void`, `display.sweepOrphans(alivePaneIds: string[])`. Refusals: `preview-display-unsupported` (non-Linux), `preview-node-off` (switch off, checked here so every entry point refuses with one voice), `preview-display-missing-binaries` (names `Xvfb`, `x11vnc`, or `xauth`), `preview-display-not-ready`.

- [ ] **Step 1: Failing unit tests** (injected deps, no real processes): `:90` free is picked, a taken lockfile (`open(path, "wx")` EEXIST) pushes to `:91`; state dir 0700, log files 0600 under `<dataDir>/displays/<paneId>/`; missing `x11vnc` refuses naming it and leaves no lock behind; non-Linux refuses by name; readiness polls the X socket then the rfb port and refuses `preview-display-not-ready` after the budget; a pane death reported through the same hook closes its display (SIGTERM to both children, lock unlinked); `sweepOrphans` closes every registered display whose pane id is absent from the alive list; the rfb-port chooser retries on collision.
- [ ] **Step 2: Fail.**
- [ ] **Step 3: Implement per spec §5:** numbers `:90..:199` via lock `<dataDir>/displays/.display-NN.lock` (`wx`); state dir for `Xvfb.log`, `x11vnc.log`, `Xauthority`, `display.env`; generate the auth file with `xauth generate -f <file> :NN .` and start `Xvfb :NN -auth <file> -screen 0 WxHx24 -nolisten tcp`; pick an rfb port by bind-probe from 5910; `x11vnc -display :NN -auth <file> -localhost -forever -shared -rfbport P` (loopback, no RFB password - spec §5 says so out loud); `display.env` carries `DISPLAY` and `XAUTHORITY` (the pinned env).
- [ ] **Step 4: `commands/launch.ts` `screen` path, in order:** platform check -> `flags.getPreviewEnabled()?.on` check (refusal BEFORE any spawn, spec §4/§6 - this is the gate reviewers flagged) -> `display.openFor` -> inject `DISPLAY` and `XAUTHORITY` into the pane env. NOT `tmux-runner.ts`'s `run`/`runAsync` `opts.env` (:188/:261) - that env is handed to the tmux CLIENT process and never reaches the pane. The seam is pane-runtime's `paneEnvFor` (`packages/pane-runtime/src/launch.ts:112`, the spread chain `{...curatedEnv(), ...subshellEnv, ...preset.env, ...mcpEnv}`): give `paneEnvFor` and `assembleHarnessCommand` an optional fourth layer `extraEnv` (empty when the pane has no display), pass `{ DISPLAY, XAUTHORITY }` there at `apps/node/agent/src/commands/launch.ts:209`, and pass it at :224 too so the exit hook's env keeps agreeing with the pane's. A comment names it the deliberate addition to the pane env, the same way the SUBSHELL_* credentials are -> spawn -> echo `screen: { display, rfbPort }` in the launch result. Any refusal fails the launch with its named reason. Pane death: the existing death report also calls `display.closeFor`.
- [ ] **Step 5: Sweep timer** beside daemon's other self-timers: hourly `display.sweepOrphans(alive pane ids)`, cloned from the ssh per-pane-dir retention pattern (`ssh-dir-retention` precedent; read it first).
- [ ] **Step 6: Green + commit** `feat(node): Xvfb+x11vnc virtual displays, gated, launched with the pane`.

---

### Task 8: The preview broker (plane)

**Files:**
- Create: `apps/server/api/src/services/preview-broker.ts`, `apps/server/api/src/services/nodes/preview-frames.ts` (the plane->node byte-frame sender: lane bytes do NOT ride `sendCommand` - `PreviewDataFrame` is a link frame, not a command; clone `sendRelayFrameOverNodeSocket` at `ssh-relay.service.ts:651` (getLive + `conn.link.sealFrame` + deliver-or-throw) and read it first), `apps/server/api/src/services/__tests__/preview-broker.test.ts`
- Modify: `services/nodes/node-ws-handler.ts` (the event switch gains arms for `preview_data` / `preview_stream` / `preview_closed`, cloning the `case "relay":` arm at :1196 that delegates to relay-frames.ts - this switch has no default branch, so THIS edit is what puts the intake on the wire; the relay-frames sibling below is unreachable without it, and a unit test that calls the sibling directly cannot see that), `services/nodes/relay-frames.ts` (route `preview_data` -> lane pump, `preview_stream` -> `onStreamEvent`, `preview_closed` -> lane/bridge close - beside its existing `getRelayBroker().routeRelayFrame(nodeId, frame)` call), the node link-drop hook (mirror how the ssh broker reacts to node disconnects), `api/users/set-user-disabled.route.ts` + `set-user-role.route.ts` (broker revoke cuts beside the existing `dropLiveSocketsFor` / relay revocation cuts), and `services/subshells.service.ts` (inside `setShares`, beside the `subshell.shares-changed` `publishLive` at :1245 - the route delegates there and touches no socket).
- Test helper: `@/__tests__/helpers/test-database.js` for audit rows.

**Interfaces:**
- Produces (Tasks 9-11 import these exact names): `openForward({ viewerUserId, paneId, nodeId, port }): Promise<{ ref }>` (route-gated edit; sends the PROBE `preview_open` kind forward, awaits ack, closes the probe lane, returns the session ref); `openLaneForConnection(sessionRef): Promise<{ laneRef }>` (fresh 32-hex lane ref + `preview_open`; queues up to 8 waiters beyond cap, then refusal `preview-lane-over-cap`); `subscribeLane(laneRef, cb: (e: { bytes: Uint8Array } | { closed: PreviewCloseReason }) => void): () => void` - keyed by LANE, not session: under decision 2 an iframe, an HMR socket, and asset requests all hold lanes under one session, and a session-keyed callback would pump one connection's bytes into every duplex (the same shape `sendLaneBytes`/`closeLaneForConnection` already use); `sendLaneBytes(laneRef, bytes)` (rides the new `preview-frames.ts` byte sender - NOT `sendCommand`: commands and data frames are different link paths, exactly as the relay split them); `closeLaneForConnection(laneRef, reason)` (sends that lane's node `preview_close`, drops the broker lane entry - Task 10's one-shot responses call it on completion, or every finished response parks a node↔target TCP lane until the 15-minute idle); `closeForPane(paneId, reason)` (every lane, session, and bridge of one pane: the pane-exit route calls it with `pane-gone`, and it is the e2e cleanup verb); `startWatch({ viewerUserId, paneId, nodeId, port }): Promise<{ ok: true }>` (REST side only: dedupe per pane+port, per-viewer SUBSCRIPTION count - not a set: two tabs of one account are two watchers, so `viewers` is `Map<viewerUserId, number>` and a tab's POST increments; zero->one sends `preview_open`, cap `preview-watch-over-cap`); `stopWatch(viewerUserId, paneId)` (the REST DELETE carries only the pane id, and it is enough; it DECREMENTs, never deletes the key - one DELETE with two tabs open leaves count 1 and the bridge alive, or one tab's unmount would kill its sibling's canvas; the count reaching zero sends `preview_close viewer-left`; a crashed tab's leaked count is bounded by the node-side lifetime sweep, accepted); `closeForGrantee(paneId, granteeUserId, reason)` (a lost SHARE closes only that grantee's sessions, watchers, and stream sockets ON THAT PANE - `closeAllForUser` would wrongly sweep their previews on other panes, which they may still hold); `attachStream(paneId, socket)` / `detachStream(paneId, socket)` + `detachSocketsFor(socket)` (the /ws/live side: the client `watch`/`unwatch` frames register THIS socket as a stream recipient after the view check; a viewer is a socket, not a user, so one device's canvas cannot light up another device's); `dropViewer(viewerUserId)`; `sessionFor(ref)`; `getPorts(nodeId, paneId)` (5 s shared cache per pane, spec §6); `onDisplayOpened(nodeId, paneId, screen)` + `onDisplayClosed(paneId, reason)` (audit + record only); `closeAllForNode(nodeId, reason)`; `closeAllForUser(userId, reason)`; `onStreamEvent(nodeId, ev)` (resolves `ev.ref` to its session's pane and fans out to THAT pane's attached sockets only - sockets are the structural `{ send(data: string): unknown; bufferedAmount?: number }` shape `LiveWsSocket` already speaks, and the fan-out IS where viewer byte-debt lives: for each socket, `if ((socket.bufferedAmount ?? 0) > PREVIEW_STREAM_DEBT_MAX) { detachStream(paneId, socket); audit slow-link; continue; }` - spec §9 drops slow VIEWERS, never the bridge, so sibling sockets keep streaming; Task 8's test fakes the member, Task 11 wires the real Bun socket that supplies it); `PreviewSession { ref, kind: "forward" | "screencast", mode: "http" | "raw", paneId, nodeId, port, createdBy, createdAt, lanes: Map<string, Lane>, viewers: Map<string, number>, lastActivity }` - `viewers` maps REST watcher to SUBSCRIPTION count (see `startWatch`/`stopWatch`; a Set would let one tab's DELETE close the bridge under a sibling), and attached stream sockets live in a separate `paneId -> Set<WebSocket>` map, because "which device sees the canvas" is socket-level state; `openForward` sets `mode` to `raw` when the port is the pane's screen `rfbPort` - consulting the `getPorts` screen record FIRST and falling back to the `onDisplayOpened` launch-time memory, so a post-plane-restart open still lands `raw` (decision 6's discriminator) - else `http`; `sessionFor(ref)` exposes it to the proxy.
- Consumes: `sendCommand` (`@/services/nodes/node-rpc.js`) for the open/close/ports COMMANDS only; lane bytes go through the new `preview-frames.ts` sender; Task 1 grammar; audit metadata SHAPE from `ssh-relay.service.ts:437-455` (actorUserId null, ids/port/kind/reason/counts, never byte content) but WITHOUT that block's `ref`: the relay deliberately includes it because "a routing ref is not a credential" (`ssh-relay.service.ts:583` says so), while a preview session/lane ref IS the credential (spec §6: it is the `/pv` path secret and appears nowhere else), so `node.preview_*` metadata carries paneId/nodeId/port/kind/reason/counts and NEVER the ref - a comment at the audit call records the divergence.

- [ ] **Step 1: Failing tests** (fake `sendCommand`, test DB for audit): open sends the probe `preview_open`, mints a 32-hex ref, audits `node.preview_forward.open` and closes the probe lane; node refusal propagates named and records nothing; lane cap: per-pane beyond 4 queues, beyond 8 waiters refuses `preview-lane-over-cap` (decision 2); watch: second viewer joins without re-sending `preview_open` (`subscribers` in the fake's ack is a lie the broker ignores; it counts itself), last leave sends `preview_close` `viewer-left` and audits `node.preview_watch.close` once per bridge (not per watcher); two POSTs from ONE user are count 2, and the first DELETE leaves the bridge OPEN (a Set-based refcount would let one tab kill its sibling's canvas); `closeForGrantee` closes that grantee's session on the revoked pane only, leaving the owner's and a second grantee's untouched; stream fan-out: after two `attachStream` calls on one pane, `onStreamEvent` delivers `{ id: paneId, seq, w, h, blob }` once per attached socket via the injected `sendToSockets` - and nothing to an un-attached socket of the same viewer; per-socket byte debt detaches THAT socket (`slow-link` audit) while the lane, the bridge, and sibling sockets keep running (spec §9); `preview_closed` from the node ends lane subscribers with its reason; DISPATCH test in `node-ws-handler.test.ts`'s style (its `handleNodeMessage(h.deps, ws, JSON.stringify({ type: "ssh_enabled", ... }))` rows at :944 are the pattern): feed each preview event type through the handler and assert the preview intake was reached - an arm missing from the switch is otherwise invisible to every other test (the switch has no default); idle sweep (injected clock) at `PREVIEW_IDLE_MS` with `idle`; `closeLaneForConnection` sends that lane's `preview_close` and frees the node slot immediately (a completed one-shot response must not park the lane until idle); `openForward` at the pane's registered screen port produces a `raw` session, any other port `http` (decision 6) - including after `resetForTests` + a fresh `openForward` when only the fake's `preview_ports_get` answer still reports the screen (plane-restart regression: memory-only discrimination would ship `http` and re-handshake raw RFB); `closeAllForUser` audits `revoked` closes; `closeAllForNode` same with `node-dropped`; `getPorts` caches 5 s then re-RPCs (two calls, one RPC); display: `onDisplayOpened` audits `node.preview_display.open` with `{display, rfbPort}`, `onDisplayClosed` audits `.close` with reason, a double-close is idempotent; `closeForPane(paneId, "pane-gone")` closes that pane's forward sessions (with their lanes), its watch bridge, and its display, auditing every close.
- [ ] **Step 2: Fail.**
- [ ] **Step 3: Implement** as a module singleton with `resetForTests({ now?, sendToSockets?, send?, linkSend? })` per `.claude/rules/code-style.md` (fake clock for the idle sweep; `send` fakes the command RPC; `linkSend` fakes `preview-frames.ts`, the byte-frame path Task 10's fake node hangs off), timers self-expiring (read `ssh-relay.service.ts`'s broker for the habit); every close path audits its pair with the named reason.
- [ ] **Step 4: Green + commit** `feat(server): preview broker with lane pools, refcounted watches, and revocation`.

---

### Task 9: REST surface, the launch `screen` field, and the authz matrix

**Files:**
- Create: `api/subshells/preview-info.route.ts`, `preview-open.route.ts`, `preview-watch.route.ts` (POST + DELETE on one path, the directory rule says one resource one file until it earns a split - these are two handlers, keep two files `preview-watch-start.route.ts` / `preview-watch-stop.route.ts` if the file-size rule bites), `api/subshells/index.ts` (mount), `api/subshells/__tests__/preview-routes-auth.test.ts`
- Modify: `api/subshells/create-subshell.route.ts` (body `screen`), `services/nodes/remote-launcher.ts` (find: `grep -rln "type: \"launch\"" apps/server/api/src` - pass `screen` into the `launch` command, surface node refusals, call `onDisplayOpened` on ack), `api/subshells/subshell-exit.route.ts` (call `broker.closeForPane(paneId, "pane-gone")` beside the death handling - it covers the display audit through `onDisplayClosed` plus every lane and bridge of the pane, so nothing calls `onDisplayClosed` on its own), `plugins/context.plugin.ts` (add the info-poll path to `REQUEST_LOG_IGNORE` - an open subshell view polls it, and the file's own comment names that as the criterion) + `plugins/__tests__/request-log-ignore.test.ts` (the pinned list gains the entry).
- Test: the auth matrix file (clone the actor-table shape from `__tests__/subshell-input-ssh.route.test.ts` and `subshell-view-ssh.test.ts`).

**Interfaces:**
- Consumes: broker (Task 8), `loadSubshellAccess` (`src/lib/subshell-access.ts:72`), `accessAtLeast` (:47), `getPreviewEnabled` (Task 3), node online/ready facts already carried by the node registry.
- Produces (spec §6's exact paths and shape): `GET /api/subshells/:id/preview` -> `{ ports, cdpPort, screen, nodeEnabled, reason }` (`nodeEnabled: false` + tooltip `reason` when the node is offline/held/too-old or the switch is off; ports `[]` when the pane is closed); `POST /:id/preview/open` body `{ port }` -> `{ proxyBase: "/pv/<ref>/" }`; `POST /:id/preview/watch` body `{ port? }` (port defaults to the cached `cdpPort`; neither -> 400 naming it) -> `{ ok: true }` (no ref is handed out: `stopWatch` is pane-keyed, which is all the DELETE carries); `DELETE /:id/preview/watch` (caller unsubscribes; idempotent); `POST /api/subshells` body gains optional `screen: { width, height }` (t.Integer 320..4096 both, every property described).

- [ ] **Step 1: Write the auth matrix test first** (it is the deliverable's spine; clone the ssh route tests' actor tables). Rows: owner and `edit` grant -> 200 on open/watch/info; `view` grant -> 200 on info and watch POST/DELETE, 403 on open; foreign account -> 404 on all four; a pane's own subshell token -> resolves as its OWNER with shares off (the `docs/security.md` §4 sibling posture): 200 on the owner's own rows, 404 on foreign - pin BOTH halves with a comment citing §4; node key -> 401 (`UnauthorizedError`, the guard's explicit node-key rejection; §5.5 - pin against the `auth-guard-bearer.test.ts:167` precedent, the REST guard is a 401 surface, not 403); system key -> nowhere without a deliberate grant, and a granted `edit` row DOES reach it (`docs/security.md` §3; pin the positive too). Body bounds: port 0 / 70000 / 1.5 / string -> 400 at the schema; watch with no `cdpPort` cached and no `port` -> 400. Info: offline node answers the SAME shape with `nodeEnabled: false` and a reason (never an error).
- [ ] **Step 2: Fail.**
- [ ] **Step 3: Implement routes** (schemas as named constants, `detail: { operationId, tags: ["subshells"] }`, mounted into the already-mounted subshells instance in `index.ts` - the Elysia `App` TS2589 trap says fold, do not re-mount).
- [ ] **Step 4: create + exit paths:** `screen` optional body -> `remote-launcher.ts` includes it on the `launch` command (preflight `getPreviewEnabled(nodeId)` false -> 400 naming the remedy BEFORE the RPC, mirroring spec §6's refusal wording; the node gate in Task 7 remains the authority); ack with `screen` echo -> `broker.onDisplayOpened`; `subshell-exit.route.ts` -> `broker.closeForPane(paneId, "pane-gone")`. Test: a launch with `screen` on a switch-off node refuses without creating the pane row's process (assert no `launch` command was sent).
- [ ] **Step 5: `bunx turbo build --filter=@internal/server` (Eden types), green, commit** `feat(api): preview REST surface, gated screen launches, and the view/edit authz matrix`.

---

### Task 10: The /pv proxy

**Files:**
- Create: `apps/server/api/src/preview/lane-duplex.ts`, `preview/pv-http.ts`, `preview/pv-ws.ts`, `preview/__tests__/pv-proxy.test.ts`
- Modify: `src/server.ts` (mount `GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS` on `/pv/:session/*` - NOT under `/api` per spec §6, and BEFORE the static SPA plugin: the file's own comment at :59-61 spells out why a root-level path mounted after it gets 404'd by the file branch, the `installScriptRoute` precedent - and register the WS upgrade handler for the same wildcard beside the ws plugin's registrations), `plugins/context.plugin.ts` (`REQUEST_LOG_IGNORE` gains `/^\/pv\//`: request lines carry the path, the path carries the 32-hex session secret, and a debug request line would therefore log a live credential - same class as the setup-key note in `apps/server/api/AGENTS.md`'s log rules; pin it in `request-log-ignore.test.ts`), `apps/server/api/package.json` (add `ws@8.22.0`, then `syncpack fix && bun install`; it is used ONLY with the documented stream-override option so it rides a lane duplex - verify `createConnection` is honored in `node_modules/ws/lib/websocket.js` before coding; there is no other way to put a `ws` client on a synthetic socket, and Bun's own WebSocket cannot be aimed there).

**Interfaces:**
- Consumes: `broker.sessionFor/openLaneForConnection/subscribeLane(laneRef)/sendLaneBytes/closeLaneForConnection` (the proxy's one-shot responses and WS tunnels close their own lanes; session death arrives from `closeForPane`/`closeAllFor*`, not from the proxy), Task 1 grammar.
- Produces: `lane-duplex.ts`: `class LaneDuplex extends Duplex` - constructor `({ writeOut(bytes): void, onLane(cb: (e: { bytes: Uint8Array } | { closed: PreviewCloseReason }) => void): () => void })`; `_write` calls `writeOut`; lane bytes `push`; lane `closed` ends the duplex.

- [ ] **Step 1: Failing unit tests** (real in-proc `Bun.serve` target + a 25-line in-test fake node that pumps `preview_data` to a loopback socket):
  - outbound `Set-Cookie` forced to `Path=/pv/<ref>/`, other attributes preserved;
  - the browser's `Cookie` header NEVER reaches the target (send `Cookie: plane=<secret>`, assert the target saw no `plane=`, and later requests rebuilt from the jar alone);
  - `Host` arrives as `127.0.0.1:<port>`;
  - upstream `Content-Security-Policy` with three directives survives as two, `frame-ancestors` gone; the report-only variant gets the same carve-out;
  - relative `Location: /foo` returns prefixed `/pv/<ref>/foo`;
  - an upgrade with a cross-site `Origin` is refused; same-origin is not;
  - binary WS round trip byte-exact in `http` mode. Lane-bypass guard, stated precisely: the in-proc `Bun.serve` target DOES answer on plane loopback, so a client that bypassed the lane would still connect and pass a naive byte-equality check - the fake node therefore COUNTS the bytes it pipes, and the test asserts the handshake plus the round-trip payload all passed through the fake (bypassing the lane leaves the counter at zero even though the response looks perfect);
  - `raw` mode (a session opened on the pane's registered screen `rfbPort`, decision 6): the fake node's raw, non-WS TCP target receives the browser's WS frame payloads verbatim and answers in kind, with no HTTP upgrade ever reaching the target (x11vnc would read it as a bogus RFB version);
  - unknown `/pv/<secret>/` -> 404, body leaks nothing; and `/pv/<anything>` matches `REQUEST_LOG_IGNORE` (the secret in the path must never reach a request line);
  - pre-ack buffer: bytes sent before the fake node acks past `PREVIEW_LANE_BUFFER_MAX_BYTES` close the connection `slow-link` (spec §6's no-phantom-success).
- [ ] **Step 2: Fail.**
- [ ] **Step 3: Implement `pv-http.ts`:** resolve session (unknown -> 404); `openLaneForConnection` (await broker's cap/queue); `LaneDuplex`; `node:http.request({ createConnection: () => duplex, method, path: stripped + query, headers })`; transform INBOUND: drop `cookie`, set `host` to the literal `127.0.0.1:${port}`, drop `connection`/`keep-alive` (one-shot lane per request - the browser reconnects, the jar carries state); transform OUTBOUND: drop hop-by-hops, rewrite `set-cookie` Path, rewrite relative `location`, strip only `frame-ancestors` from both CSP headers; stream the body through; lane `closed` before completion -> 502 naming the reason, never a mid-stream retry (a POST may have landed).
- [ ] **Step 4: Implement `pv-ws.ts`:** upgrade on `/pv/:session/*` - any suffix is the tunnel root (noVNC and Vite HMR each dial their own path; the session secret authorized the upgrade, spec §6): `Origin` must equal the plane's own origin (refuse cross-site), open a dedicated lane, then BRANCH by `sessionFor(ref).mode` (decision 6, and one mode cannot serve both consumers - spec §5's blind pump is exactly right for RFB and exactly wrong for a target that is itself a WS server). `mode === "raw"` (the screen `rfbPort`): websockify semantics - the browser WS's binary frame payloads pump straight onto the lane and lane bytes out pump back as binary frames, no re-handshake; the target is a raw TCP RFB server. `mode === "http"`: redial with the `ws` client `new WebSocket(`ws://127.0.0.1:${port}/${rest}`, { createConnection: () => laneDuplex })` - TOP-LEVEL `createConnection`, which is the real option in `node_modules/ws/lib/websocket.js`; read that file first, because a wrong key (e.g. a `net:` wrapper) is silently IGNORED and would dial plane-local loopback around the lane. Both modes: pump both directions, beyond `PREVIEW_LANE_BUFFER_MAX_BYTES` buffered close both `slow-link`; either side closing closes both and the lane, reason `viewer-left`.
- [ ] **Step 5: Green; `bun run lint:lockfile`; commit** `feat(server): same-origin /pv proxy with cookie jar, CSP carve-out, and WS tunnel`.

---

### Task 11: Live feed plumbing and the §11.14 control

**Files:**
- Modify: `ws/live-ws.ts` (client-frame switch: `watch`/`unwatch` -> `broker.attachStream(paneId, socket)` / `detachStream(paneId, socket)` after a `loadSubshellAccess` >= view check against the socket's holder - the frame carries only the pane id and attach needs nothing more, bridge lifecycle stays on the REST path so no nodeId/port resolution lives here; socket close -> `broker.detachSocketsFor(socket)`), `ws/live-registry.ts` (add `sendToSockets(sockets: Iterable<WebSocket>, frame: LiveServerFrame)` - per-SOCKET, because the §11.14 matrix row demands "not the owner's sockets that never watched" and a user-keyed send cannot express that; leave the existing publish path untouched), `ws/live-ws.ts` again (the `LiveWsSocket` interface gains `readonly bufferedAmount?: number` with a comment in the readyState habit at :59-60: Bun's ServerWebSocket supplies it, a hand-rolled double may omit it and reads as zero debt), `services/preview-broker.ts` (production wiring: the `sendToSockets` parameter's DEFAULT is live-registry's - this is where Task 8's injectable seam meets the real sockets), `ws/__tests__/live-ws.test.ts`, `ws/__tests__/live-consistency.test.ts`.
- Test: extend both files.

**Interfaces:**
- Consumes: Task 2 frames, Task 8 broker, `loadSubshellAccess` (:72).
- Produces: `sendToSockets`; for a holder with `view`+, `{"type":"watch","id":paneId}` attaches that socket, and a running bridge then delivers `{"type":"preview-stream","id","seq","w","h","blob"}` to attached sockets only.

- [ ] **Step 1: Extend `live-ws.test.ts`:** watch from a `view` grant attaches the socket and a stream frame then arrives with `blob` untouched - and it reaches that socket ONLY, not the same holder's second test socket that never watched; watch on a foreign pane attaches nothing (spy) and the socket stays open; `unwatch` stops delivery; socket close detaches its panes (the holder's other socket is unaffected); byte debt from one lagging socket detaches THAT socket (`slow-link` audit), the lane and the bridge keep running.
- [ ] **Step 2: Extend `live-consistency.test.ts` (THE control - read every existing row first and keep them; the rule is "never delete or weaken").** For each existing (viewer, access) pair add the watch case: after a `watch`, the sockets that receive `preview-stream` for pane P are EXACTLY the view-+ holders that sent `watch` (not admins without watch, not the owner's sockets that never watched, no extra sockets). A mid-stream grant removal stops frames to that socket while the socket lives (the row survives - compare, do not guess, against how the matrix handles revocations today).
- [ ] **Step 3: Implement** (small) and make the matrix rows pass - the matrix drives broker-side leak fixes, not the other way round.
- [ ] **Step 4: Green + commit** `feat(server): live watch subscriptions through the authorization control`.

---

### Task 12: Dashboard preview section, hook, and the three surfaces

**Files:**
- Create: `apps/server/web/src/hooks/use-subshell-preview.ts`, `lib/preview-bus.ts`, `components/preview/preview-section.tsx`, `components/preview/port-list.tsx`, `components/preview/open-panel.tsx`, `components/preview/watch-viewer.tsx`, `components/preview/screen-launch-hint.tsx`
- Modify: `routes/subshells_.$id.tsx` (compose under the terminal, spec §7's column), `hooks/use-live-subshells-feed.tsx` (dispatch `preview-stream` to the bus AND export its existing client-frame send - the `send(socket, LiveClientFrame)` helper at :23, already used for `previews`/`resync` at :156/:174, because `watch`/`unwatch` never reach the server unless the SPA sends them), node settings page (the Preview toggle beside the ssh one, same gate/tooltip posture - read the ssh toggle's component first), create dialog (optional "Virtual display" -> `screen` body field), phone layout check (grep how the dock trades tiling for tabs and reuse the same layout predicate).
- Test: `components/preview/__tests__/` cloning whatever render harness `routes/__tests__/setup.test.tsx` uses (check `find apps/server/web/src -name "*.test.ts*"` and imitate the lighter precedent if one exists).

**Interfaces:**
- Consumes: Task 9 routes via the Eden treaty client (`bunx turbo build --filter=@internal/server` after routes land), Task 11 frames via the bus, row `access` exactly as `subshell-terminal.tsx` reads it.
- Produces: bus `subscribePreview(paneId, cb: (frame) => void): () => void`; hook `{ info, openPort, startWatch, stopWatch, refresh }` where `startWatch` does BOTH halves of a watch (REST POST for the bridge, then `send({"type":"watch","id":paneId})` on the live socket for THIS device's stream registration) and `stopWatch` mirrors it (DELETE + `unwatch`) - the REST half alone starts a bridge whose frames have no recipient socket, and unit tests pass while the real browser sees nothing.

- [ ] **Step 1: Tests** (render-level): `view` render shows Watch toggles and no Open/Screen controls, each Open control tooltip-disabled with the REAL reason string (`nodeEnabled: false` -> the switch's remedy wording; per AGENTS disabled-control rule); `edit` adds Open, which opens the collapsible side panel hosting the `/pv/` iframe plus an "open in new tab" affordance (assert both, spy the anchor's href = `proxyBase`); Watch canvas swaps to the newest frame blob and ignores a lower `seq`; a fake clock past 5 s with no frame renders the stale "still there?" state (never a frozen page reading as live - spec §7); `cdpPort` vanishing mid-watch renders "browser gone" wording beside the stale canvas (spec §5's mapping; the info refresh is what carries it); `startWatch` fires BOTH halves (spy: REST POST plus a `{"type":"watch","id"}` frame on the exported live-send) and `stopWatch` mirrors it - a test that lets either half pass silently is how Watch ships dead; the shared-pane banner variant is raised once per device on first Preview open (read `use-trust-notices` + `TrustIndicators` first and reuse, do not re-invent); info refresh fires on pane focus and after an output burst, throttled to one request per 5 s window (visible throttling per spec §7; the spec's request-log parenthetical was an erratum - throttle is the requirement).
- [ ] **Step 2: Fail.**
- [ ] **Step 3: Implement.** Port rows: `label` over `detail`, kind badges server / browser-debug / screen; actions are the three named verbs (spec §12.1); copy has no em dashes; `screen` presence shows the `screen-launch-hint` line (DISPLAY values from `info.screen`) for `edit` - the Screen BUTTON itself arrives with Task 13, render no dead one here; on phone layouts the Open/Screen panel does not render, Watch still does (spec §7).
- [ ] **Step 4: `bunx turbo build`, green tests, commit** `feat(web): Preview section with Open panel, Watch canvas, and the node switch`.

---

### Task 13: Screen viewer with @novnc/novnc (static import)

**Files:**
- Modify: `apps/server/web/package.json` (`bun add @novnc/novnc` -> `1.7.0`, `syncpack fix`, `bun install`)
- Create: `apps/server/web/src/components/preview/screen-viewer.tsx`
- Modify: `preview-section.tsx` (Screen action when `info.screen` and `edit`: a forward-open against `info.screen.rfbPort`, then the viewer in the panel)
- Test: `components/preview/__tests__/screen-viewer.test.tsx` (mock the `@novnc/novnc` module: `mock.module` per bun; assert the constructed URL is the session's WS tunnel root `${wsProto}//${location.host}${proxyBase}` and disconnect reasons render a human line each: `slow-link`, `revoked`, `viewer-left`, `target-gone`).

**Interfaces:** Consumes: the forward lane (Screen REUSES it - zero new protocol); produces `screen-viewer.tsx`.

- [ ] **Step 1: Read the library's real shape** (`sed -n '1,80p' node_modules/@novnc/novnc/core/rfb.js` for the constructor/options; `docs/API.md` ships in the package's `files`). Static top-level `import RFB from "@novnc/novnc"` - decision 4, no dynamic import anywhere.
- [ ] **Step 2: Failing test** (mocked module; the component constructs on mount, disconnects on unmount - assert the lane's `viewer-left` path).
- [ ] **Step 3: Implement:** `new RFB(el, wsUrl)` with `scaleViewport = true`, `focusOnClick = true`; no credentials (spec §5: the lane and the grant are the authentication); `on disconnect` render the reason, `clipViewport` false.
- [ ] **Step 4: License record:** the package ships its MPL-2.0 LICENSE and `bun run lint:licenses` governs package fields; if the repo has a third-party notices list (`grep -riE "third[-_ ]?party" apps/website apps/docs docs | head`) add an entry, else say in the commit body that the package's own license file is the record (decision 1).
- [ ] **Step 5: Green + commit** `feat(web): noVNC screen viewer over the forward lane`.

---

### Task 14: e2e, docs, changeset, boundary verification

**Files:**
- Create: `e2e/preview.spec.ts`, `apps/docs/content/docs/preview.mdx` (user procedure: enable per node, watch a browser pane, open a server, Screen on Linux, mac's refusal is expected), changeset via `bunx changeset` (`@internal/server` minor + `@internal/node` minor; never hand-edit CHANGELOGs).
- Modify: `apps/docs/content/docs/meta.json` (register `preview` in the `pages` list - Fumadocs renders only listed pages, so an unregistered page is an invisible page; pick the section the guides live in), `apps/server/api/AGENTS.md` (audit inventory: `node.preview_forward.open|close`, `node.preview_watch.open|close`, `node.preview_display.open|close`, `node.preview_enabled.update`; preview-lane rules paragraph: loopback-only, the plane sees proxied bytes deliberately per spec §8, the §11.14 control now covers watch frames), `docs/security.md` (pointer paragraph in the relay accounting, matching how the relay lane is accounted), `apps/node/agent/AGENTS.md` (preview executors join the executor inventory; loopback invariant; `Xvfb`/`x11vnc`/`xauth` as optional runtime deps with named refusals).

- [ ] **Step 1: e2e at API level through the stack helper** (async helpers only - the sync-spawn starvation trap): launch a terminal pane running `bun -e 'Bun.serve({port:4123, fetch: () => new Response(new TextEncoder().encode("ok"), { headers: { "set-cookie": "t=1" } })})'`; as owner cookie poll `GET /preview` (throttle-respecting) until `ports` lists 4123; `POST /preview/open` and fetch `/pv/<ref>/` through the plane: body `ok`, cookie jar rewrite observed on the response; watch/unwatch leg: the e2e server is a CHILD PROCESS (`e2e/stack.ts:153` spawns it, so there is no in-proc seam to inject a fake stream through and no task creates one), so this leg asserts only the subscription round trip that REST + live can prove: watch POST 200, the broker's watch audit row appears, `DELETE` idempotent. Frame delivery through `/ws/live` is owned by Task 11's unit matrix (the §11.14 control) and the real frames by Step 2's container leg; say so in the spec file's comment so the next reader does not hunt for a missing assertion. Clean up sessions, pane, then close.
- [ ] **Step 2: Real-leg container run (manual, log results on the branch, not in CI):** Linux container with `chromium`, `xvfb`, `x11vnc`, `xauth` enrolled as a real node against `e2e/stack.ts`'s backend (spec §10): launch a pane with `screen`, run `chromium --remote-debugging-port=9222 http://localhost:4123` inside it, confirm Watch frames arrive (screenshot diff), confirm `ports` shows `{4123, 9222, screen}`, open a Screen RFB session through `/pv/` and confirm frame bytes flow. Then the mac node: every preview route answers its named refusal (`preview-ports-unsupported`, `preview-display-unsupported`), forward lanes still work with a hand-pinned port (spec §10's mac leg).
- [ ] **Step 3: Docs paragraphs** (voice rules; `bun run lint:prose` clean).
- [ ] **Step 4: Full boundary:** `bun run verify-types && bun run lint:check && bun run lint:prose && bun run test`, `bunx turbo build`; fix any protocol-23 stragglers.
- [ ] **Step 5: Commit + push the branch. NO PR** - hand the user the test checklist (node switch UI, watch a live browser pane, open a dev server, Screen on Linux, refusals on mac).
