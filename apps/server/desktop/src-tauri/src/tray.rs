//! The system tray.
//!
//! Honest about Linux: `TrayIconEvent` is never emitted there (Tauri's own
//! docs: "Unsupported. The event is not emitted even though the icon is shown
//! and will still show a context menu on right click"), and whether the icon
//! is DRAWN at all depends on a StatusNotifier host being registered on the
//! session bus — KDE has one, a stock GNOME does not. Where none is, the icon
//! is SILENTLY INVISIBLE, with no error and no event. Two rules follow, and
//! both are load-bearing:
//!
//! - Every tray action also exists in the window UI or the menu bar. The tray
//!   is a shortcut, never the only route to anything.
//! - `close_to_tray` DEFAULTS ON (2026-09-07), and both the setter and the
//!   window-close handler gate on `subshell_desktop_core::tray`'s PROBE of that
//!   bus rather than on the platform — so a KDE user gets the feature and a
//!   stock GNOME user cannot hide a window into an icon nothing renders: the
//!   clamp, not the default, is what makes the ON default safe.
//!   `single-instance`
//!   — relaunching — is the only way back from that, which is why the check is
//!   re-run at the moment of hiding.
//!
//! A `Menu` is attached even where nothing needs one: on some Linux
//! implementations an icon with no menu may not register at all.
//!
//! **macOS has its own silently-invisible mode, and it is not ours to fix.**
//! Measured on a notched MacBook Pro running macOS 26.6.2: every newly created
//! `NSStatusItem` is allocated with its right edge at logical x≈847, which is
//! INSIDE the notch (`NSScreen.auxiliaryTopRightArea` starts at 848), and grows
//! leftward — never into the free right-hand area, ~179pt of which macOS was
//! holding while drawing nothing. AppKit reports the item perfectly healthy the
//! whole time: `isVisible == true`, `alphaValue == 1.0`, window level 25,
//! occlusion "visible". A 25-line pure Swift/AppKit program with no Tauri and
//! no `tray-icon` reproduces it exactly, so nothing in this repo, in Tauri, or
//! in `tray-icon` is implicated. Restarting ControlCenter or the session is the
//! remedy.
//!
//! The lesson that IS ours: **`build()` returning `Ok` and `tray_by_id()`
//! returning `Some` are not evidence the icon is on screen** — both were true
//! throughout, on both platforms, which is exactly why this looked like a
//! silent code failure for so long. Do not build a health check on either.
//! The only usable macOS check would compare `TrayIcon::rect()` against
//! `auxiliaryTopRightArea`; there is none today, so this app cannot warn.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::bridge::{dispatch, DesktopAction};

/// The tray items whose usefulness depends on a RUNNING server, held so their
/// enabled state can follow it.
///
/// Both of these need the server's own SPA, which does not exist until the
/// server answers on its port. They used to be permanently enabled and to fall
/// back to opening the console — so with no server every item in the menu did
/// the same thing, and the menu offered two ways to reach a window it never
/// named. Disabling them is what makes the menu describe what is actually
/// available.
pub struct ServerDependentItems {
    /// "Open Dashboard" — the server's own SPA.
    open: MenuItem<Wry>,
    /// "New Subshell…" — dispatched INTO that SPA, so it needs it too.
    new_subshell: MenuItem<Wry>,
}

/// Enable or disable the tray items that need a running server.
///
/// Driven by `desktop_probe`, which every console refresh and every console
/// action already runs — including the one at startup, since `setup` opens the
/// console and its first render probes. So the tray settles within a moment of
/// launch and tracks every transition the console causes.
///
/// A server that dies from OUTSIDE this app (killed by hand, crashed) leaves
/// the items enabled until the next probe. That is a known staleness rather
/// than a silent one: clicking then re-probes and reports the real error.
pub fn set_server_ready(app: &AppHandle, ready: bool) {
    if let Some(items) = app.try_state::<ServerDependentItems>() {
        let _ = items.open.set_enabled(ready);
        let _ = items.new_subshell.set_enabled(ready);
    }
}

/// Build the tray icon. Failure is not fatal — an app without a tray still works.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    // Both start DISABLED: at build time nothing has probed yet, and claiming
    // the SPA is reachable before knowing is the failure being fixed. The
    // console's first render enables them if the server is already up.
    let open = MenuItem::with_id(app, "tray:open", "Open Dashboard", false, None::<&str>)?;
    let console = MenuItem::with_id(app, "console", "Manage server…", true, None::<&str>)?;
    let new_subshell = MenuItem::with_id(
        app,
        DesktopAction::NewSubshell.id(),
        "New Subshell…",
        false,
        None::<&str>,
    )?;
    app.manage(ServerDependentItems {
        open: open.clone(),
        new_subshell: new_subshell.clone(),
    });
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &new_subshell,
            &PredefinedMenuItem::separator(app)?,
            &console,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    TrayIconBuilder::with_id("subshell")
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            tauri::Error::InvalidIcon(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no default window icon",
            ))
        })?)
        // NOT a template. A macOS template icon is drawn from the ALPHA
        // CHANNEL alone — the system discards every colour and fills the
        // silhouette to match the menu bar. That is the right convention for a
        // single app, and it was what this called for; but the whole point of
        // the two apps' icons is that their BACKGROUNDS differ, and under a
        // template both collapse to the same filled rounded square. The
        // shipped asset is a rounded tile at 96% opacity, so a template was
        // already rendering as a solid blob rather than the `/s` mark.
        //
        // The cost is that a coloured icon does not adapt to a light or dark
        // menu bar. The tile is a dark plate with a light glyph, which reads on
        // both, and telling two menu-bar items apart beats matching them.
        .icon_as_template(false)
        .tooltip("Subshell Server")
        .menu(&menu)
        // macOS/Windows only; on Linux this is inert and the menu is the whole
        // interaction, which is why nothing here depends on a click.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            // LEFT button, on RELEASE. `Click` fires for every button, so
            // matching it wholesale means a right-click both opens the menu
            // and un-hides the window the user just closed to the tray.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        // Only reachable while ENABLED, i.e. while a probe said the server is
        // ready — so this opens the SPA rather than substituting the console.
        "tray:open" => open_dashboard(app),
        "console" => {
            let _ = crate::windows::open_console(app);
        }
        _ => {
            if let Some(action) = DesktopAction::from_id(id) {
                // Same gate: enabled means the SPA is reachable. Opening it
                // first is what makes the action land somewhere.
                open_dashboard(app);
                if app.get_webview_window("main").is_some() {
                    dispatch(app, action);
                }
            }
        }
    }
}

/// Focus the SPA window, creating it if this is the first time.
///
/// Creating it needs the server's own base URL, which only a probe knows, so
/// this re-probes rather than caching an origin that a `configure` could have
/// moved. A failure is reported to stderr and leaves the tray alone: the item
/// was enabled on the last probe's word, and a server that has since gone is
/// the console's story to tell, not a dialog's.
fn open_dashboard(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        crate::windows::raise(&w);
        return;
    }
    if let Err(err) = crate::control::open_main_now(app) {
        eprintln!("subshell: could not open the dashboard: {err}");
    }
}

/// Bring the app window back, or the console when there is no app window yet.
fn show_main(app: &AppHandle) {
    let window = app
        .get_webview_window("main")
        .or_else(|| app.get_webview_window("console"));
    if let Some(w) = window {
        crate::windows::raise(&w);
    } else {
        let _ = crate::windows::open_console(app);
    }
}
