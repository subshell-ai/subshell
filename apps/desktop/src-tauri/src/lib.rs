//! Subshell Desktop — a native shell around a locally managed `subshell-server`.

mod control;
mod proc;
mod server_bin;
mod settings;
mod shell_env;
mod sidecar;
mod version;
mod windows;

use tauri::Manager;

/// Build and run the app.
///
/// The console window opens FIRST and unconditionally: on a cold machine there
/// is no server to load a page from, so anything that waited for one would show
/// the user nothing at all. `main` is created later, by
/// `desktop_open_main`, once a server is actually answering.
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        // Unconditional: on a Linux desktop with no AppIndicator host the tray
        // icon is silently invisible, and relaunching is then the only way back
        // to a hidden window.
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                if let Some(w) = app
                    .get_webview_window("main")
                    .or_else(|| app.get_webview_window("console"))
                {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }))
            .plugin(tauri_plugin_window_state::Builder::default().build());
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(settings::SettingsState::new())
        .invoke_handler(tauri::generate_handler![
            control::desktop_probe,
            control::desktop_install_server,
            control::desktop_init,
            control::desktop_service,
            control::desktop_set_server_bin,
            control::desktop_open_main,
            control::desktop_open_console,
        ])
        .setup(|app| {
            windows::open_console(&app.handle().clone())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running subshell desktop");
}
