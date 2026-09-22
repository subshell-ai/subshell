//! Subshell Client — a native shell around this machine's `subshell` node agent.
//!
//! Two things in one app, because one person does both: WATCHING a control
//! plane (the `main` window, showing the plane's own UI) and MAKING THIS
//! MACHINE A NODE (the `node` window, bundled, the only surface that drives the
//! `subshell` CLI). The node window existing is the whole of the "node
//! functionality" toggle — a client used purely to watch subshells never opens
//! it.
//!
//! Every command here is a wrapper over `apps/node/agent`'s own binary rather
//! than a reimplementation of it, and none of them is reachable from the window
//! showing the plane's page. See `windows.rs` for why that split is the
//! security boundary.

mod app_update;
mod control;
mod node_bin;
mod reset;
// macOS only: a GTK menu bar is per-window chrome rather than a system bar, so
// Linux has none — and a module compiled there would be entirely dead code.
// Gated at the MODULE, never at the call site, so `cargo clippy` on Linux sees
// the same code Linux compiles.
#[cfg(target_os = "macos")]
mod menu;
mod tray;
mod windows;
mod zoom;

use subshell_desktop_core::settings::{SettingsPaths, SettingsState};
use tauri::Manager;

/// Where this app's settings file lives.
///
/// Both strings are what keep this app's settings distinct from
/// `apps/server/desktop`'s, which uses `dev.subshell.server` /
/// `subshell-desktop-server`; one shared string would mean two apps
/// overwriting one file, each forgetting the other's chosen binary.
///
/// The Linux directory is `subshell-desktop-client`, NOT `subshell`:
/// `~/.config/subshell` is the node AGENT's own config home
/// (`apps/node/agent/src/config.ts`, where `config.json` and the node key live),
/// and dropping this app's `settings.json` in beside it would put two
/// different programs' state in one directory.
const SETTINGS_PATHS: SettingsPaths = SettingsPaths {
    macos_bundle_id: "dev.subshell.client",
    linux_dir: "subshell-desktop-client",
};

/// Windows whose geometry the window-state plugin must not save or restore.
///
/// One name, and it is the assistant's. Kept as a constant so the plugin's
/// configuration and the test that pins it read the same string.
const DENYLIST: &[&str] = &[windows::NODE_LABEL];

/// Environment variables this app refuses to pass on to the agent.
///
/// `SUBSHELL_CONFIG_HOME` relocates the agent's config home
/// (`apps/node/agent/src/config.ts`), and `service install` bakes only `PATH` into
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

/// The menu bar's own dispatch, where there is a menu bar.
///
/// A FUNCTION with two cfg'd bodies rather than a `#[cfg]` on the call itself.
/// That attribute sat on the last statement of `on_menu_event`'s closure, and
/// on Linux — where `mod menu` does not exist — stripping it promoted the
/// `if … { return; }` above it to the closure's tail expression, which is
/// `clippy::needless_return`. `bun run rust:check` on macOS cannot see it: the
/// statement is there, so the `if` is not the tail. CI caught it, as the
/// cfg-stripping hazard both desktop AGENTS.md files already warn about.
///
/// Inverting it to `if !zoom::handle(…) { #[cfg(macos)] … }` is not a fix
/// either — the block is then EMPTY on Linux and `clippy::needless_if` fires
/// instead. A function has a body on both platforms, so neither lint has
/// anything to say.
#[cfg(target_os = "macos")]
fn dispatch_menu_bar(app: &tauri::AppHandle, id: &str) {
    menu::on_event(app, id);
}

#[cfg(not(target_os = "macos"))]
fn dispatch_menu_bar(_app: &tauri::AppHandle, _id: &str) {}

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
                windows::focus_any(app);
            }))
            .plugin(
                tauri_plugin_window_state::Builder::default()
                    // The NODE window is not tracked at all. It is a FIXED,
                    // non-resizable, centred assistant frame (spec
                    // 2026-09-12 § 6.4), so there is no user choice to
                    // remember, and a restored size is actively wrong: the
                    // frame is drawn to that arithmetic.
                    //
                    // Latent here in exactly the way it was in
                    // `apps/server/desktop` (43f6682, found by running that
                    // app): the plugin restores AFTER the builder sets a size,
                    // so any earlier session's saved geometry wins — and every
                    // install that predates this commit has one, because this
                    // window shipped resizable at 760x720. The `main` window
                    // keeps its state; a control plane's UI is a window whose
                    // size is genuinely a user choice.
                    .with_denylist(DENYLIST)
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
        .plugin(tauri_plugin_opener::init())
        // Updating THIS APP (spec 2026-09-15 § 7.2). The plugin's own
        // `endpoints` config is deliberately empty: this repository publishes
        // four components under four tag prefixes, so there is no one static
        // manifest to point at, and `app_update.rs` resolves the right release
        // before handing the plugin exactly one URL.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(SettingsState::new(SETTINGS_PATHS))
        .manage(windows::PlanePin::new())
        .manage(windows::PendingScreen::new())
        .manage(reset::Stash::default())
        .invoke_handler(tauri::generate_handler![
            control::node_probe,
            control::node_install_cli,
            control::node_install_tmux,
            control::node_enroll,
            control::node_configure,
            control::node_service,
            control::node_about,
            control::node_open_web,
            control::node_pending_screen,
            control::node_open_path,
            control::node_logs,
            control::node_settings,
            control::node_plane_add,
            control::node_plane_remove,
            control::node_open_plane,
            control::node_open_plane_url,
            control::desktop_open_in_browser,
            control::node_check_app_update,
            control::node_install_app_update,
            reset::node_arm_reset,
            reset::node_reset,
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
                //
                // Either window, because either can be the last one on screen:
                // a client that is not a node lives entirely in the plane
                // window, and a node being set up lives entirely in the other.
                let hide = control::close_to_tray_now(&window.app_handle().state::<SettingsState>());
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
            // Registered on EVERY platform, and it is the ONE place text
            // size is routed. A Tauri menu event is GLOBAL: this handler
            // receives the TRAY's items as well as the menu bar's, and the
            // tray's own handler receives these. An id routed in both places
            // therefore steps the ladder twice per click — measured, two
            // clicks of Bigger landing on 1.75 — which is why `tray.rs`
            // handles everything except the text size, and why Linux, with no
            // menu bar at all, still needs this handler registered.
            app.on_menu_event(|app, event| {
                let id = event.id.as_ref();
                if zoom::handle(app, id) {
                    return;
                }
                dispatch_menu_bar(app, id);
            });
            // A tray that fails to build is not fatal — everything it offers
            // is reachable another way, and `windows::open_at_startup` puts the
            // node window on screen outright where it would not be.
            if let Err(err) = tray::build(&handle) {
                eprintln!("subshell-node: could not create the tray icon: {err}");
            }
            // At most once a day, in the background, and it opens NOTHING: the
            // only thing it changes is the tray item's label (spec § 7.2, and
            // § 14 — automatic updates are explicitly not this design). After
            // the tray, so the item it labels exists.
            app_update::check_on_launch(&handle);
            // A launch lands on the NODE window, settled addresses or not: a
            // client never opens a control plane's dashboard by itself (spec
            // 2026-09-18 § 2; the rule and its history live in
            // `windows::open_at_startup`). Nothing about the saved plane list
            // is read at startup — the list is a place to go, not a thing to
            // go there unasked.
            windows::open_at_startup(&handle)?;
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
                    && (app.get_webview_window(windows::PLANE_LABEL).is_some()
                        || app.get_webview_window(windows::NODE_LABEL).is_some()) =>
            {
                api.prevent_exit();
            }
            // macOS: clicking the Dock icon of an app with no visible window.
            // Without this a window closed to the tray cannot be brought back
            // from the Dock, only from the tray.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => windows::focus_any(app),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pinned here rather than only at the use site: the bundle id is this
    /// app's identity to macOS (settings directory, notification grant,
    /// single-instance lock, window state), and the Linux directory must stay
    /// clear of the agent CLI's own `~/.config/subshell`.
    #[test]
    fn the_settings_identity_is_this_apps_own() {
        assert_eq!(SETTINGS_PATHS.macos_bundle_id, "dev.subshell.client");
        assert_eq!(SETTINGS_PATHS.linux_dir, "subshell-desktop-client");
        let Some(file) = SETTINGS_PATHS.file() else { return };
        let shown = file.to_string_lossy().into_owned();
        if cfg!(target_os = "macos") {
            assert!(
                shown.ends_with("/Library/Application Support/dev.subshell.client/settings.json"),
                "{shown}"
            );
        } else {
            assert!(
                shown.ends_with("/.config/subshell-desktop-client/settings.json"),
                "{shown}"
            );
        }
    }

    /// Two apps, two settings files. Sharing either string would mean each
    /// app silently overwriting the other's chosen binary.
    #[test]
    fn the_settings_identity_is_not_the_server_apps() {
        assert_ne!(SETTINGS_PATHS.macos_bundle_id, "dev.subshell.server");
        assert_ne!(SETTINGS_PATHS.linux_dir, "subshell-desktop-server");
    }

    /// The Linux directory is NOT the agent CLI's config home. That CLI keeps
    /// `config.json` and the node key in `~/.config/subshell`; a shared
    /// directory would mix two programs' state.
    #[test]
    fn the_linux_directory_is_not_the_agent_clis() {
        assert_ne!(SETTINGS_PATHS.linux_dir, "subshell");
    }

    /// Deliberately not exercised by mutating the environment: `unsetenv` is
    /// not safe against a concurrent `getenv`, and cargo runs these tests in
    /// parallel with ones that read `HOME`, `PATH` and `SUBSHELL_NODE_BIN`.
    /// What is worth pinning is the NAME — the variable whose inheritance
    /// produces an agent that enrolls into one directory and is then started
    /// by a service that reads another.
    #[test]
    fn the_config_home_override_is_scrubbed() {
        assert!(HOSTILE_ENV.contains(&"SUBSHELL_CONFIG_HOME"));
    }
}
