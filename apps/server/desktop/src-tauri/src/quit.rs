//! The tray's Quit, and the confirmation in front of killing a running server.
//!
//! Two facts drove this module's existence. First, the tray used to carry
//! [`tauri::menu::PredefinedMenuItem::quit`], which muda renders as a DISABLED
//! item on Linux (GTK supports only a few predefined roles; Quit is not one),
//! so the one item meant to end the app was greyed and inert — and, having no
//! app id, nothing could intercept it to confirm. It is now an ordinary item
//! under [`QUIT_ID`], dispatched here from `tray::on_menu`.
//!
//! Second, a deliberate Quit must not be swallowed by "Keep Running in Tray"
//! (which is about closing the window, not about the explicit request to
//! leave). `lib.rs` answers that by letting a programmatic exit through
//! [`crate::control::should_prevent_exit`]; this module raises that exit.
//!
//! The confirmation is native and window-independent (`tauri_plugin_dialog`
//! reaches the OS dialog from the `AppHandle`, so it works with the window
//! hidden to the tray — the `windows.rs` download notice is the precedent). It
//! is shown only when a server is actually running, and its shape follows the
//! supervision mode: in app mode the app OWNS the child, so quitting only ever
//! means "quit and stop it" (there is no independent service to leave running,
//! and offering that would orphan an unsupervised process on the port); in
//! service mode the server outlives the app by design, so the person is asked
//! whether to stop the service too.

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

use subshell_desktop_core::settings::{SettingsState, Supervision};

use crate::control::{self, ServiceCommand};
use crate::supervisor::Supervisor;

/// The id the Quit item carries, on the tray and (via the global menu-event
/// path) anywhere else it is pressed. Owned here — the module that answers it —
/// so the dispatch's word and the item's word cannot drift apart. It is NOT a
/// `DesktopAction` id and it collides with nothing `menu.rs`/`zoom`/tray route.
pub const QUIT_ID: &str = "app:quit";

/// The three outcomes of a Quit press, decided from (mode, running) with no
/// dialog and no side effect, so the rule is testable on its own.
#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    /// Nothing is running: leave immediately, no prompt.
    QuitNow,
    /// App mode with the app's own child running: one confirm — quit stops it.
    ConfirmStop,
    /// Service mode with a running service: ask stop-and-quit vs quit-and-leave.
    ConfirmServiceChoice,
}

/// The whole decision, pure. A server is running in the only sense this app can
/// check (the port answers); an app-mode quit has no "leave it running" because
/// the app is the thing keeping it alive.
pub fn plan(mode: Supervision, running: bool) -> Plan {
    if !running {
        return Plan::QuitNow;
    }
    match mode {
        Supervision::App => Plan::ConfirmStop,
        Supervision::Service => Plan::ConfirmServiceChoice,
    }
}

/// Answer a Quit press. The running/mode check runs `status --json` probes, so
/// it happens off the main thread; only the dialog and the final exit return to
/// it. Menu callbacks are on the main thread and would freeze on the probe.
pub fn handle(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let probe = control::boot_probe(&app.state::<SettingsState>());
        let running = probe.next == control::ProbeStep::Ready;
        let mode = probe.supervision;
        let action = plan(mode, running);
        let target = app.clone();
        // Show the dialog (and, for the no-prompt case, exit) on the main
        // thread: the plugin's callback dialog must not run on a worker, and
        // this is the hop back.
        let _ = app.run_on_main_thread(move || present(target, action));
    });
}

/// Present the prompt (or quit outright). Runs on the main thread.
fn present(app: AppHandle, action: Plan) {
    match action {
        Plan::QuitNow => {
            app.exit(0);
        }
        Plan::ConfirmStop => {
            let quitting = app.clone();
            app.dialog()
                .message("Quit Subshell Server? The server it is running will be stopped first.")
                .title("Quit Subshell Server")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::YesNo)
                .show_with_result(move |result| {
                    if result == MessageDialogResult::Yes {
                        stop_then_quit(quitting, true);
                    }
                });
        }
        Plan::ConfirmServiceChoice => {
            let quitting = app.clone();
            app.dialog()
                .message("A server is running as a background service. Quit and stop it, or quit and leave it running?")
                .title("Quit Subshell Server")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::YesNoCancel)
                .show_with_result(move |result| match result {
                    MessageDialogResult::Yes => stop_then_quit(quitting.clone(), false),
                    MessageDialogResult::No => quitting.exit(0),
                    _ => {}
                });
        }
    }
}

/// Stop the server, then quit. The stop blocks up to the supervisor's signal
/// bounds (or the service manager's `stop`), so it runs on a worker; the exit
/// is posted back to the main thread.
fn stop_then_quit(app: AppHandle, in_app_mode: bool) {
    std::thread::spawn(move || {
        if in_app_mode {
            let sup = app.state::<Supervisor>();
            match sup.spawner().map(Ok).unwrap_or_else(|| control::server_spawner(&app)) {
                // Mirror reset.rs's discipline: a stop that gave up is logged,
                // never treated as permission — but here the app is leaving
                // regardless, so there is nothing to refuse and the `RunEvent::Exit`
                // safety net re-signals the pid.
                Ok(spawner) => {
                    if !sup.stop(spawner.as_ref()) {
                        eprintln!("subshell: quit with the server still running");
                    }
                }
                Err(err) => eprintln!("subshell: could not stop the server on quit: {err}"),
            }
        } else {
            let settings = app.state::<SettingsState>();
            let stopped = control::service_now(&settings, ServiceCommand::Stop, false);
            if !stopped.ok {
                eprintln!(
                    "subshell: quit asked to stop the service but it did not confirm: {}",
                    stopped.stderr
                );
            }
        }
        let target = app.clone();
        let _ = app.run_on_main_thread(move || target.exit(0));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole matrix, with no runtime and no dialog: not running always quits
    /// silently; running confirms; the confirm SHAPE differs by mode, because an
    /// app-mode quit has no "leave it running" to offer.
    #[test]
    fn the_plan_follows_mode_and_running() {
        assert_eq!(plan(Supervision::App, false), Plan::QuitNow);
        assert_eq!(plan(Supervision::Service, false), Plan::QuitNow);
        assert_eq!(plan(Supervision::App, true), Plan::ConfirmStop);
        assert_eq!(plan(Supervision::Service, true), Plan::ConfirmServiceChoice);
    }

    /// The quit id is this app's own and is not a router/action/browser id that
    /// another handler would also claim — the global-menu-event hazard that makes
    /// a shared id fire twice.
    #[test]
    fn the_quit_id_is_unique_across_the_dispatchers() {
        assert_eq!(QUIT_ID, "app:quit");
        for other in [
            "tray:open",
            "tray:app",
            "tray:browser",
            "tray:update",
            "tray:keep",
            "tray:reset",
            "tray:backup",
            "tray:restore",
            crate::zoom::IN_ID,
            crate::zoom::OUT_ID,
            crate::zoom::RESET_ID,
            control::MENU_BROWSER_ID,
        ] {
            assert_ne!(QUIT_ID, other);
        }
    }
}
