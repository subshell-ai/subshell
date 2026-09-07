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
/// Both strings are SHIPPED: users already have a file at these paths, and
/// changing either silently forgets every preference they set. They are also
/// what keeps this app's settings distinct from `apps/desktop-client`'s.
const SETTINGS_PATHS: SettingsPaths = SettingsPaths {
    macos_bundle_id: "dev.subshell.desktop",
    linux_dir: "subshell-desktop",
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

    /// The settings file is SHIPPED state. Moving it — by renaming the bundle
    /// id or the Linux directory — does not fail, it silently starts every
    /// existing user from defaults, so the two strings are pinned here rather
    /// than only living at their use site.
    #[test]
    fn the_settings_identity_is_the_one_users_already_have() {
        assert_eq!(SETTINGS_PATHS.macos_bundle_id, "dev.subshell.desktop");
        assert_eq!(SETTINGS_PATHS.linux_dir, "subshell-desktop");
        let Some(file) = SETTINGS_PATHS.file() else { return };
        let shown = file.to_string_lossy().into_owned();
        if cfg!(target_os = "macos") {
            assert!(
                shown.ends_with("/Library/Application Support/dev.subshell.desktop/settings.json"),
                "{shown}"
            );
        } else {
            assert!(shown.ends_with("/.config/subshell-desktop/settings.json"), "{shown}");
        }
    }
}
