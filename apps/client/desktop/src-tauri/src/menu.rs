//! The macOS menu bar.
//!
//! Linux gets none: GTK menu bars are per-window chrome rather than a system
//! bar, and a Tauri app on Linux with a menu is a strip inside its own window
//! that nobody looks at.
//!
//! **"This machine…" is the exception to that rule, and it is load-bearing.**
//! Every other item here is a predefined system action, but this app's node
//! window can otherwise be reached only from the tray — the plane window is
//! remote content granted nothing, so it cannot offer a route — and a macOS
//! status item is silently invisible on a notched display whose Control Center
//! has wedged (see `tray.rs`). A menu bar is always drawn, so this is the route
//! that cannot disappear. Linux has no menu bar at all, which is why
//! `windows::open_at_startup` puts that window on screen outright where the
//! tray probe says nothing would render it.
//!
//! **The predefined Edit items are not decoration.** Without
//! `PredefinedMenuItem::{cut,copy,paste,select_all}` in a submenu, ⌘C and ⌘V do
//! not work AT ALL in a Tauri macOS webview — the shortcuts are delivered to
//! the menu bar, and with nothing there to claim them they are swallowed. This
//! app's whole first screen is a form into which the user PASTES a server URL
//! and a setup key that cannot reasonably be typed by hand, so a missing ⌘V
//! here is not missing polish, it is an app that cannot be used.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Wry};

/// The menu id for "show the node window". Namespaced so it can never collide
/// with a predefined item's id.
const NODE_ID: &str = "menu:node";

/// Build the application menu.
pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let node = MenuItem::with_id(app, NODE_ID, "This machine…", true, None::<&str>)?;
    let app_menu = Submenu::with_items(
        app,
        "Subshell Client",
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    // Predefined items FIRST — see the module note. Anything of ours would go
    // after, and today there is nothing: every action this app offers changes
    // the machine and belongs behind the window's own confirmations, not
    // one keystroke away in a menu.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            // The route home for the node window — the one item here that is
            // not a system action. See the module note.
            &node,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])
}

/// Route a menu click. Only this app's own items are handled; the predefined
/// ones are the system's.
pub fn on_event(app: &AppHandle, id: &str) {
    if id == NODE_ID {
        crate::windows::focus_node(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Namespaced so it cannot collide with a predefined item's id, and
    // distinct from the tray's — the two menus are separate id spaces, but a
    // shared string would make a future `on_event` ambiguous to read.
    #[test]
    fn the_menu_id_is_namespaced() {
        assert!(NODE_ID.starts_with("menu:"));
    }
}
