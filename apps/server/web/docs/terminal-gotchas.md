# Terminal gotchas: dockview, touch, swipe, shared grids

Deep dive for `apps/server/web`, moved verbatim out of `AGENTS.md`.
This file carries the full history behind the summary; the routing line in
`AGENTS.md` names when to read it. The one cross-cutting rule (every panel
keeps `renderer: "always"`) stays in `AGENTS.md`.

### Upgrading `dockview-react`

dockview must **not** remount a panel's content when panels are moved or split.
The last known-good version is 8.2.0, verified by hand, and nothing automated
covers the promise. After any `dockview-react` upgrade, re-run the probe:

1. Open a workspace with two or more panes and open DevTools → Network → WS.
2. Drag a pane onto another pane's edge to split, and drag a tab between groups.
3. **No new `/ws` connection may appear, and no existing one may close.**

If one does, the upgrade is not safe: pin back to the last known-good version.

### Touch: tap types, swipe reads, and BOTH halves are ours

`lib/terminal-touch-scroll.ts`'s `gateTouchKeyboard` decides whether a touch
on the pane raises the soft keyboard, in both directions, because xterm
decides neither on a touch device. It has shipped broken each way:

- **2026-09-04: every touch raised it.** Swipes and scrollbar drags popped the
  keyboard over half the pane. Those touches are un-focused.
- **2026-09-18: nothing raised it.** xterm focuses its helper textarea only
  from `mousedown`, and xterm 6's `Gesture` registers `.xterm-screen` as a
  target and `preventDefault()`s the `touchstart` it dispatches gestures for,
  which suppresses the compatibility mouse events in both WebKit and Blink. So
  no `mousedown` ever reaches the grid and `document.activeElement` stayed at
  `body`. The gate now focuses the terminal itself from `touchend`, inside the
  user-gesture turn, for a one-finger tap only.

Two measured facts about the xterm 6 DOM that this code depends on, and that
an upgrade should re-check (`e2e/tests/09-mobile-touch-focus.spec.ts` covers
the contract; the classification is unit-tested):

- **The scrollbar is NOT `.xterm-viewport` any more.** That element is still
  in the DOM at the full terminal size, but it paints under
  `.xterm-scrollable-element`, its sibling, which holds the grid. The strip a
  finger lands on is a `.xterm-slider` inside `div.xterm-visible
  .xterm-scrollbar.xterm-vertical`. The gate matches both selectors; on the
  6.1 DOM only the second fires. (`attachWheelScroll` still tests
  `.xterm-viewport` alone for "this is xterm's own scrollbar, leave the wheel
  native"; on this DOM that check never fires, which costs nothing today
  because the fallback also scrolls the buffer. Fix it together with the next
  version bump.)
- **A flick's momentum frames carry no coordinates.** `Gesture._inertia`
  builds its `-xterm-gesturechange` event with only `translationX/Y`, so a
  pane with mouse reporting on gets `ESC[<65;NaN;NaNM` (measured, 45 frames
  from one flick, typed into the harness prompt). `lib/terminal-input.ts`
  drops SGR reports whose parameters are not decimals, on the one path xterm's
  own output becomes pane input (`use-subshell-ws.ts`'s `onData`); well-formed
  reports still flow, so swipe-scrolling inside a mouse-reporting program
  works. It is a deliberate copy of `apps/client/mobile/src/lib/terminal-input.ts`:
  the two UI surfaces run the same xterm and hit the same upstream defect.

### Swipe navigation

`useSwipeNav` publishes `data-swipe-nav="ready"|"idle"` on the zone it binds
to, from the same effect that governs binding. It exists for the e2e suite,
whose difficulty with this feature was that nothing observable said when a
swipe could work: the gesture is only bound once the subshell LIST has loaded
and neighbours exist, the terminal mounts well before that, and a swipe
dispatched in between is silently a no-op: the page just does not move, with
no error anywhere. Waiting on `.xterm`, and later on the list response, both
still raced (a response arriving is not the app having rendered from it).
Anything driving a swipe should wait for this attribute; it is the fact
itself rather than a proxy for it.

**Touch-only is enforced in the handler, not the config** (2026-09-25 desktop
report: dragging a text selection across the terminal jumped between
subshells). `pointer: { touch: true }` only binds TOUCH events on browsers that
support touch events; a plain desktop falls through to POINTER events, where
the engine's only start filter is the button count and a left-drag's `buttons`
is 1, the same as one finger. So the recognizer latches the first event and
ignores the rest of the gesture unless it is shaped like a finger: a TouchEvent
(the `touches` discriminator, since it carries no `pointerType` to name) or a
PointerEvent naming `touch`. Mouse, pen, and plain MouseEvents are refused. The
end-of-gesture `getSelection()` guard cannot catch a mouse inside xterm: the
terminal paints its own selection, so the DOM never has one.

### Several devices, one pane

A tmux pane has ONE grid, so every attached viewer constrains it. The rule
itself lives in `@internal/subshell-protocol` (`shared-geometry.ts`) so the
server can APPLY it and the browser can EXPLAIN it from one definition:
smallest visible viewer wins, hidden viewers drop out, a pin overrides both.
`decideSharedGrid` returns the grid plus the viewer ids holding each axis;
`describeDevices` (also in the protocol package, beside the rule it explains; the phone needs it too) turns that into the rows `<SubshellDevices>` renders:
in the subshell header, and floated over a workspace pane's top-right corner
(dockview owns that panel's frame, and a row of our own would cost every pane
vertical space for a control that is absent whenever one device is attached).

Whether the viewer may CHANGE the sizing is read off the presence frame's own
`canInput`, never passed in: a workspace pane has no access field to hand, and
any caller-side copy can disagree with the server that enforces it.

Two traps on this path, both invisible with a single viewer and both hit for
real (2026-09-04):

- **Do not report `term.cols`/`term.rows` as this client's size.** The
  container is pinned to the grid the server announced, so the terminal's own
  grid is an ECHO of the server's answer. Sending it back makes this viewer
  claim it can show no more than the smallest one, after which the pane never
  grows back when that viewer leaves. The client's only size statement is
  `measureCapacity()`, measured from the OUTER (pane) box.
  A null measurement is NOT a fallback to the terminal's grid either: it
  means "could not measure right now" (a sash mid-drag), and answering it with
  `term.cols` is the same echo by another route. A pinning caller stays SILENT
  until it can measure; the next observer tick reports the real number.
- **`&device=` on the attach URL is load-bearing.** Without it every row of
  everyone's Devices list reads "Unnamed device" and the list explains
  nothing. `lib/device-name.ts` derives it from the User-Agent and honours a
  per-device localStorage override. `&hidden=` rides the URL for a different
  reason: the on-open `visibility` frame races the server's attach and is
  dropped when it wins, and nothing re-sends it until the tab is shown.
- **Decide the letterbox font from the size the user CHOSE, never from the
  one this function last left behind.** Testing overflow against an
  already-shrunken cell says "it fits", which is only true because it was
  shrunk, so the font flapped between the two on alternate frames. And cell
  metrics read back immediately after assigning `options.fontSize` may be
  stale, so anything that changes the font re-runs on the next frame
  (`applyLetterboxSettled`).
