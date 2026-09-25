# Live attach: the shared-geometry rule, both attach paths, and terminal-attach diagnostics. Moved verbatim from AGENTS.md ("Architecture"); AGENTS.md keeps the summary and routes here.

The pane's size with SEVERAL viewers attached is not decided here: the rule is
`shared-geometry.ts` in `@internal/subshell-protocol`, because the browser has
to EXPLAIN the same decision the server APPLIES. It picks the smallest
capacity among the narrowest non-empty **rung** (devices being rendered whose
viewer can type, else any device being rendered, else every attached device)
with a pin overriding all of it. A rung that holds nobody with a usable size is
skipped, so excluding a device can never shrink the pane below what the
remaining ones reported.

`ws/subshell-ws.ts` owns the state around it: the per-subshell viewer registry
(keyed by `viewerId`, NEVER by socket identity; Elysia hands `close` a
different wrapper than `open`) and the in-memory sizing policy, dropped with
the last viewer. `resetLiveViewersForTests()` clears ALL of that module's
per-subshell state together (viewers, policy, heartbeat stamps, pumps, applied
geometry) because tests reuse subshell ids and any one of those surviving a
case corrupts the next in a way that reads as a product bug.

**Both attach paths are the same shape**, and the remote one (`ws/remote-subshell-ws.ts`)
was brought to it late; before that it fitted the pane to whoever attached
last and ran its own `tail_start` per socket, which `NodeLauncher`'s contract
forbids ("callers MUST NOT overlap per-subshell pumps"). Both now:

1. subscribe to the shared pump (`ws/pane-stream.ts`) BEFORE reading the pane,
2. fit to `sharedGridFor()`, seed the geometry queue with what they applied,
3. capture, send the replay, then `open()` the subscription and broadcast presence.

Step 1 before step 3 is the join-point rule as a subscription. It also means a
refusal AFTER the subscription must tear it down explicitly, or a tail keeps
running for a viewer that was never admitted.

**The `geometry` frame carries a CONFIRMED grid on both paths.** `paneSize()`
is the single question (`LocalLauncher` reads tmux directly, `RemoteLauncher`
asks the node with the `pane_size` command), and it answers a
real grid or `null`, never a guess. `resize` is a request, not a guarantee: a
client that believes it holds a size the pane never took paints every later
frame onto the wrong rows.

This is why it matters that the answer is real. With several viewers the pane
is the MINIMUM of what they can show, so a client left to size itself renders
more rows than the pane holds, and a client taller than its pane does not
scroll when the pane does, putting every later relative-positioned frame a row
out, which is the exact corruption this whole subsystem exists to prevent.

`null` means "could not be read", and nothing is announced. Usually that is the
pane being gone; a wedged-but-connected node reaches the same answer, which is
why `RemoteLauncher.paneSize` logs the failure at debug rather than swallowing
it; otherwise geometry announcements for that pane would stop with nothing in
the journal. (An earlier revision had no size command and a node pane announced
the size it had been ASKED for. That asymmetry is gone; do not reintroduce it.)

### Terminal attach diagnostics

A garbled live terminal is diagnosed from the journal first: two lines per
attach, both under `journalctl --user -u subshell-server.service | grep "ws attach"`:

- `geometry WxH build=<id> ua="…"`: the client's fitted size (`geometry
  MISSING` means a stale bundle that predates the feature), **which bundle**
  is talking, and which client sent it. `build` is the frontend's own asset
  hash (`apps/server/web/src/lib/build-id.ts`): it CHANGES when the client
  reloads new code and stays the same when it does not, so "the PWA is still
  running pre-fix JavaScript" is visible instead of being mistaken for a
  server bug; static requests are not logged, so this is the only signal.
  `build=MISSING` is a bundle older than the field; `build=dev` is a dev
  server.
- `painted repainted=<bool> nudged=<bool> replay=<n>B dump=<dir|off>`: what
  the pane did before the capture.
  `repainted=false nudged=true` means the geometry CHANGED and the pane
  refused to repaint even for a forced SIGWINCH, so a bad replay is the
  pane's own state; `repainted=true` means a freshly painted frame was
  shipped and anything still wrong is downstream of the capture;
  `repainted=false nudged=false` means the attach provoked NOTHING on
  purpose: a same-size reopen (nothing re-wrapped, nothing to correct), or
  the booting fast path (no settled frame at the join), or a pane-poll
  attach, which has no log to read a repaint burst from and is therefore
  never nudged blind. A winch-redrawing prompt
  (powerlevel10k, ble.sh) writes an orphan prompt line into its own history
  for every geometry event AFTER its first paint, so provocation is now
  reserved for resizes that actually change the grid.

`SUBSHELL_ATTACH_DEBUG=1` additionally dumps
`/tmp/subshell-attach-debug/<subshell>/<timestamp>/{pre-resize,replay}.txt`, the
grid as the viewer found it vs. the exact bytes sent. **Off by default: the
dumps are real screen contents, which can include secrets.**

Three invariants on that path are load-bearing and easy to regress:

- Capture text (`replay`, pane-poll deltas) goes through
  `ws/capture-text.ts`; `capture-pane -p` emits **bare LFs**, and a bare LF
  keeps the cursor's column, which staircases every row into scrollback where
  nothing ever repaints it. The live tail must NOT be normalized: those bare
  LFs are the app's own deliberate output.
- The attach streams **gap-free**: a skipped byte desynchronizes a
  diff-rendering TUI permanently. The tail therefore joins at a PRE-RESIZE
  log offset, so the replayed capture and the first streamed bytes **overlap**.
  That overlap is not free: it is *not* idempotent for a relative-positioned
  renderer (Ink replays move the cursor up and rewrite, so re-applying
  pre-snapshot frames over a fresh capture can corrupt it), so this is
  deliberate damage control: a visible transient beats a permanent desync,
  and a skipped byte is permanent.
  A zero-overlap "quiet join" (`size → capture → cursor → size` until the log
  stops growing, then restore the pane's cursor with a CUP) was tried in
  `9190c2f` and **rolled back on 2026-09-04** as part of returning this path
  to its last known-working state. If it is attempted again, note what the
  rollback preserved: the replay now ends at the BOTTOM of the grid, and
  `scripts/probe-clamp.ts` compares xterm against a real tmux pane
  token-by-token from a given cursor row; run it before trusting a mid-screen
  cursor restore.
- The replay frame carries **no trailing line terminator**
  (`ws/capture-text.ts:captureToReplayText`). `capture-pane -p` terminates
  every row including the last, and that final terminator scrolls the client
  one row past the pane's grid (measured on real xterm 6: `baseY` 1 vs 0),
  which shifts the whole viewport and makes the pane's viewport-relative
  cursor name the wrong row. Every later relative-positioned frame then lands
  on the wrong rows: the long-running "reopen a subshell and it is garbled"
  report. Verify with `apps/server/web/scripts/probe-replay.ts`.
  `captureToReplayText` takes the pane's cursor and appends an absolute CUP,
  so the replay ENDS where the pane is, not at the bottom of the grid. Both
  attach paths read it via `readPaneCursor` (remote: the `pane_cursor`
  command, protocol 13; a null cursor ships the replay without the restore,
  the pre-13 behavior, degraded only for a cursor near the top). Without the
  restore every live byte after a replay painted below the visible prompt,
  off by whatever sat between the pane's cursor row and the bottom of the
  grid (up to a full screen), the 2026-09-23 "prompt at the top, typing
  off-screen" report.

## Node presence is an announcement too (moved from AGENTS.md "Architecture")

**A node's reachability is an announcement too.** `nodeOffline` is a field of
every broadcast row and it flips for every subshell on a machine the moment
its socket drops; but no write touches those rows, so an event-driven feed
has nothing to send. The SSE stream this replaced hid that by re-sending the
whole list on a timer. `services/nodes/node-presence-announce.ts` publishes
`subshell.changed` for the RUNNING rows on a node when it connects, when it
disconnects, and when a refused agent is held; without it an agent that simply
dies leaves its subshells rendering as healthy until the viewer reconnects.
