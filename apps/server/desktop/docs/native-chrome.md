# Native chrome deep dive

Text size (the Rust zoom ladder), the menu/tray/title-bar surfaces and native
notifications: the "Text size is Rust's, not the page's" and "Native chrome"
sections, lifted verbatim from `apps/server/desktop/AGENTS.md`. Read this
before touching `menu.rs`, `tray.rs`, `zoom.rs`, the Edit-menu construction,
or the title-bar handshake.

## Text size is Rust's, not the page's

⌘+ / ⌘− / ⌘0 (View, on macOS), the same three **Ctrl** chords as WINDOW
accelerators (on Linux, see below), and the tray's **Text Size** submenu walk a
fixed ladder (`0.8 · 0.9 · 1.0 · 1.1 · 1.25 · 1.5 · 1.75 · 2.0`), stored as
`zoom` in this app's own `settings.json` and applied with
`WebviewWindow::set_zoom`. The ladder, the clamp, the frame arithmetic and the
keyval→rung decision are `desktop-core`'s `zoom` module; `src/zoom.rs` here is
the level, the menu ids, the apply, and the Linux attach.

**The Linux keys are window accelerators, not a menu, because Linux has no
menu bar by design.** Before them the tray submenu was the only zoom door
there, and where no tray host answers (the probe's "none was detected" case
the close-to-tray rule already respects), there was NO door at all. Reported
2026-09-24 from a real Ubuntu 26.04 session where the tray rendered and the
keys simply did nothing. `attach_accelerators`
runs at EVERY window-build site and routes through the same `handle`, so the
ladder and the save cannot gain a second implementation; the modifier half is
GTK's (its default accel mask discards Shift, so Ctrl+Shift+= matches too),
and the table it registers is pinned to the mapping by a `desktop-core` test.

**Tauri's own `zoom_hotkeys_enabled` was rejected, and the reason is the trust
boundary.** On macOS and Linux it injects a page script that invokes
`plugin:webview|set_webview_zoom`, so it works only on a window granted that
command. It also keeps its level in a page-local variable, which a
reload resets. `set_zoom` called from Rust touches no ACL at all.

**Both menus' items share one id set, and it is routed in exactly one place**:
`lib.rs`'s app-level `on_menu_event`, registered on every platform. A Tauri
menu event is GLOBAL: that handler receives the tray's items and the tray's
handler receives the menu bar's, so an id matched in both steps the ladder
twice per click. Measured on 2026-09-12 by clicking Bigger twice and landing on
1.75.

Three things follow, each with a failure that is invisible from reading the
diff:

- **The level is clamped on READ** (`clamp_zoom`), the way `close_to_tray` is.
  `settings.json` is a file a person can edit, and a `0` in it is a window
  nobody can read well enough to fix from inside the app. Clamping SNAPS onto
  the ladder, which is what lets a step always land on a rung.
- **The SPA's floor scales with the level.** The floor is a promise about the
  VIEWPORT and zoom is what divides physical pixels into CSS pixels, so at 150%
  an unscaled 360px window would lay out in 240 CSS pixels, narrower than
  anything the SPA is drawn for. Scaling it keeps the promise at every rung.
- **The assistant frame scales too, clamped to the work area.** It is fixed and
  non-resizable, so bigger text in an unchanged frame is just less room to say
  the same thing. The clamp is the same one `wizard_height` always was: a
  non-resizable window whose bottom edge is past the work area takes the bar
  carrying Continue with it. Content that overflows the frame is the safe case:
  the bar is its own row and the region above it scrolls.

**Linux has only the tray**, because a GTK menu bar is per-window chrome rather
than a system bar. Where the tray probe says no icon would be drawn, there is
no route to the text size at all; the fix if that ever bites is one row on the
bundled assistant page, which is the surface that can already invoke commands.

## Native chrome

| Surface | macOS | Linux |
| --- | --- | --- |
| Menu bar | full `NSMenu` | one item: the predefined **About** on the dashboard window (spec 2026-09-17 § 6); a GTK menu bar is per-window chrome, not a system bar, so it carries nothing else |
| Tray | icon + menu, click opens | icon + menu only; **click events are never emitted** |
| Title bar | Overlay, negotiated (below) | ordinary |
| Close to tray | offered, **default on** | offered where a tray is **detected**, default on; clamped off where none answers |

`PredefinedMenuItem::{cut,copy,paste,select_all}` come FIRST in the Edit menu
and are not decoration: without them ⌘C/⌘V do not work at all in a Tauri macOS
webview, because the shortcuts go to the menu bar and nothing claims them. In a
terminal app that is a correctness bug.

Close-to-tray is gated on a **capability probe, not on the platform**
(`crates/desktop-core/src/tray.rs`, shared with `apps/client/desktop`). On
Linux the icon is drawn only where a StatusNotifier **host** is registered on
the session bus (KDE has one, a stock GNOME does not until the AppIndicator
extension is installed), and where none is, the icon is **silently invisible**:
no error, no event, and a window hidden into it is unreachable. So the app
asks, by shelling out to `busctl --user get-property
org.kde.StatusNotifierWatcher /StatusNotifierWatcher
org.kde.StatusNotifierWatcher IsStatusNotifierHostRegistered` (`gdbus` as a
fallback where it happens to exist; never a dependency: webkit2gtk pulls
`libglib2.0-0t64`, not `libglib2.0-bin`). Every non-affirmative outcome (no
bus, no watcher, no tool, a timeout, an unrecognised answer) means "no tray".

Three consequences, all load-bearing:

- **The preference lives in the TRAY**, as a `CheckMenuItem` beside Open
  Subshell Server. It was a switch on the console's Application section, read
  through `desktop_settings` and written through `desktop_set_close_to_tray`;
  moving it RETIRED both commands rather than relocating them, which is the
  point: a preference about the tray belongs in the tray, and the page that
  held it is gone. The item is seeded from the CLAMPED value
  (`close_to_tray_now`), because a check mark promising a behaviour the app
  will not honour is a check mark that lies.
- **muda flips the item before the event fires** (measured against muda 0.19.3
  on both the macOS and the GTK backends), so `set_close_to_tray` READS
  `is_checked()` rather than toggling a stored copy: two places deciding what
  "checked" means is how a menu ends up disagreeing with itself. Turning it ON
  is refused where no StatusNotifier host answers, with the item put straight
  back; turning it OFF is always allowed, because that direction can only make
  the window easier to reach.
- **The tray no longer has a disabled item.** "Open Dashboard" was disabled
  until a probe said the server was ready, so on a broken machine the one
  thing on the tray could not be pressed. It is "Open Control Plane In App" now
  and always enabled, because `open_home` answers for both states of the machine,
  which also retired `set_server_ready` and the `DashboardItem` it held. A
  second in-app door, "Open Server App", sits beside it: it arms the assistant's
  standing **Status** screen through `reset::arm_and_raise(app, Some("status"))`
  and raises the bundled window (no probe and no server question, the client
  tray's "Open Client App" carried to this side). It must NOT be a bare
  `windows::open_assistant`: on a running server an un-armed assistant boots to
  the handoff, opens the dashboard, and `open_main_now` then CLOSES the window it
  just opened (the assistant's job ends at the dashboard), so the press flashes
  and vanishes. Arming the standing Status word lands it on a screen that stays.
  The `status` wire word round-trips through `parse_screen`→`Screen::Status`;
  `applyScreen` maps it to the same standing marker the rail's Status select
  uses, deliberately NOT to a requested screen (which would bounce).
- The window-close handler **re-probes**, and that is the check that actually
  protects the user: a host that has gone away since the setting was made means
  the window closes normally instead of vanishing. The probe is therefore
  deliberately **not memoized**: installing the extension flips the answer
  with the app already running.

It is a false NEGATIVE on the older XEmbed tray (some XFCE/MATE), where
libayatana-appindicator can still fall back to `GtkStatusIcon`; that is why
every string says "none was detected" rather than "there is none". And every
tray action also exists in the window UI or the menu bar regardless: the tray
is a shortcut, never the only route.

**Server Addresses is no longer a tray item** (2026-09-22 wave). It was a
near-exception to the rule above (a tray door whose only window route was the
recovery screen, which renders only while the server is not answering), so a
server that answers yet refuses every sign-in left the tray as the way in. That
reason is gone: the assistant's rail carries it as **Addresses**, and the tray's
"Open Server App" raises the assistant to that same rail on any onboarded
machine, answers-but-refuses included. The screen is still deliberately NOT
"Server Settings",
which is the View menu's ⌘4 into the SPA's session-gated routes (see the
Addresses screen, apps/server/desktop/docs/assistant.md).

### Notifications

The web path is VAPID push through a service worker, and
`apps/server/web/src/lib/notifications.ts` gates on `PushManager`, which neither
WKWebView nor WebKitGTK has. A tray-resident window with no way to say an agent
is waiting undercuts the point of a tray, so the desktop notifies natively off
the SSE feed the app is ALREADY reading: no server work, no VAPID keys, and one
`desktop_notify` command rather than granting the server-origin page the whole
notification plugin.

Edge-triggered, deliberately: `use-desktop-notifications.ts` holds the previous
waiting set and starts it `undefined`, so a subshell that was already waiting
when the window opened is not news. Without that, opening the app fires one
notification per idle agent.

### The title-bar negotiation

The main window is created HIDDEN with an ordinary title bar. The SPA's desktop
sidebar calls `desktop_shell_ready({overlay: true})` on mount; the shell then
switches to `TitleBarStyle::Overlay` and shows the window. A six-second
fallback shows it decorated regardless.

It is a handshake rather than a version check because the desktop chrome ships
inside the SERVER's embedded SPA, so a desktop build can meet an instance that
has never heard of it, and an old SPA under a chrome-less window is an
UNMOVABLE window. A version floor would have to be kept in step with a release
it cannot see; asking the page is a fact. An old SPA simply never answers.
