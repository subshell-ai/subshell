//! Subshell Server — a native shell around a locally managed `subshell-server`.

// macOS-only, like its one consumer. `menu.rs` is the last thing that
// dispatches a `DesktopAction` now that the tray does not, and a GTK menu bar
// is per-window chrome rather than a system bar so there is no Linux menu to
// carry it. Gated at the MODULE rather than left to its call site, because
// clippy on Linux is then right to call the whole thing dead code.
// Compiles on BOTH platforms: the About metadata is shared, and on Linux this
// module is the whole menu bar the dashboard window carries (spec 2026-09-17
// § 6). `menu.rs` below stays macOS-only — it is the full menu BAR, and its
// `DesktopAction` dispatch is what Linux has no use for.
mod about;
mod app_update;
#[cfg(target_os = "macos")]
mod bridge;
mod control;
// macOS only: a GTK menu bar is per-window chrome rather than a system bar, so
// Linux carries no ACTION menu (its one item, the predefined About on the
// dashboard, is `about.rs`) — and a module compiled there would be entirely
// dead code.
#[cfg(target_os = "macos")]
mod menu;
mod reset;
mod server_bin;
mod supervisor;
mod tray;
mod watch;
mod windows;
mod zoom;

use subshell_desktop_core::settings::{SettingsPaths, SettingsState};
use tauri::Manager;

/// Where this app's settings file lives.
///
/// Both strings are what keep this app's settings distinct from
/// `apps/client/desktop`'s: one shared string would mean two apps overwriting
/// one file, each forgetting the other's chosen binary.
///
/// The Linux directory is `subshell-desktop-server`, NOT `subshell-server`:
/// `~/.config/subshell-server` is where the SERVER CLI keeps its `config.env`
/// (`apps/server/api/src/config-env.ts`), and dropping this app's `settings.json`
/// in beside it would put two different programs' state in one directory.
const SETTINGS_PATHS: SettingsPaths = SettingsPaths {
    macos_bundle_id: "dev.subshell.server",
    linux_dir: "subshell-desktop-server",
};

/// Windows whose geometry the window-state plugin must not save or restore.
///
/// One name, and it is the assistant's. Kept as a constant so the plugin's
/// configuration and the test that pins it read the same string.
const DENYLIST: &[&str] = &["wizard"];

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
///
/// Boot opens ONE window, chosen from a fresh probe: the dashboard when the
/// server is already answering, and otherwise the bundled assistant, which is
/// the page that renders on a cold machine with no server to load from.
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        // Unconditional: on a Linux desktop with no AppIndicator host the tray
        // icon is silently invisible, and relaunching is then the only way back
        // to a hidden window.
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                match app
                    .get_webview_window("main")
                    .or_else(|| app.get_webview_window("wizard"))
                {
                    Some(w) => windows::raise(&w),
                    // Nothing is on screen (both windows were closed to the
                    // tray or never opened): relaunching must land somewhere,
                    // and `open_home` is the one function that decides where.
                    None => {
                        let _ = control::open_home(app);
                    }
                }
            }))
            .plugin(
                tauri_plugin_window_state::Builder::default()
                    // The ASSISTANT is not tracked at all. It is a FIXED,
                    // non-resizable, centred frame sized from
                    // `assistant_frame` (spec 2026-09-11 § 4), so there is no
                    // user choice to remember — and a restored size is
                    // actively wrong: the frame is drawn to that arithmetic,
                    // and `open_main` reads this window's geometry to place
                    // the dashboard where it stood, so a stale size would
                    // move a window it no longer describes.
                    //
                    // Measured on 2026-09-12, and only reachable once the
                    // assistant started opening on every not-ready boot
                    // rather than on first run alone: a state file left by an
                    // older build restored 757x706, and the assistant came up
                    // at that size on a machine whose server was merely
                    // stopped.
                    .with_denylist(DENYLIST)
                    // NOT VISIBLE: `main` is created hidden on purpose and shown
                    // only by the title-bar handshake. Restoring saved
                    // visibility would show it decorated before the page can
                    // ask for the overlay, which is the flash the handshake
                    // exists to avoid.
                    //
                    // NOT MAXIMIZED or FULLSCREEN either: size and position are
                    // worth remembering for the dashboard, but a window that
                    // was maximized once then reopens maximized forever, and a
                    // compositor that maximized it on the user's behalf is
                    // enough to latch it.
                    .with_state_flags(
                        tauri_plugin_window_state::StateFlags::all()
                            - tauri_plugin_window_state::StateFlags::VISIBLE
                            - tauri_plugin_window_state::StateFlags::MAXIMIZED
                            - tauri_plugin_window_state::StateFlags::FULLSCREEN,
                    )
                    .build(),
            );
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        // Updating THIS APP (spec 2026-09-15 § 7.2). The plugin's own
        // `endpoints` config is deliberately empty: this repository publishes
        // four components under four tag prefixes, so there is no one static
        // manifest to point at, and `app_update.rs` resolves the right release
        // before handing the plugin exactly one URL.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(SettingsState::new(SETTINGS_PATHS))
        .manage(windows::ShellReady::new())
        // The reset's stashed plan and screen request live HERE, not on any
        // page: the consent is spent by the command that mutates the disk,
        // and a window reload must not be able to lose or repeat it.
        .manage(reset::Stash::default())
        .manage(supervisor::Supervisor::new())
        .invoke_handler(tauri::generate_handler![
            control::desktop_probe,
            control::desktop_port_in_use,
            control::desktop_logs,
            control::desktop_install_server,
            control::desktop_setup,
            control::desktop_install_tmux,
            control::desktop_service,
            control::desktop_set_server_bin,
            control::desktop_set_supervision,
            control::desktop_open_main,
            control::desktop_open_assistant,
            reset::desktop_reset,
            reset::desktop_arm_reset,
            reset::desktop_pending_screen,
            control::desktop_open_path,
            control::desktop_open_tmux_docs,
            control::desktop_about,
            control::desktop_open_web,
            control::desktop_notify,
            control::desktop_shell_ready,
            control::desktop_open_in_browser,
            control::desktop_permissions,
            control::desktop_request_notifications,
            control::desktop_request_photos,
            control::desktop_open_system_settings,
            control::desktop_check_app_update,
            control::desktop_install_app_update,
            control::desktop_app_update,
        ])
        .on_window_event(|window, event| {
            // The assistant's page can no longer hear an event once its window
            // is destroyed, and the flag that says it can must not outlive it —
            // a stale true here is how the dashboard's next raise emitted into
            // a window that had not booted, and the assistant flashed and
            // closed (2026-09-12).
            if window.label() == "wizard" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().state::<reset::Stash>().page_gone();
            }
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
            // system bar, and everything here is also on the tray. Linux's
            // one menu is the dashboard window's single About item, attached
            // in `windows::open_main` (spec 2026-09-17 § 6).
            #[cfg(target_os = "macos")]
            app.set_menu(menu::build(&handle)?)?;
            // Registered on EVERY platform, and it is the ONE place text
            // size is routed. A Tauri menu event is GLOBAL: this handler
            // receives the TRAY's items as well as the menu bar's, and the
            // tray's own handler receives these. An id routed in both places
            // therefore steps the ladder twice per click — measured, two
            // clicks of Bigger landing on 1.75 — which is why `tray.rs`
            // handles everything except the text size, and why Linux still
            // needs this handler registered: its only menu is the dashboard's
            // one-item About bar (2026-09-17), whose single item is PREDEFINED
            // and answered in muda's own click handler, so what needs this
            // handler there is the TRAY.
            app.on_menu_event(|app, event| {
                let id = event.id.as_ref();
                if zoom::handle(app, id) {
                    return;
                }
                dispatch_menu_bar(app, id);
            });
            // A tray that fails to build is not fatal — every action it offers
            // exists in the window UI too.
            if let Err(err) = tray::build(&handle) {
                eprintln!("subshell: could not create the tray icon: {err}");
            }
            // At most once a day, in the background, and it opens NOTHING: the
            // only thing it changes is the tray item's label (spec § 7.2, and
            // § 14 — automatic updates are explicitly not this design). After
            // the tray, so the item it labels exists.
            app_update::check_on_launch(&handle);
            // Boot looks before it leaps: the probe marks what it proves
            // (control::boot_probe -> mark_onboarded), and the WINDOW CHOICE
            // is made from the fresh answer, never the stored flag. A machine
            // set up entirely from the CLI opens the DASHBOARD, because the
            // first probe answers ready (spec 2026-09-12 § 5.2).
            let choice = {
                let settings = handle.state::<subshell_desktop_core::settings::SettingsState>();
                let mut probe = control::boot_probe(&settings);
                // App mode: nothing else will start this server, so boot does
                // — and then waits briefly for the port, because `spawn`
                // returns when the process exists and the window choice needs
                // it LISTENING. A server that takes longer lands on recovery,
                // whose Start is idempotent.
                if probe.supervision == subshell_desktop_core::settings::Supervision::App
                    && probe.next != control::ProbeStep::Ready
                {
                    match control::server_spawner(&handle) {
                        Ok(spawner) => {
                            handle.state::<supervisor::Supervisor>().start(spawner);
                            probe = control::wait_for_boot(&handle, &settings);
                        }
                        Err(err) => eprintln!("subshell: could not start the server: {err}"),
                    }
                }
                // PHASE 2 of one update act (spec 2026-09-18 § 4.2). If this
                // build came up because the person pressed Update in the
                // PREVIOUS one, the bundled server it ships is still not
                // installed — `boot_resume` decides that from the marker and
                // the machine, counts the attempt, and requests the `update`
                // screen through the same stash every deep link uses.
                //
                // It outranks `boot_window`, and has to: a machine whose
                // server is running answers `Main`, which would open the
                // dashboard over an act the person started and never see the
                // assistant again. Dismissing the screen hands off to the
                // dashboard anyway, through the page's ordinary ready path.
                if control::boot_resume(&handle, &settings, &probe) {
                    control::WindowChoice::Wizard
                } else {
                    control::boot_window(&probe)
                }
            };
            match choice {
                control::WindowChoice::Wizard => {
                    windows::open_assistant(&handle)?;
                }
                // A ready machine opens straight onto the dashboard. If that
                // window cannot be built — the server answered the probe and
                // then stopped, say — the assistant is the fallback rather
                // than a boot with no window at all.
                control::WindowChoice::Main => {
                    if let Err(e) = control::open_main_now(&handle) {
                        eprintln!("subshell: could not open the dashboard: {e}");
                        windows::open_assistant(&handle)?;
                    }
                }
            }
            // After the boot window, never before: the watch follows `main`'s
            // origin, and its first tick is five seconds away regardless.
            watch::spawn(handle.clone());
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
            // The app is going away, so its child must too — "runs with this
            // app" is the promise app mode makes, and a server left behind
            // would hold the port against the next launch while answering for
            // an app that is gone. This is the one hook that runs on every
            // exit path Tauri controls; a window merely hidden to the tray is
            // still the app running, so nothing here fires for that.
            //
            // Gated on there being a CHILD, and cheaply: this runs on the
            // main thread, and `server_spawner` resolves the binary ladder
            // (which execs `version` on each rung) plus a `status --json`
            // with a 15-second timeout. Paying that in service mode — where
            // the supervisor owns nothing and the spawner is discarded
            // unused — turned ⌘Q into a possible 15-second hang for every
            // user, including every user who never chose app mode.
            tauri::RunEvent::Exit => {
                let supervisor = app.state::<supervisor::Supervisor>();
                // Gated on the SPAWNER, not on a live pid: between a crash
                // and the respawn the pid is None while the loop is still
                // alive and still wants a server, so a pid-gated check would
                // skip the stop and let that loop spawn a fresh server into
                // an app that is already leaving — an orphan holding the port
                // against the next launch.
                if let Some(spawner) = supervisor.spawner() {
                    if !supervisor.stop(spawner.as_ref()) {
                        // Nothing left to do on the way out, but a server we
                        // could not stop is worth a line in the log a crash
                        // reporter would collect.
                        eprintln!("subshell: quit with the server still running");
                    }
                }
            }
            // macOS: clicking the Dock icon of an app with no visible window.
            // Without this a window closed to the tray cannot be brought back
            // from the Dock, only from the tray — and on a desktop where the
            // tray is invisible that is nowhere.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                match app
                    .get_webview_window("main")
                    .or_else(|| app.get_webview_window("wizard"))
                {
                    Some(w) => windows::raise(&w),
                    None => {
                        let _ = control::open_home(app);
                    }
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    /// The ASSISTANT's geometry is never restored.
    ///
    /// It is a fixed, non-resizable, centred frame, so there is nothing a
    /// person could have chosen — and `open_main` inherits its position and
    /// size, so a restored one would reach the dashboard too. Pinned against
    /// the window label rather than trusted to the comment beside it, because
    /// the symptom is a window that opens at the wrong size and nothing else:
    /// no error, no failing build.
    #[test]
    fn the_assistant_is_not_tracked_by_the_window_state_plugin() {
        assert_eq!(DENYLIST, ["wizard"]);
    }

    /// The window-state plugin must not restore MAXIMIZED or FULLSCREEN.
    ///
    /// The dashboard has a size it is meant to open at. A window maximized
    /// once otherwise reopens maximized forever, and on Linux a compositor
    /// maximizing it on the user's behalf is enough to latch that. Written as
    /// `all() - VISIBLE` it read like a single deliberate exclusion, which is
    /// exactly the shape someone tidies back up.
    #[test]
    fn saved_window_state_excludes_visible_maximized_and_fullscreen() {
        use tauri_plugin_window_state::StateFlags;
        let restored = StateFlags::all() - StateFlags::VISIBLE - StateFlags::MAXIMIZED - StateFlags::FULLSCREEN;
        assert!(!restored.contains(StateFlags::VISIBLE));
        assert!(!restored.contains(StateFlags::MAXIMIZED));
        assert!(!restored.contains(StateFlags::FULLSCREEN));
        // Size and position ARE worth remembering.
        assert!(restored.contains(StateFlags::SIZE));
        assert!(restored.contains(StateFlags::POSITION));
    }

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
