//! The macOS menu bar.
//!
//! Linux gets none: GTK menu bars are per-window chrome rather than a system
//! bar, and a Tauri app on Linux with a menu is a strip inside its own window
//! that nobody looks at. Everything reachable from here is also reachable from
//! the tray and from the app's own UI, which is the rule that lets one
//! platform simply not have it.
//!
//! **The predefined Edit items are not decoration.** Without
//! `PredefinedMenuItem::{cut,copy,paste,select_all}` in a submenu, ⌘C and ⌘V do
//! not work AT ALL in a Tauri macOS webview — the shortcuts are delivered to
//! the menu bar, and with nothing there to claim them they are swallowed. In a
//! terminal app that is a correctness bug, not missing polish.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Wry};

use crate::bridge::{dispatch, DesktopAction};

/// Build the application menu.
pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let item = |action: DesktopAction, label: &str, accel: Option<&str>| {
        MenuItem::with_id(app, action.id(), label, true, accel)
    };

    let app_menu = Submenu::with_items(
        app,
        "Subshell Server",
        true,
        &[
            // The panel's content is `about::metadata` — shared with the
            // Linux window menu, where nothing but the metadata renders it,
            // and tested there.
            &PredefinedMenuItem::about(app, None, Some(crate::about::from_app(app)))?,
            &PredefinedMenuItem::separator(app)?,
            &item(DesktopAction::GoPreferences, "Preferences…", Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &item(DesktopAction::SignOut, "Sign Out", None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item(DesktopAction::NewSubshell, "New Subshell…", Some("CmdOrCtrl+N"))?,
            &item(DesktopAction::NewWorkspace, "New Workspace…", Some("CmdOrCtrl+Shift+N"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    // Predefined items FIRST — see the module note. Anything of ours goes after.
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
            &PredefinedMenuItem::separator(app)?,
            &item(DesktopAction::FocusFilter, "Find Subshell…", Some("CmdOrCtrl+F"))?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item(DesktopAction::ToggleSidebar, "Toggle Sidebar", Some("CmdOrCtrl+B"))?,
            &PredefinedMenuItem::separator(app)?,
            &item(DesktopAction::GoSubshells, "Subshells", Some("CmdOrCtrl+1"))?,
            &item(DesktopAction::GoWorkspaces, "Workspaces", Some("CmdOrCtrl+2"))?,
            &item(DesktopAction::GoNodes, "Nodes", Some("CmdOrCtrl+3"))?,
            &item(DesktopAction::GoSettings, "Server Settings", Some("CmdOrCtrl+4"))?,
            &PredefinedMenuItem::separator(app)?,
            // NOT a `DesktopAction`, and that is the whole reason it is built
            // with a bare id here. Those are ROUTER-level operations the page
            // performs, dispatched into it by `eval`; this one launches another
            // program and works with no page at all — so it is routed the way
            // the zoom items are, in Rust, before the action dispatch is
            // reached. It also must not need a window: the fallback path is
            // `/` and the fallback origin is a fresh probe's.
            &MenuItem::with_id(
                app,
                crate::control::MENU_BROWSER_ID,
                "Open in Browser",
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            // Text size, on the accelerators every other app on this platform
            // uses for it. `=` rather than a `Plus` key: the accelerator names
            // a physical key, and ⌘+ is that key with Shift — which is why
            // browsers bind the unshifted one and let the menu read "⌘=".
            &MenuItem::with_id(app, crate::zoom::IN_ID, "Bigger", true, Some("CmdOrCtrl+="))?,
            &MenuItem::with_id(app, crate::zoom::OUT_ID, "Smaller", true, Some("CmdOrCtrl+-"))?,
            &MenuItem::with_id(app, crate::zoom::RESET_ID, "Actual Size", true, Some("CmdOrCtrl+0"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
}

/// Route a menu selection.
pub fn on_event(app: &AppHandle, id: &str) {
    // Before the action dispatch, because that dispatch OPENS A WINDOW when
    // none is on screen — and "open this page in a browser" on a machine whose
    // server is down must not be the thing that launches the assistant. The
    // same rule `zoom::handle` follows, one level up in `lib.rs`.
    if id == crate::control::MENU_BROWSER_ID {
        crate::control::open_current_in_browser(app);
        return;
    }
    if let Some(action) = DesktopAction::from_id(id) {
        // A menu item that needs the page is a no-op without it; open the
        // window first so ⌘1 from a cold start does something. `open_home`
        // is the one opener (spec 2026-09-12 § 5.5), so a machine whose
        // server is down lands on the assistant rather than on nothing.
        if app.get_webview_window("main").is_none() {
            let _ = crate::control::open_home(app);
            return;
        }
        dispatch(app, action);
    }
}
