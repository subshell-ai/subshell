# Windows: the watch thread, raising and state

The 5-second origin watch and its three rules, the Linux raise mechanics, the
no-tuck rule and the window-state denylist: the "The watch thread" and
"Windows, and getting them in front" sections, lifted verbatim from
`apps/server/desktop/AGENTS.md`. Read this before touching `watch.rs`,
`windows.rs`, or the window-state/tray/bridge interactions.

## The watch thread

The console page ran a 5-second `desktop_probe` poll, and both the tray's
enabled state and the address the app knew hung off it. Deleting that page did
not delete the reason (the manager's whole subject is state this app does not
own), so the poll is `src-tauri/src/watch.rs` now: one thread, `probe_now`
every five seconds for the life of the app.

Its duty is the case the inventory found unhandled: **re-point `main` when the
server's origin moved.** A port changed from the SPA's Networking page (the
Addresses card, there since 2026-09-17; on Service before it) and a
restart later, the dashboard is a window fetching a dead port, and nothing was
watching for it. `origin_changed(current, probe)` is pure and tested; the
navigate goes through `windows::open_main`'s existing existing-window branch,
which also re-validates the origin against the two this app may point at and
recomputes the window's trust flag. It refreshes the configured base URL on
every tick as well (spec 2026-09-18 § 15): that address is the second trusted
origin, and an admin can move it without moving the port this function watches.

Three rules it keeps:

- **It skips while `control::ACTION_IN_FLIGHT` is held**, an `AtomicBool`
  behind the RAII `ActionGuard` that `desktop_setup`, `desktop_service`,
  `desktop_install_server`, `desktop_install_tmux` and `desktop_reset` take on
  their first line. A probe landing mid-chain reports a half state, and acting
  on it is worse than waiting five seconds. A guard rather than a set/clear
  pair because every one of those commands has early returns in it, and a flag
  left set stops the thread for the rest of the session, silently.
- **It skips entirely when there is no `main` window**, rather than paying CLI
  spawns for an answer nobody is waiting on. A machine sitting on the assistant
  runs that page's own poll.
- **It never raises the assistant.** A server that goes away while the
  dashboard is open shows the SPA's own offline banner; the person reaches
  recovery through the pill, the tray or the Dock. A thread that raised a
  window on its own would take the screen from whatever someone was doing, five
  seconds after a service restart they started themselves.

## Windows, and getting them in front

**`show` + `unminimize` + `set_focus` does not raise a window on Linux.** A
Wayland compositor refuses an activation request from a surface that is not
already active, so `set_focus` returns `Ok` and nothing moves. That is
invisible with one window and a bug the moment two exist, which is this app's
normal shape: the pill brought the bundled window back UNDERNEATH the
dashboard, so nothing appeared to happen. Every site goes through
`windows::raise`, which adds a momentary always-on-top on Linux, cleared from a
short-lived thread: a compositor that coalesces set-and-clear never raises at
all.

**Nothing tucks anything any more.** `tuck_console` minimized the console when
the dashboard appeared, because there was one manage window and raising either
retired the other. With two windows the assistant and the dashboard are both
legitimately open at once (a recovery screen beside a dashboard showing its
own offline banner is a real state), so `open_assistant` closes nothing, and
`open_main_now` still closes the assistant only because the assistant's own
job ends at the dashboard, by either door.

**The window-state plugin restores size and position for `main`, and tracks
the assistant NOT AT ALL** (`DENYLIST`). Measured on 2026-09-12: a state file
left by an older session restored 757x706 over the assistant's fixed 1024x720
frame, and it came up at that size on a machine whose server was merely
stopped. Latent until the assistant started opening on every not-ready boot
rather than on first run alone: a first-run machine has no saved state by
definition.

**That trap is worth stating for the next fixed-size window someone adds.** A
restored size is wrong TWICE for a frame like this: the layout is drawn to
that arithmetic, and `open_main` INHERITS the assistant's position and size so
the dashboard appears in its place, which would carry a stale size straight
into a window sized for a screen that is no longer there. Denylisting the
label is the fix rather than
dropping `StateFlags::SIZE`, because the dashboard's size IS worth
remembering and the assistant's is not a user choice at all: it is
non-resizable and centred.

**VISIBLE, MAXIMIZED and FULLSCREEN are never restored either**, and a newly
created dashboard clears the last two. `main` is created hidden on purpose and
shown by the title-bar handshake, so restoring visibility would show it
decorated before the page can ask for the overlay. A window maximized once
otherwise reopens maximized forever, and a compositor maximizing it on the
user's behalf is enough to latch that. Cleared on creation only, so maximizing
during a session still sticks for that session.

**The tray has no "New Subshell".** It dispatched an action INTO the SPA, so
being enabled needed more than a running server: a server with no users is
sitting on the setup wizard. Nothing this side can see distinguishes those
states: `status --json` carries no user state by design, `ShellReady` fires
from the SPA root on purpose, and there is no HTTP client here to ask
`/api/setup/status`. The tray is a shortcut and never the only route, so the
item is gone rather than gated. That leaves `menu.rs` as the only consumer of
`bridge.rs`, and since the menu bar that carries ACTIONS is macOS-only (the
Linux window bar added 2026-09-17 carries one PREDEFINED About item, which
muda's GTK backend answers in its own click handler and never routes an id),
`bridge` is gated at the MODULE (on Linux it is otherwise entirely dead
code).
