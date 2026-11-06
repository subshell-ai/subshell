# Virtual display toggle on a live subshell

Date: 2026-11-06
Status: approved in chat (owner chose the apply model; the calls below are recorded)

## Intent and the why

A subshell gets its virtual display at launch, and that's the only moment it can
get one. Someone mid-task who decides they want a screen for a browser or GUI app
has to close the subshell and create a new one. This makes the display a
**toggle on the live subshell**, available from the "Open web preview or screen"
dialog whenever the node allows virtual displays: turn it on when you need the
screen, turn it off when you don't, without losing the session row, its log, or
(hopefully) its conversation.

## Why "on" restarts and "off" doesn't

The pane's environment is baked at spawn. The harness starts inside an
`env -i` string built by the node before tmux runs it, so `DISPLAY` and
`XAUTHORITY` (Linux) or `SUBSHELL_DISPLAY_UUID` and `SUBSHELL_DISPLAY_NAME`
(macOS) are fixed for the life of the process; a running process can't be handed
a new one. That decides the asymmetry:

- **Turning on** persists the wanted screen onto the subshell row and applies it
  with the **existing in-place restart**: same row and id, log retained, and
  harnesses that support `resume` continue the conversation. The fresh process
  spawns with the display env present, allocated exactly the way launch does,
  through the same gates and in the same order.
- **Turning off** tears the display down immediately and leaves the pane
  running, because freeing the memory and CPU is the point of switching it off,
  and nothing about the pane's environment needs to change. The wart is named
  honestly in the docs: processes that were already running keep a `DISPLAY`
  that now points at nothing until the pane next restarts. Turning back on
  heals it, because turning on restarts.

The owner picked this model over "both flips restart" and over a per-pane
pre-allocated display slot (bake `DISPLAY` at launch for every pane on a
display-enabled node, start and stop Xvfb behind it). The slot idea is
Linux-only, changes what every pane carries from birth, and is parked, not
rejected: nothing here forecloses it.

No resize. Changing a screen's size or provider means toggling off and on, and
the on dialog asks again. Nothing in this spec mutates a live display.

## The desired-state model

`subshells.screen_config` stops being creation input that merely "saves the
provider and display size for restarts" and becomes the row's **desired screen
state**. Restart already treats it that way (`#screenForRestart` re-reads and
re-validates the stored config before stopping the pane); this feature adds the
first and only post-creation writers of the column:

- toggle on: write the validated, provider-pinned request, then restart,
- toggle off: clear the column, then close the display on the node.

Desired state is always written first and applied second, on both flips, so a
crash between the steps leaves the row's intent correct even if the node
hasn't caught up: an interrupted on reallocates at the next restart, and an
interrupted off leaves a display that a repeated off (always the same idempotent
route) closes, rather than one that a later restart brings back.

That ordering is what keeps every other consumer honest for free: the auto-
restart sweep, a manual restart for any other reason, and the clone dialog all
read the same column, so a toggled-off display never silently comes back and a
toggled-on one survives an unrelated restart.

## Protocol and node side

One new signed plane-to-node command, `preview_display_close { subshellId }`,
defined beside its siblings in `packages/subshell-protocol/src/node-frames.ts`
with its parser, and `NODE_PROTOCOL_VERSION` bumps (26 at design time; the
version is an exact-match gate and the fleet ships together). The answer
reports whether a display was actually there, which the UI uses to tell "closed
it" from "there wasn't one".

The node handler joins the switch in `apps/node/agent/src/commands/index.ts`
and calls `ctx.previewDisplays.closeFor(subshellId)`, which is already per-pane
serialized and idempotent. Deliberately, close carries **no** feature-switch or
provider-set gate: turning the node switch off is documented not to stop
existing displays, so an explicit user act must be able to stop one anyway, and
teardown can't be refused for policy reasons without stranding resources. The
`local` built-in node reaches the same `PreviewDisplays` instance directly,
mirroring how `LocalLauncher` opens one.

Two provider facts the design leans on and a test must pin: `closeFor` removes
the provider's on-disk state (lockfile, `display.json`, the per-pane dir), so
the boot/hourly orphan sweep cannot rehydrate a display the user closed on
purpose; and the pane's own processes are killed by the display's disappearance
only in the sense that their X connection breaks, exactly like today's
`screenLost` mid-pane loss, which the viewer surfaces the same way.

## Plane state

The off-path feeds the preview broker's existing `onDisplayClosed` (the audit
event `node.preview_display.close` already exists), and the batched liveness
probe keeps `/views`, `screenLost`, the header indicator, and the sidebar
preview entries correct without new plumbing. The on-path needs none at all:
the restart's ordinary launch ack already feeds `onDisplayOpened`.

## API

Two routes in the `src/api/subshells/` one-file-per-endpoint style, gated
exactly like `POST /:id/restart` (owner or edit-shared; bearer actors per the
restart route's rules; a foreign row is 404, not 403):

- `PUT /api/subshells/:id/screen`, body `{ width, height, provider? }`
  (the existing `VirtualDisplayRequestSchema`, 320-4096 ints): resolve through
  `resolveNodeDisplayRequest` (node switch, enabled provider set, OS fit, pin
  the default), persist `screen_config`, then run the existing restart. A
  refusal leaves the row unchanged.
- `DELETE /api/subshells/:id/screen`: clear the column, then send
  `preview_display_close`. Idempotent: closing a pane with no display succeeds,
  and a repeated call after a mid-flight failure still converges.

Both flips **refuse while the node is offline**: on because the restart would
refuse anyway, off because the display can't be reached, and clearing the
column alone would strand a live Xvfb/x11vnc pair (or a BetterDisplay screen)
whose desired state now contradicts it. The refusal message says so and links
nothing exotic: bring the node back and flip again.

Every visible write publishes `subshell.changed` the way the restart path does.

## MCP

One new tool, `set_subshell_display { subshell_id, screen | null }`, schemas in
`packages/mcp-core/src/view-tools.ts` reusing `ScreenSchema`, registered beside
its siblings. `null` is off, a request is on; the description carries the
consequences, including the self-target one: enabling the display of the pane
you're running in restarts that pane, and the tool call dies with its process,
the same hazard `restart_subshell` already documents. This exists because the
strongest workflow is the agent asking for a screen mid-task instead of asking a
human to recreate the subshell.

`open_subshell_view` with `kind: "screen"` keeps its refusal for a pane without
a display, but the copy points at the fix ("turn on its virtual display")
instead of only at launch.

## UI

The change lives in `preview-chooser-dialog.tsx` (the "Open web preview or
screen" picker): a **Virtual display** row.

- **Off state:** a toggle with the same size and provider controls as the
  launch form, reusing `virtual-display-field.tsx` and
  `use-node-display-readiness`, so unavailable providers explain themselves the
  way they already do at launch. Default size 1280x800, provider defaults to
  the node default.
- **On state:** the row shows the screen entry that opening a display already
  produces, plus the toggle to turn it off.
- Both flips confirm at the decision point with short fixed titles, "Enable
  virtual display?" and "Turn off virtual display?". The enable body says the
  subshell's processes restart and warns about a resume-less harness; the
  disable body says what's drawn on the screen closes and resources are freed.
- View-only access renders the toggle disabled with the usual tooltip naming
  the edit access it wants; the node-switch-off case keeps the picker's
  existing explanation and setup link.

No new header affordance: `virtual-display-indicator.tsx` and the preview tab
already follow `screen` on `/views`, so they react to both flips as soon as the
row updates.

## Docs

`/previews/setup`, `/previews/linux`, `/previews/macos`, and `/mcp/tools`: the
toggle procedure and its consequences, the stale-`DISPLAY`-after-off note, the
"changing size means off then on" line, and the new tool. The setup page's
"Each subshell saves its provider and display size for restarts" paragraph
grows the desired-state framing rather than being replaced.

## Test coverage

- **API routes:** edit-gate parity with restart, foreign row 404, node-offline
  refusal on both flips, policy refusals (node switch off, provider disabled,
  bad dimensions) leaving `screen_config` and the pane untouched, off clearing
  config and being idempotent with no display, and a refusal path that proves
  the column is written only after the request validates. The composed-route
  suite already rejects anonymous and node-key callers on guarded routes; no
  duplicate bare-401 cases here.
- **Protocol:** round-trip parser for `preview_display_close`, its result
  grammar, and the version pin.
- **Node:** the handler closes an allocated display, answers honestly for a
  pane that has none, works while the switch mirror is off, and a provider
  test pins that a closed display isn't rehydrated by `sweepOrphans`.
- **MCP:** schema reuse and the refusal-copy change only where behavior (not
  prose) is owned.
- **SPA:** chooser-dialog states (on/off, provider readiness, node switch off,
  view-only), the two confirmation dialogs' existence and copy contract, and
  the invalidation path that refetches `/views` after each flip.
- **E2E:** extend the existing preview/display specs to flip both ways on the
  Xvfb path if the harness already runs one; otherwise the node-side provider
  tests carry it.

## Review focus

- Toggle on, then a plain restart for another reason: the display must come
  back on its own, since restart reads the desired state.
- Toggle off, then the auto-restart sweep fires: the revived pane must launch
  with no display (the clear lands before anything else can read the column).
- Toggle off while GUI apps are drawing: their X connections break like a
  `screenLost`, and the terminal keeps running.
- Toggle on a pane whose harness can't resume: the confirmation is the only
  thing standing between the user and a lost conversation; it must be
  unskippable.
- Rapid off-then-on: the node's per-pane queue serializes them; the on restart
  must not race a half-closed display, and the ack must carry a freshly
  allocated descriptor, never a stale viewer port.
- A shared-with-`edit` viewer toggling on someone else's pane: allowed, audited
  like every other edit-tier act, and the owner's sidebar reflects it live.
