# The tray: route home, the close-to-tray check, the Control Plane submenu

Moved from `apps/client/desktop/AGENTS.md`, which keeps the operational
summary and routes here. The text below is verbatim.

## Route home (the tray is not one)

(Split from AGENTS.md's "Two windows"; it is tray mechanics.)

**It must always have a route home, and the tray is not one.** The plane window
is remote content whose one grant opens a browser, so it cannot offer a way
back into this app, and a tray
icon is silently invisible wherever no StatusNotifier host is registered. So:
macOS gets **Window → Open Client App** in the menu bar (always drawn, which also
covers the notched-display hazard in `tray.rs`); everywhere else,
`node_window_has_a_route_home()` asks `desktop-core`'s tray probe and, when the
answer is no, `focus_any` RE-CREATES the node window, so relaunching, which is
what `tray.rs` calls the way back from an invisible tray, actually is one.
`open_at_startup` no longer consults that probe, and does not need to: it opens
the node window on every desktop, which is strictly more than the check ever
bought. `focus_any` is the path where that window can genuinely be GONE, so the
probe survives exactly there.

## The tray preference is in the tray

`close_to_tray` is a `CheckMenuItem` in the tray menu, and `node_settings` no
longer carries it. The preference is ABOUT the tray, so it belongs there, and
putting it there REMOVED two commands (`node_set_close_to_tray` and the
settings payload's tray trio) rather than moving them to a screen that now asks
one question at a time.

Two properties, neither re-derived here: muda flips the item's own state BEFORE
the menu event fires, so the handler reads the item rather than toggling a
stored copy (two places deciding what "checked" means is how a menu disagrees
with itself), and `is_checked()` from a menu handler does not deadlock. Both
were measured against muda 0.19.3 on the macOS and GTK backends by
`apps/server/desktop`'s own check item.

**The clamp is what makes the ON default safe**, and it survives the move
intact: `close_to_tray_now` is what the check item seeds from and what the
window-close handler reads, so a desktop with no StatusNotifier host cannot
hide a window into an icon nothing draws. The item shows the CLAMPED value,
because a check mark claiming behaviour the app will not honour is a check mark
that lies.

## The tray's Control Plane submenu

The plane-list ruling (operator, 2026-09-22) reached the tray the same day: the
flat "Open Subshell Client / Open in Browser" pair stopped being honest the
moment the list could hold more than one plane, because neither item said
WHICH. The tray now mirrors the Control Plane section:

- **Control Plane ▸ Open Last / separator / `<address>` ▸ Open in App | Open in
  Browser**: one submenu per address, the node's own connected address FIRST
  (the page's pinned-row rule, same live read: `config.json`, never a probe),
  the stored list behind it, deduped by exact canonical match.
- **The ids carry the canonical URL as data** (`tray:plane-app:<url>`), so a
  click acts on exactly the address the person read, and both arms
  RE-VALIDATE before acting: an id string is data, never a trusted URL.
- **"Open Last" replays the last deliberate open, URL AND door** (app window
  or system browser), remembered in settings (`lastPlaneOpen`) by every
  opener's success path: `windows::open_plane` for the app door, both
  browser arms for the other. Greyed until the first open; reset clears it
  with the list.
- **The menu is rebuilt from live state** (`tray_menu`), and `tray::refresh`
  re-runs exactly that and swaps it in. It is called on every mutation the
  submenu reflects (plane add/remove, enroll, un-enroll, reset), and NOT
  from inside the tray's own menu handler (replacing a menu from within its
  event handler is a re-entrancy question this app does not answer; opens
  FROM the tray record but do not repaint).
- The tray drives no CLI, and nothing here changed that: the two plane arms
  open a window and hand a URL to the opener, that is all.

`Open Client App` (was "This machine…", same ruling: the label is the verb) is
the one window item and reaches the bundled node page, which no plane row can.
