# Pane Preview: watching and opening what a pane's process shows

Date: 2026-10-21. Status: approved; §12 settled in review. Branch: `feat/pane-preview`.
Implements one user ruling set: watch follows `view`, use follows `edit`; the full ladder (forward, CDP view, virtual display) ships in this arc; ports are auto-detected with an explicit pin beside them.

## 1. Why

A pane starts a dev server, an app, or a browser doing automation. Its terminal already streams, and that covers the typing and the logs. What it cannot cover is the *rendered* result: the page the server is serving, the page the automation is driving, the window the GUI app drew. Today a person reaches for a mesh plugin and a hand-run VNC server, or gives up. This spec adds a first-party **Preview** surface to the pane view: see the browser, open the web app, and (on Linux) watch or drive a pane's virtual screen.

Two decisions from the idea phase are load-bearing:

- **It is not a plugin.** Plugins load in the control-plane process only, and a node holds no plugin code (spec 2026-09-10 §inversion, root `AGENTS.md`). Anything that runs on a node is first-party daemon code. The plugin contract is left exactly as it is.
- **The transport reuses the relay lane's shape, not the SSH agent's semantics.** The `relay` link frame pairs two endpoints by an opaque ref and blind-routes opaque blobs between them (`ssh-relay.service.ts` `createRelayBroker` / `routeRelayFrame`; the frame grammar in `node-frames.ts:1446+`). Preview needs the same pairing with a *browser* on one end, which no existing lane carries (the relay pair is agent↔node by `isRelayDirection`, `node-frames.ts:1424`).

## 2. The three surfaces, and the grant each one sits at

| surface | what it is | grant | why |
|---|---|---|---|
| **Open** | a live proxy to a port the pane listens on: HTTP and websocket, rendered as an iframe or a new tab | `edit` | an HTTP forward is authority: it can POST anything as a trusted localhost client |
| **Watch** | a read-only live view of a browser the pane is driving, via the node speaking CDP to loopback and streaming `startScreencast` frames to the dashboard | `view` | it is exactly the read-only-terminal posture moved one layer up; observation, not input |
| **Screen** | a virtual display (Linux): the pane runs on an allocated `DISPLAY`, the node runs `x11vnc` on loopback, and the dashboard renders it with vendored noVNC over an Open lane | `edit` | RFB carries input whether or not the UI exposes it; it cannot honestly sit at `view` |

The existing card/pane **screen preview** (tmux capture lines, `live-frames.ts` `preview` frame) keeps its name in code and prose as "screen preview"; it already covers TUI panes and is untouched by this design.

## 3. Architecture

```
 browser (dashboard SPA)                      control plane                       node (daemon)
 ───────────────────────                      ───────────────                     ─────────────
 iframe / new tab ─HTTP─────▶ /pv/:session/   ◀─pair by ref─▶  preview_data frames ▶ dial 127.0.0.1:PORT
 app WS + HMR, noVNC RFB ─WS▶ /pv/:session/   (in-process      (new link frame,      loopback-only, capped
                                              byte pump,       capped blob)          blob)
 Watch canvas ◀──frames── /ws/live ◀── preview_stream event ── node CDP bridge:
                            subscribers        fan-out          /json/list, startScreencast, acks
 Preview panel ◀── GET /api/subshells/:id/preview (ports list; plane RPC → node)
 open/watch POSTs ──cookie──▶ gate check, signed command to node, session created under /pv/:session/
                              (the 128-bit path secret IS the lane credential; there is no token to mint)
```

One lane mechanism, three consumers. The plane pairs each session by an opaque ref exactly as the ssh-relay broker does, pumps capped blobs both ways, and never parses the payload it moves (it does *see* proxied bytes in transit; that is accepted, §8).

## 4. Protocol: bump 22 → 23, shipped together

Doctrine copied from the bump history (`node-frames.ts:80-187`): additive in shape, breaking anyway because the gate is exact-match; server first; `MIN_NODE_VERSION` and `apps/node/agent/package.json` rise in the same commit). There is no feature flag and there will not be one: a lagging agent is held (update-only) until the desktop update path crosses it, the same doctrine `ssh_enabled` (16) and the agent relay (18) used, because a capability gate cannot live with "old agent ignored the frame" reading the same as "new agent answered no."

Bump-history entry to land with the code:

> **22 -> 23:** the preview surface. `preview_open` / `preview_close` signed commands and the `preview_data` link frame carry a gated byte lane between a dashboard viewer and a pane's loopback port (forward and CDP bridge kinds); the `preview_stream` event carries read-only screencast frames; `preview_ports_get` reports a pane's listening ports and CDP/screen hints; `set_preview_enabled` mirrors a per-machine owner switch; a launch may carry a `screen` request. An agent below 23 understands none of it, and the exact-match gate is what refuses pairing before any of it is sent.

New **signed commands** (`node-frames.ts` grammar + census test, `node-results.ts` validators for each answer):

- `preview_open { ref, kind: "forward" | "screencast", paneId, port, fps?, lifetimeMs }`
  forward: dial `127.0.0.1` / `::1` only, refuse anything else, answer `{ok, pending:true}` and connect off the exec chain (the `ssh-relay-exec.ts` A-branch precedent: a hung target must not park unrelated commands). screencast: start or attach the node-side CDP bridge for (paneId, port), answer `{ok, subscribers}`.
- `preview_close { ref, reason }` - never gated (teardown is not a preview act, the `set_ssh_enabled` doctrine); unknown ref answers `{ok, closed:false}` and tombstones briefly so a late ack cannot orphan a socket.
- `preview_ports_get { paneId }` - answer `{ ports: [{proto, port, pid}], cdpPort: number|null, screen: {display, rfbPort}|null }`. Linux: TCP listeners attributed by socket inode across the pane's tmux process tree (`TmuxRunner.panePid`, `tmux-runner.ts:447`). `cdpPort` is set when a listed port answers `GET /json/version`. Non-Linux: refuse by name; a hand-pinned port still opens (dialing loopback needs no detection).
- `set_preview_enabled { enabled }` - the owner switch, plane is sole author (the `set_ssh_enabled` shape exactly: mirror file, `ready.previewEnabled`, change event, fail-closed when the mirror is missing).

New **link frames**:

- `preview_data { ref, dir: "in" | "out", blob }` - base64 in-JSON like `RelayFrame`; cap `PREVIEW_FRAME_MAX_BYTES = 262_144` (constant beside the relay caps in `ssh-limits.ts`, which becomes the home of shared link-lane limits). A sender exceeding the cap gets the session closed with a named reason, not fragmentation, in v1.
- `preview_stream { ref, seq, w, h, ts, blob }` - event direction (node→plane). Screencast JPEG at quality 60, `everyNthFrame` tuned to ≤ 5 fps (bridge clamps `fps` to [1, 5]). Plane fans the identical blob out to that session's subscribers on their `/ws/live` sockets; it is the one plane-side broadcast that carries pane *content*, and the justification is §8.

New **launch field**: `launch.screen?: { width, height }`. A node below the feature (never reached post-bump) or a machine with the switch off refuses the launch naming the remedy, before spawning anything.

## 5. Node side

Executor arms live beside the relay arms (`commands/ssh-relay-exec.ts` is the shape to copy, `commands/index.ts` the dispatch switch to extend) and honor the daemon's contract: verified command only, result before anything long-running (`pending:true` + off-chain connect), timers self-expiring so a forgotten session dies on the machine rather than parking, never `process.exit`, refusals that name ids and remedies.

**Forward session.** Dial loopback; on connect, feed the existing deliver-or-throw pump (`relay-send.ts`) with `preview_data` frames. Node-side backpressure: bytes the link will not take accumulate to 1 MiB, then the session closes with reason `slow-link` (plane mirrors it to the browser). On socket drop or `preview_close`, the local socket is destroyed; the daemon's death takes every socket with it.

**CDP bridge** (`preview_bridge.ts`, one per `(paneId, port)`): `GET /json/list` → newest `page` target → WebSocket connect → `Page.enable`, `Page.startScreencast`. Frames are acked immediately (`Page.screencastFrameAck`) whether or not any viewer is slow: this is observation, so the bridge's backpressure is *dropping*, never the browser's. Subscribers are refcounted plane-side: the node hears `preview_open` only on the zero→one transition and `preview_close` on one→zero, so a tenth watcher costs the node nothing. Idle 60 s with zero subscribers → bridge closes itself. A browser that quits mid-watch closes the bridge with a named reason the plane turns into `subshell-recheck`-shaped UI state ("browser gone"), not a dead panel.

**Virtual display** (Linux only, and the spec says so out loud rather than degrading): display ids allocated `:90+N` from a per-node lockfile; per-pane state under `<dataDir>/displays/<paneId>/` (dir 0700, files 0600) following the `<dataDir>/ssh/<paneId>/` precedent including the hourly orphan sweep and byte-re-derived paths (`ssh-render.ts` doctrine: what the wire claims is checked against the machine's own derivation, never trusted). On a `screen` launch: start `Xvfb :N -auth ...`, write the pinned env, spawn the pane with `DISPLAY=:N`; start `x11vnc -display :N -localhost -rfbport <auto>` bound to loopback, **no RFB password** (authentication is the lane and the plane's grant check; a password the plane would store adds nothing). Missing `Xvfb` or `x11vnc` refuses the launch/`preview_ports_get.screen` with the binary named; nothing else about the pane is held hostage (a `screen` pane whose server died keeps running; the Screen button reads why). Pane exit tears the display down (`reportDeath` / the plane's death hooks); the sweep catches what a crash orphaned.

**Ports walk.** One pass per `preview_ports_get`, no standing watcher: read `netlink`/`/proc/net/tcp{,6}` once (plain `/proc` parsing, no new dependency), collect socket inodes, walk the pane pid's descendants via `/proc/*/stat` `PPid` fields, match inodes. Cache server-side (§6) instead of node-side; the node stays stateless here, which is the kind of thing that does not rot when a pane forks weirdly.

## 6. Plane side

**REST** (cookie-only routes under the subshells group, visibility resolved by the existing per-subshell gate; bearer actors get the same gate result they get for terminal input):

- `GET /api/subshells/:id/preview` - `view`+. Plane RPCs `preview_ports_get` (cached 5 s per pane, one shared cache so ten tabs cost one walk) and answers `{ ports, cdpPort, screen, nodeEnabled }`. Node offline or too-old answers the same shape with `nodeEnabled: false` and a reason the button tooltips.
- `POST /api/subshells/:id/preview/open { port }` - `edit` only. Gate check, mint session (a fresh 128-bit path secret, bound to creator + pane + port + ref), send `preview_open`, await the delivered ack, return `{ proxyBase: "/pv/:session/" }`. The response is the only place the secret appears. Audits `node.preview_forward.open`.
- `POST /api/subshells/:id/preview/watch { port? }` (port defaults to `cdpPort`) - `view`+, idempotent (a second watcher joins the bridge, plane-side refcount). Sends `preview_open` kind `screencast` when the bridge is new. Audits once per bridge, not per watcher.
- `DELETE .../preview/watch` - unsubscribe; last one out closes the bridge with `preview_close`.

**Session lifecycle, and why there is no token.** Creation is a cookie-authed REST call, so it carries the same check every attach token would re-ask at redemption; afterward, the 128-bit `:session` path secret is the lane credential, and an attacker who cannot read the JSON response cannot use the lane. A token store (and the `ws-token.ts` single-use machinery, cap, and disable-drop walk it needed) would guard nothing this model does not already guard at the door. What replaces the disable-drop: the plane indexes live sessions by creator, and **account disable closes them** with reason `revoked`, exactly the argument `dropUserTokensFor` makes for tokens (the socket could otherwise re-open the access the disable ended). Grant revocation closes the same way, riding the revocation cuts the relay broker already has; pane death, idle, and cap closes carry their own named reasons.

**Browser lanes.** One new surface, mounted beside the SPA routes (not under `/api`, so HMR-relative clients stay sane): `/pv/:session/*`. `:session` is a fresh 128-bit path secret bound to the creating viewer. Rules: strip browser `Cookie` **inbound**; hold upstream `Set-Cookie` in an in-memory per-session jar, rewritten to `Path=/pv/:session/` and attached to lane requests only, so a node app can never touch a plane cookie and a plane cookie never leaves the plane origin. Rewrite `Host` to `127.0.0.1:port` (dev servers' host checks need this; a Vite-style app may still need `allowedHosts` - documented, not silently patched). Strip only the `frame-ancestors` directive from upstream CSP so the iframe can embed at all; everything else passes untouched, and the spec records that overriding an embedded app's framing policy is exactly what this feature promises, on a trusted network. **WS upgrades under `/pv/:session/` are the raw tunnel for everything websocket-shaped** (HMR, app sockets, noVNC's RFB): the session secret authorizes the upgrade, it is refused on a cross-site `Origin` (the rebinding-shaped check `attach` relies on for cookies has its analogue here in the unguessable path plus this Origin check), and bytes pump both directions blind. Before the node's connect ack lands, browser-side bytes buffer to the same 1 MiB cap, then the session closes `slow-link` the same way - no phantom success while a port is still dialing.

**Screencast fan-out.** `/ws/live` gains frames (both ends share `live-frames.ts`, as designed): server `{ type: "preview-stream", id, seq, w, h, blob }`; client `{ type: "watch", id }` / `{ type: "unwatch", id }`. Subscribing re-checks visibility (the feed's own authorization path; **the §11.14 exhaustive diff test between the two paths grows preview rows as a required task, not a follow-up**). A `subshell-recheck`/`subshell-gone` for a watched pane unsubscribes and refcounts the bridge client-side, and the plane independently drops that viewer from fan-out on any revocation cut it already performs.

**Limits and lifetimes** (constants beside the relay's in `ssh-limits.ts`, enforced plane-side where addressable and node-side where the socket lives): forward session idle 15 min (either side silent); max 4 concurrent forwards per pane, 16 per node; max 8 watch subscribers per bridge; every close carries a named reason (`viewer-left`, `pane-gone`, `node-dropped`, `slow-link`, `over-cap`, `idle`, `revoked`) in both the refusal copy and the audit row. All state is in-process, consistent with the relay registry and the accepted single-process posture (§11 bus caveat).

**Audit** (names join the inventory in `apps/server/api/AGENTS.md`; metadata carries ids, port, kind, named reason, and counts, never byte content): `node.preview_forward.open|close`, `node.preview_watch.open|close`, `node.preview_display.open|close`, plus `node.preview_enabled.update` for the switch (mirrors `ssh_enabled.update`).

**The owner switch.** Node Settings gains "Preview" (owner, admin on `local`, mirroring `ssh_enabled`'s gate): default **off**, fail-closed, plane pushes the mirror, refuses implicit-enablement (unlike SSH's launch-time implicit enable, preview has no launch-time reason to turn itself on except an explicit `screen` launch, which requires the switch already on).

## 7. Dashboard

Pane detail (`routes/subshells_.$id.tsx`, the same terminal-wrapper column) gains a **Preview** section under the terminal:

- Port list from `GET /preview`, refreshed on pane focus and after any pane-output burst, throttled to one request per five-second window. Each row: port, detected kind (server / browser-debug / screen), **Open** (tooltip-disabled with the real reason when `access === "view"` or the node switch is off), **Watch** on the browser row.
- Open renders a collapsible side panel holding the `/pv/` iframe with an "open in new tab" affordance; Watch renders a canvas fed by `preview-stream` frames with an fps/age badge and an explicit "still there?" staleness rule (no frame for 5 s reads stale, matching the feed's posture rather than showing a frozen page as live).
- Screen opens the noVNC canvas over a forward session (`edit`-gated) pointed at the pane's `screen.rfbPort`, RFB bytes riding `/pv/:session/` upgrades.
- Gating reuses the existing trio: disabled control + `disabledReason` tooltip per the design system; `view` vs `edit` read from the row's resolved `access` exactly as `subshell-terminal.tsx` does for stdin. Disclosure: the foreign-node icon and banner machinery (`use-trust-notices`, `TrustIndicators`) is unchanged, but the Preview section raises the **shared-pane** banner variant once per device when first opened, because this surface shows more than the terminal does.

**noVNC**: vendored `core/rfb.js` + `include/` subset at a pinned tag, MPL-2.0 notice files kept beside it, loaded lazily as a dynamic chunk. (Licensing: MPL at file level composes with the SPA's AGPL; `lint:licenses` sees no package edge because there is no package - the vendored LICENSEs are the record.)

**Mobile**: Watch renders frames fine. Open/Screen are desktop-first: the panel simply does not render on phone layouts, the same way the dock already trades tiling for tabs.

## 8. Security posture, stated plainly

The delta this feature adds, against the threat model's own frame (trusted network, OS-user boundary is the trust boundary, `docs/security.md` §0-§1):

1. **It exposes pane loopback ports through the plane.** Bounded: dial targets are only `127.0.0.1`/`::1`, gated per pane per viewer by the existing visibility model at `edit` (Open/Screen) or `view` (Watch), expiring, revoked with grants and with account disable, audited by name. It does not open any listener on the node beyond loopback, and nothing may bind non-loopback.
2. **The plane sees proxied bytes.** Unlike the ssh-agent relay's seal, the forward lane is not end-to-end encrypted through the plane. That is deliberate and cheap to say: a trusted-network posture already lets the plane read every pane's screen and every keystroke, and E2EE-ing RFB/HMR streams would buy nothing against the threat the seal was defending (the plane deciding what a key signs). A future plane-hostile deployment is §12 territory, not this feature's job.
3. **RFB streams ride `/ws/live`.** Screencast frames are pane content on the broadcast feed, so they get the feed's authorization machinery plus the diff test, or they do not ship.
4. **`/pv/:session/` is a same-origin proxy**, which is why cookies are stripped inbound and jarred per session: the point is that an embedded node app can never read plane credentials, and the secret path plus same-site posture stands in for what a separate origin would normally provide. The honest residual: an XSS in the *embedded app* runs in the plane's origin scoped to that iframe - on a network where the OS user already owns the machine and the plane already owns the machine's OS user, this is inside the model, not outside it. `frame-ancestors` on the plane's own SPA headers stays a separate decision this spec neither makes nor blocks (today there are no CSP headers at all; that gap gets its own note, not smuggled in here).
5. **The owner switch keeps a node owner in the loop** the way `ssh_enabled` does. Nobody's machine starts serving previews because a viewer wanted one.

## 9. Failure modes worth naming

Node offline / held / too-old: panel reads the reason (the gates doc's refusals already name remedies), controls stay inert. Pane exits: everything closes with `pane-gone`, screen teardown follows the death hook, the sweep catches the crash case. Viewer lag: plane-side per-socket byte debt closes that one viewer's lane with `slow-link` and tells it why; a laggy noVNC never degrades the pane's owner's own view. CDP port that is not CDP (pin mistake): bridge refuses within the handshake budget, `preview_watch.close` reason `not-cdp`. Xvfb or x11vnc vanishing mid-pane-life: Screen reads stale with the binary named; the terminal keeps streaming. Multi-tab: Open is per-tab session; Watch refcounts share one bridge.

## 10. Testing

- **Protocol**: parse/census tests for every new frame/command in `node-frames.test.ts` style, validators both-ends per `node-results.ts` header rule.
- **Node**: executor tests with fake sockets on the `__tests__/commands-ssh-relay.test.ts` precedent (dial refusal on non-loopback, backpressure close, bridge ack-while-unwatched, tombstoned close); ports walk against fixture `/proc` trees (inject the reader, Linux-gated test); display allocation/teardown against stub binaries; retention sweep reuse of the ssh-dir test pattern.
- **Plane**: session-lifecycle tests (creation gate, secret unguessability, disable closes live sessions `revoked`, grant-revocation cut reaches the lane); route tests on the auth-tables helpers (visibility matrix: owner/view/edit/admin/bearer × open/watch/ports); the **live-authorization diff test grows preview rows** (the exhaustive pairing is the control); proxy tests (cookie strip, jar path scoping, Host rewrite, frame-ancestors strip only, Origin refusal on upgrade, pre-ack buffer cap).
- **Client**: gating-matrix renders (disabled + reason per state), stale-frame rule, watch subscribe-on-visibility-change.
- **Live**: a Linux container (chromium + xvfb + x11vnc) enrolled as a real node against `e2e/stack.ts`'s backend, driving one end-to-end: launch screen pane, open port, watch cdp, screen canvas byte flow. Mac node covers the non-Linux refusals and forward lanes with a hand-pinned port. Neither live path gates the unit suite; they are the boundary check before hand-to-human testing.
- Verification at boundaries: `verify-types`, `lint:check`, `lint:prose`, `test` full, plus `rust:check` only if any Rust is touched (none expected).

## 11. Out of scope, named so it stays out

Non-loopback forwarding (never, per §8.1); any TLS or mesh assumption (transport is the operator's, §0); macOS/*BSD virtual display (the refusal is the answer); VNC to machines Subshell does not own; previewing *another* user's app over the mesh outside this feature's authz; E2EE preview (future, if the model ever changes); per-app URL path config, auth injection, cookies beyond the jar; renaming the existing screen-preview.

## 12. Decisions from review (2026-10-21)

1. UI surfaces are three named verbs: **Open**, **Watch**, **Screen**, in a Preview section; tooltips carry the grant reason.
2. Watch defaults: **5 fps, JPEG q60**, node-clamped. Accepted wire cost: ~400 KiB/s per watched browser per subscriber (fan-out is per socket).
3. Proxy path: **`/pv/:session/`**, mounted beside the SPA routes.
4. RFB client: **vendored noVNC `core/` at a pinned tag** with its MPL-2.0 license files beside it, lazy-loaded chunk. This is the arc's only dependency-shaped call outside npm pinning.
