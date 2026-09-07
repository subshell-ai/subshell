//! The system tray.
//!
//! Honest about Linux: `TrayIconEvent` is never emitted there (Tauri's own
//! docs: "Unsupported. The event is not emitted even though the icon is shown
//! and will still show a context menu on right click"), and whether the icon
//! is DRAWN at all depends on a StatusNotifier host being registered on the
//! session bus — KDE has one, a stock GNOME does not. Where none is, the icon
//! is SILENTLY INVISIBLE, with no error and no event. Three rules follow, and
//! all three are load-bearing:
//!
//! - Every tray action also exists in the window UI or the menu bar. The tray
//!   is a shortcut, never the only route to anything — which is why this menu
//!   is two items and neither of them drives the CLI.
//! - `close_to_tray` defaults OFF, and both the setter and the window-close
//!   handler gate on `subshell_desktop_core::tray`'s PROBE of that bus rather
//!   than on the platform — so a KDE user gets the feature and a stock GNOME
//!   user cannot hide a window into an icon nothing renders. `single-instance`
//!   — relaunching — is the only way back from that, which is why the check is
//!   re-run at the moment of hiding.
//! - A `Menu` is attached even though nothing here needs one: on some Linux
//!   implementations an icon with no menu may not register at all.
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
use tauri::AppHandle;

/// The tray icon's id.
///
/// Explicit, and distinct from `apps/server/desktop`'s `subshell`: the two apps
/// can be installed side by side, and an id is how anything later (a
/// `tray_by_id` lookup, a tooltip update) addresses this icon rather than the
/// other app's.
const TRAY_ID: &str = "subshell-node";

/// The menu id for "show the window". Namespaced so it can never collide with
/// a predefined item's id.
const OPEN_ID: &str = "tray:open";

/// Build the tray icon. Failure is not fatal — an app without a tray still works.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, OPEN_ID, "Open Subshell Client", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    TrayIconBuilder::with_id(TRAY_ID)
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
        .tooltip("Subshell Client")
        .menu(&menu)
        // macOS/Windows only; on Linux this is inert and the menu is the whole
        // interaction, which is why nothing here depends on a click.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id.as_ref() == OPEN_ID {
                crate::windows::focus_main(app);
            }
        })
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
                crate::windows::focus_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Two apps, one tray. An id shared with `apps/server/desktop` would make
    // `tray_by_id` ambiguous the first time either app grows one.
    #[test]
    fn the_tray_id_is_this_apps_own() {
        assert_eq!(TRAY_ID, "subshell-node");
        assert_ne!(TRAY_ID, "subshell");
    }

    // Namespaced so it cannot collide with a predefined item's id.
    #[test]
    fn the_menu_id_is_namespaced() {
        assert!(OPEN_ID.starts_with("tray:"));
    }
}
