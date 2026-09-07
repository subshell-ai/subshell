//! Subshell Server — a native shell around a locally managed `subshell-server`.

mod bridge;
mod control;
// macOS only: a GTK menu bar is per-window chrome rather than a system bar, so
// Linux has none — and a module compiled there would be entirely dead code.
#[cfg(target_os = "macos")]
mod menu;
mod server_bin;
mod tray;
mod windows;

use subshell_desktop_core::settings::{SettingsPaths, SettingsState};
use tauri::Manager;

/// Where this app's settings file lives.
///
/// Both strings are what keep this app's settings distinct from
/// `apps/desktop-client`'s: one shared string would mean two apps overwriting
/// one file, each forgetting the other's chosen binary.
///
/// The Linux directory is `subshell-desktop-server`, NOT `subshell-server`:
/// `~/.config/subshell-server` is where the SERVER CLI keeps its `config.env`
/// (`apps/server/src/config-env.ts`), and dropping this app's `settings.json`
/// in beside it would put two different programs' state in one directory.
const SETTINGS_PATHS: SettingsPaths = SettingsPaths {
    macos_bundle_id: "dev.subshell.server",
    linux_dir: "subshell-desktop-server",
};

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
            .plugin(
                tauri_plugin_window_state::Builder::default()
                    // NOT VISIBLE: `main` is created hidden on purpose and shown
                    // only by the title-bar handshake. Restoring saved
                    // visibility would show it decorated before the page can
                    // ask for the overlay, which is the flash the handshake
                    // exists to avoid.
                    .with_state_flags(
                        tauri_plugin_window_state::StateFlags::all() - tauri_plugin_window_state::StateFlags::VISIBLE,
                    )
                    .build(),
            );
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(SettingsState::new(SETTINGS_PATHS))
        .manage(windows::ShellReady::new())
        .invoke_handler(tauri::generate_handler![
            control::desktop_probe,
            control::desktop_install_server,
            control::desktop_init,
            control::desktop_service,
            control::desktop_set_server_bin,
            control::desktop_open_main,
            control::desktop_open_console,
            control::desktop_notify,
            control::desktop_shell_ready,
            control::desktop_settings,
            control::desktop_set_close_to_tray,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Close-to-tray is opt-in, and the check RE-PROBES the desktop
                // here rather than trusting the stored preference: where no
                // StatusNotifier host is registered the icon is silently
                // invisible, and hiding into it would make the window
                // unreachable with nothing to explain it. This is the guard
                // that actually protects the user — the setting may have been
                // made on a session that had a tray.
                let hide = window.label() == "main"
                    && control::close_to_tray_now(&window.app_handle().state::<SettingsState>());
                if hide {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            // macOS only: a GTK menu bar is per-window chrome rather than a
            // system bar, and everything here is also on the tray.
            #[cfg(target_os = "macos")]
            {
                app.set_menu(menu::build(&handle)?)?;
                app.on_menu_event(|app, event| menu::on_event(app, event.id.as_ref()));
            }
            // A tray that fails to build is not fatal — every action it offers
            // exists in the window UI too.
            if let Err(err) = tray::build(&handle) {
                eprintln!("subshell: could not create the tray icon: {err}");
            }
            windows::open_console(&handle)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building subshell desktop")
        .run(|app, event| match event {
            // Hiding the last window is still "no windows left", and the
            // default answer to that is to quit — so close-to-tray would close
            // to a tray and then exit. Closing the CONSOLE hit the same path.
            // The same fresh probe as the hide itself, so the two can never
            // disagree: a window that was NOT hidden because no tray answered
            // must be allowed to take the app down with it.
            tauri::RunEvent::ExitRequested { api, .. }
                if control::close_to_tray_now(&app.state::<SettingsState>())
                    && app.get_webview_window("main").is_some() =>
            {
                api.prevent_exit();
            }
            // macOS: clicking the Dock icon of an app with no visible window.
            // Without this a window closed to the tray cannot be brought back
            // from the Dock, only from the tray — and on a desktop where the
            // tray is invisible that is nowhere.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                let window = app
                    .get_webview_window("main")
                    .or_else(|| app.get_webview_window("console"));
                if let Some(w) = window {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pinned here rather than only at the use site: the bundle id is this
    /// app's identity to macOS (settings directory, notification grant,
    /// single-instance lock, window state), and the Linux directory must stay
    /// clear of the server CLI's own `~/.config/subshell-server`.
    #[test]
    fn the_settings_identity_is_this_apps_own() {
        assert_eq!(SETTINGS_PATHS.macos_bundle_id, "dev.subshell.server");
        assert_eq!(SETTINGS_PATHS.linux_dir, "subshell-desktop-server");
        let Some(file) = SETTINGS_PATHS.file() else { return };
        let shown = file.to_string_lossy().into_owned();
        if cfg!(target_os = "macos") {
            assert!(
                shown.ends_with("/Library/Application Support/dev.subshell.server/settings.json"),
                "{shown}"
            );
        } else {
            assert!(
                shown.ends_with("/.config/subshell-desktop-server/settings.json"),
                "{shown}"
            );
        }
    }

    /// The Linux directory is NOT the server CLI's config home. That CLI keeps
    /// `config.env` in `~/.config/subshell-server`; a shared directory would
    /// mix two programs' state.
    #[test]
    fn the_linux_directory_is_not_the_server_clis() {
        assert_ne!(SETTINGS_PATHS.linux_dir, "subshell-server");
    }
}
