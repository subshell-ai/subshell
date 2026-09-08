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

use subshell_desktop_core::legal::{COMPANY_URL, COPYRIGHT_HOLDER, COPYRIGHT_LINE, LICENSE_SUMMARY, LICENSE_URL};
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
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
            &PredefinedMenuItem::about(
                app,
                None,
                Some(AboutMetadata {
                    // Tauri renders an EMPTY About box from
                    // `AboutMetadata::default()` — no version, no copyright, no
                    // licence. For the one app surface whose entire job is to
                    // say what this software is and who owns it, that is the
                    // whole content missing, not a rough edge.
                    //
                    // `name` and `version` are deliberately left unset: Tauri
                    // then falls back to the BUNDLE's own values, which are the
                    // right ones. The crate is 0.1.0 while the app ships 0.5.0
                    // (tauri.conf.json reads ../package.json), so
                    // `env!("CARGO_PKG_VERSION")` here would confidently print
                    // the wrong version, and `productName` differs per app.
                    copyright: Some(COPYRIGHT_LINE.into()),
                    // There is ONE link slot, and an About box's website
                    // conventionally means the publisher — so the licence URL
                    // rides inside the licence text instead of competing for
                    // it. Not clickable there, but present, which is what the
                    // obligation to state the terms actually needs.
                    license: Some(format!("{LICENSE_SUMMARY}\n{LICENSE_URL}")),
                    website: Some(COMPANY_URL.into()),
                    website_label: Some(COPYRIGHT_HOLDER.into()),
                    ..Default::default()
                }),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &item(DesktopAction::GoPreferences, "Preferences…", Some("CmdOrCtrl+,"))?,
            &MenuItem::with_id(app, "console", "Server…", true, None::<&str>)?,
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
    if id == "console" {
        let _ = crate::windows::open_console(app);
        return;
    }
    if let Some(action) = DesktopAction::from_id(id) {
        // A menu item that needs the page is a no-op without it; open the
        // window first so ⌘1 from a cold start does something.
        if app.get_webview_window("main").is_none() {
            let _ = crate::windows::open_console(app);
            return;
        }
        dispatch(app, action);
    }
}
