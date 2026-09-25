# Text size: the full mechanics

Moved from `apps/client/desktop/AGENTS.md`, which keeps the operational
summary and routes here. The text below is verbatim.

## Text size is Rust's, not the page's

⌘+ / ⌘− / ⌘0 (View, on macOS), the same three **Ctrl** chords as WINDOW
accelerators (on Linux, BOTH windows, node assistant and plane alike; the
menu bar is macOS-only by design and the tray submenu was otherwise the only
door, no door where no tray host answers), and the tray's **Text Size**
submenu walk a fixed ladder (`0.8 · 0.9 · 1.0 · 1.1 · 1.25 · 1.5 · 1.75 ·
2.0`), stored as `zoom` in this app's own `settings.json` and applied with
`WebviewWindow::set_zoom`. The ladder, the clamp, the frame arithmetic and
the keyval→rung decision are `desktop-core`'s `zoom` module; `src/zoom.rs`
here is the level, the menu ids, the apply, and the Linux attach. The
accelerator route also honors this app's plane-window rule exactly: it adds
no command to a page it has never granted one.

**Tauri's own `zoom_hotkeys_enabled` was rejected, and the reason is the trust
boundary.** On macOS and Linux it injects a page script that invokes
`plugin:webview|set_webview_zoom`, so it works only on a window granted that
command, and this app's `main` window is granted exactly one, which opens a browser rather than resizing anything, since a control plane's origin cannot be enumerated ahead of time and the grant there has to stay argument-narrow. It also keeps its level in a page-local variable, which a
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
