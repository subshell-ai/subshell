//! Subshell Client — a native shell around this machine's `subshell` node agent.
//!
//! The whole product is one sentence: paste a server URL and a setup key, and
//! this machine becomes a node that agents can be launched on — without ever
//! meeting the CLI. Everything below is in service of that, and every command
//! is a wrapper over `apps/client`'s own binary rather than a reimplementation
//! of it.

mod agent_bin;
mod control;
// macOS only: a GTK menu bar is per-window chrome rather than a system bar, so
// Linux has none — and a module compiled there would be entirely dead code.
// Gated at the MODULE, never at the call site, so `cargo clippy` on Linux sees
// the same code Linux compiles.
#[cfg(target_os = "macos")]
mod menu;
mod tray;
mod windows;

use subshell_desktop_core::settings::{SettingsPaths, SettingsState};
use tauri::Manager;

/// Where this app's settings file lives.
///
/// Both strings are SHIPPED: users have a file at these paths, and changing
/// either does not fail — it silently starts every existing user from
/// defaults. They are also what keeps this app's settings distinct from
/// `apps/desktop-server`'s, which uses `dev.subshell.desktop` /
/// `subshell-desktop`; one shared string would mean two apps overwriting one
/// file, each forgetting the other's chosen binary.
const SETTINGS_PATHS: SettingsPaths = SettingsPaths {
    macos_bundle_id: "dev.subshell.node",
    linux_dir: "subshell-node",
};

/// Environment variables this app refuses to pass on to the agent.
///
/// `SUBSHELL_CONFIG_HOME` relocates the agent's config home
/// (`apps/client/src/config.ts`), and `service install` bakes only `PATH` into
/// the unit or plist it writes — so an agent enrolled under a relocated home is
/// started by a service that looks in `~/.config/subshell`, finds nothing, and
/// crash-loops with nothing to explain it. This app also NAMES that directory
/// in its own UI, so honouring an inherited override would make what it shows
/// and what the CLI does disagree.
///
/// A GUI launched from Finder or a desktop entry inherits none of this; a
/// `tauri dev` from a terminal that exported it inherits all of it.
const HOSTILE_ENV: [&str; 1] = ["SUBSHELL_CONFIG_HOME"];

/// Drop [`HOSTILE_ENV`] from this process, so no spawn can inherit it.
///
/// Called as the FIRST thing in [`run`], before any thread exists: `unsetenv`
/// mutates a process-global table that a concurrent `getenv` may be reading,
/// and every later spawn goes through `proc::run`, which inherits this
/// process's environment wholesale (it overrides only `PATH`).
fn scrub_environment() {
    for name in HOSTILE_ENV {
        std::env::remove_var(name);
    }
}

/// Build and run the app.
pub fn run() {
    scrub_environment();

    let mut builder = tauri::Builder::default();

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        // Unconditional: on a Linux desktop with no StatusNotifier host the
        // tray icon is silently invisible, and relaunching is then the only
        // way back to a window that is not showing.
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                windows::focus_main(app);
            }))
            .plugin(
                tauri_plugin_window_state::Builder::default()
                    // NOT VISIBLE. A window hidden to the tray at quit would
                    // otherwise be restored hidden at the next launch — and on
                    // a desktop where the tray icon does not render, that is an
                    // app that starts with no way to reach it.
                    .with_state_flags(
                        tauri_plugin_window_state::StateFlags::all() - tauri_plugin_window_state::StateFlags::VISIBLE,
                    )
                    .build(),
            );
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(SettingsState::new(SETTINGS_PATHS))
        .invoke_handler(tauri::generate_handler![
            control::node_probe,
            control::node_install_agent,
            control::node_enroll,
            control::node_service,
            control::node_set_agent_bin,
            control::node_open_path,
            control::node_settings,
            control::node_set_close_to_tray,
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
                let hide = window.label() == windows::MAIN_LABEL
                    && control::close_to_tray_now(&window.app_handle().state::<SettingsState>());
                if hide {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            #[cfg(target_os = "macos")]
            app.set_menu(menu::build(&handle)?)?;
            // A tray that fails to build is not fatal — nothing it offers is
            // unreachable from the window.
            if let Err(err) = tray::build(&handle) {
                eprintln!("subshell-node: could not create the tray icon: {err}");
            }
            windows::open_main(&handle)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Subshell Client")
        .run(|app, event| match event {
            // Hiding the last window is still "no windows left", and the
            // default answer to that is to quit — so close-to-tray would close
            // to a tray and then exit. The same fresh probe as the hide
            // itself, so the two can never disagree: a window that was NOT
            // hidden because no tray answered must be allowed to take the app
            // down with it.
            tauri::RunEvent::ExitRequested { api, .. }
                if control::close_to_tray_now(&app.state::<SettingsState>())
                    && app.get_webview_window(windows::MAIN_LABEL).is_some() =>
            {
                api.prevent_exit();
            }
            // macOS: clicking the Dock icon of an app with no visible window.
            // Without this a window closed to the tray cannot be brought back
            // from the Dock, only from the tray.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => windows::focus_main(app),
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
        assert_eq!(SETTINGS_PATHS.macos_bundle_id, "dev.subshell.node");
        assert_eq!(SETTINGS_PATHS.linux_dir, "subshell-node");
        let Some(file) = SETTINGS_PATHS.file() else { return };
        let shown = file.to_string_lossy().into_owned();
        if cfg!(target_os = "macos") {
            assert!(
                shown.ends_with("/Library/Application Support/dev.subshell.node/settings.json"),
                "{shown}"
            );
        } else {
            assert!(shown.ends_with("/.config/subshell-node/settings.json"), "{shown}");
        }
    }

    /// Two apps, two settings files. Sharing either string would mean each
    /// app silently overwriting the other's chosen binary.
    #[test]
    fn the_settings_identity_is_not_the_server_apps() {
        assert_ne!(SETTINGS_PATHS.macos_bundle_id, "dev.subshell.desktop");
        assert_ne!(SETTINGS_PATHS.linux_dir, "subshell-desktop");
    }

    /// Deliberately not exercised by mutating the environment: `unsetenv` is
    /// not safe against a concurrent `getenv`, and cargo runs these tests in
    /// parallel with ones that read `HOME`, `PATH` and `SUBSHELL_AGENT_BIN`.
    /// What is worth pinning is the NAME — the variable whose inheritance
    /// produces an agent that enrolls into one directory and is then started
    /// by a service that reads another.
    #[test]
    fn the_config_home_override_is_scrubbed() {
        assert!(HOSTILE_ENV.contains(&"SUBSHELL_CONFIG_HOME"));
    }
}
