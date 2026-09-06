//! The macOS menu bar.
//!
//! Linux gets none: GTK menu bars are per-window chrome rather than a system
//! bar, and a Tauri app on Linux with a menu is a strip inside its own window
//! that nobody looks at. Nothing here is the only route to anything — every
//! item is either a predefined system action or reachable from the window
//! itself — which is the rule that lets one platform simply not have it.
//!
//! **The predefined Edit items are not decoration.** Without
//! `PredefinedMenuItem::{cut,copy,paste,select_all}` in a submenu, ⌘C and ⌘V do
//! not work AT ALL in a Tauri macOS webview — the shortcuts are delivered to
//! the menu bar, and with nothing there to claim them they are swallowed. This
//! app's whole first screen is a form into which the user PASTES a server URL
//! and a setup key that cannot reasonably be typed by hand, so a missing ⌘V
//! here is not missing polish, it is an app that cannot be used.

use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Wry};

/// Build the application menu.
pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let app_menu = Submenu::with_items(
        app,
        "Subshell Node",
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
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])
}
