//! Open the bundled display helper's settings panel.
//!
//! Two doors reach it, and they are the same act: the native application menu's
//! **Virtual Display Helper…** item (`menu.rs`) and the assistant window's
//! Virtual Displays screen (`control::desktop_open_display_helper`). The second
//! exists because the first is easy to miss, and the control plane's node
//! settings point here by name.
//!
//! The panel itself belongs to the helper, a separate signed program, so
//! enabling it and granting macOS its permissions both happen outside this app.
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

pub const MENU_ID: &str = "native:display-helper";

pub fn open_settings(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let resources = if cfg!(debug_assertions) {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")
            } else {
                app.path().resource_dir().map_err(|e| e.to_string())?
            };
            let home = app.path().home_dir().map_err(|e| e.to_string())?;
            subshell_desktop_core::display_helper::open_settings(&resources, &home)
        })();
        if let Err(error) = result {
            app.dialog()
                .message(error)
                .title("Couldn't open display helper settings")
                .show(|_| {});
        }
    });
}
