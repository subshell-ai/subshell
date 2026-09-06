//! The system tray.
//!
//! Honest about Linux: `TrayIconEvent` is never emitted there (Tauri's own
//! docs: "Unsupported. The event is not emitted even though the icon is shown
//! and will still show a context menu on right click"), and a stock GNOME has
//! no StatusNotifier host at all, so the icon is SILENTLY INVISIBLE with no
//! error and no way to detect it. Three rules follow, and all three are
//! load-bearing:
//!
//! - Every tray action also exists in the window UI or the menu bar. The tray
//!   is a shortcut, never the only route to anything — which is why this menu
//!   is two items and neither of them drives the CLI.
//! - `close_to_tray` defaults OFF on Linux, is not offered there, and
//!   `node_set_close_to_tray` refuses to persist `true` there. Closing to an
//!   icon that is not there makes the app unreachable, and `single-instance` —
//!   relaunching — is then the only way back.
//! - A `Menu` is attached even though nothing here needs one: on some Linux
//!   implementations an icon with no menu may not register at all.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

/// The tray icon's id.
///
/// Explicit, and distinct from `apps/desktop-server`'s `subshell`: the two apps
/// can be installed side by side, and an id is how anything later (a
/// `tray_by_id` lookup, a tooltip update) addresses this icon rather than the
/// other app's.
const TRAY_ID: &str = "subshell-node";

/// The menu id for "show the window". Namespaced so it can never collide with
/// a predefined item's id.
const OPEN_ID: &str = "tray:open";

/// Build the tray icon. Failure is not fatal — an app without a tray still works.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, OPEN_ID, "Open Subshell Node", true, None::<&str>)?;
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
        // A monochrome template icon is the macOS convention; the same asset
        // renders as-is elsewhere.
        .icon_as_template(true)
        .tooltip("Subshell Node")
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

    // Two apps, one tray. An id shared with `apps/desktop-server` would make
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
