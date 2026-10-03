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
//! supervision mode AND what the app can actually stop: in app mode the app OWNS
//! a child it can signal, so a running port means "quit and stop it" (there is
//! no independent service to leave running, and offering that would orphan an
//! unsupervised process on the port); in service mode the server outlives the
//! app by design, so the person is asked whether to stop the service too. When
//! app mode finds the port answering but NO child of its own (an orphan from a
//! prior run, a hand-run binary), it has nothing to stop and quits silently,
//! rather than promising a stop it cannot perform.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

use subshell_desktop_core::settings::{SettingsState, Supervision};

use crate::control::{self, ServiceCommand};
use crate::supervisor::Supervisor;

/// The id the Quit item carries, on the tray and (via the global menu-event
/// path) anywhere else it is pressed. Owned here — the module that answers it —
/// so the dispatch's word and the item's word cannot drift apart. It is NOT a
/// `DesktopAction` id and it collides with nothing `menu.rs`/`zoom`/tray route
/// (those are `native:`/`action:`/`zoom:`/`tray:` prefixed, provably disjoint).
pub const QUIT_ID: &str = "app:quit";

/// One Quit is in progress: probed, dialog shown, or stopping. A tray item is
/// not disabled while a press runs, so a second press would otherwise stack a
/// second dialog, or drive a second stop at one child (both would capture the
/// same pid and one of the two would signal a pid the supervisor no longer
/// owns). The crate's rule for exactly this is "refuse, never queue" — see
/// `desktop_set_supervision` and `ActionGuard` — so a press during a running
/// Quit is ignored. Cleared on every path that does NOT end the process (Cancel,
/// or a service stop refused for an in-flight action); the exiting paths let the
/// whole flag die with the process.
static QUIT_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// The three outcomes of a Quit press, decided from (mode, running, owns-child)
/// with no dialog and no side effect, so the rule is testable on its own.
#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    /// Nothing to stop of ours: leave immediately, no prompt.
    QuitNow,
    /// App mode with the app's OWN child on the port: one confirm — quit stops it.
    ConfirmStop,
    /// Service mode with a running service: ask stop-and-quit vs quit-and-leave.
    ConfirmServiceChoice,
}

/// The whole decision, pure. `running` means the port answers; `owns_child`
/// means this app has a supervised child it can actually signal. App mode only
/// ever stops its own child, so an app-mode port that answers WITHOUT one (an
/// orphan, a hand-run binary) is not ours to kill and quitting is silent; an
/// app-mode quit never offers "leave it running" because there is no independent
/// service — stopping it or leaving it are the same act when nothing is ours.
pub fn plan(mode: Supervision, running: bool, owns_child: bool) -> Plan {
    if !running {
        return Plan::QuitNow;
    }
    match mode {
        Supervision::Service => Plan::ConfirmServiceChoice,
        Supervision::App if owns_child => Plan::ConfirmStop,
        Supervision::App => Plan::QuitNow,
    }
}

/// Answer a Quit press. The running/mode check runs `status --json` probes, so
/// it happens off the main thread; only the dialog and the final exit return to
/// it. Menu callbacks are on the main thread and would freeze on the probe.
pub fn handle(app: &AppHandle) {
    // Single-flight: take the flag or ignore this press (see the static's note).
    // A panic between the take and the clear/exit cannot wedge it in a shipped
    // build (`[profile.release] panic = "abort"` takes the process, flag, and
    // every later press down together); a `tauri dev` unwind build could, which
    // is acceptable because `boot_probe`/`sup.stop` already run unguarded there.
    if QUIT_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        // `boot_probe` also marks the machine onboarded as a side effect, which
        // is fine: it is idempotent on every `Ready` path and this is a `Ready`
        // machine by the time the answer matters.
        let probe = control::boot_probe(&app.state::<SettingsState>());
        let running = probe.next == control::ProbeStep::Ready;
        let mode = probe.supervision;
        // Only the live supervisor knows what this app can actually stop; the
        // probe's port answer cannot tell our child from a stranger on the port.
        let owns_child = app.state::<Supervisor>().spawner().is_some();
        let action = plan(mode, running, owns_child);
        let target = app.clone();
        // Show the dialog (and, for the no-prompt case, exit) on the main
        // thread: the plugin's callback dialog must not run on a worker, and
        // this is the hop back.
        if app.run_on_main_thread(move || present(target, action)).is_err() {
            // Main thread gone: nothing can present or exit, so release the flag
            // rather than leave every later press ignored.
            QUIT_IN_FLIGHT.store(false, Ordering::SeqCst);
        }
    });
}

/// Present the prompt (or quit outright). Runs on the main thread.
fn present(app: AppHandle, action: Plan) {
    match action {
        Plan::QuitNow => {
            app.exit(0);
        }
        // Only reached when `plan` proved the app owns a child, so the promise
        // to stop it is always true.
        Plan::ConfirmStop => {
            let quitting = app.clone();
            app.dialog()
                .message("Quit Subshell Server? This stops the server it is running.")
                .title("Quit Subshell Server")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::YesNo)
                .show_with_result(move |result| {
                    if result == MessageDialogResult::Yes {
                        stop_child_then_quit(quitting);
                    } else {
                        // No / closed the dialog: no quit happened, so a later
                        // press must be answered.
                        QUIT_IN_FLIGHT.store(false, Ordering::SeqCst);
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
                    MessageDialogResult::Yes => stop_service_then_quit(quitting),
                    // "Just quit": the service is meant to outlive the app, so
                    // exit directly. No stop, no single-flight to release (the
                    // process is leaving).
                    MessageDialogResult::No => quitting.exit(0),
                    // Cancel or a closed dialog: no quit happened, so re-arm.
                    _ => QUIT_IN_FLIGHT.store(false, Ordering::SeqCst),
                });
        }
    }
}

/// Stop the app's OWN child, then quit. `plan` gated this path on a spawner
/// existing, so `spawner()` is the child's own; the stop blocks up to the
/// supervisor's signal bounds, so it runs on a worker and the exit is posted
/// back to the main thread.
fn stop_child_then_quit(app: AppHandle) {
    std::thread::spawn(move || {
        let sup = app.state::<Supervisor>();
        // DELIBERATELY not under `ActionGuard` (the service branch is): a Quit
        // here only ever stops the supervisor's own child through the same idempotent
        // `stop`, so the worst overlap with a supervision chain is two stops racing
        // on one pid in a tiny pid-reuse window — narrower than the unit-file write
        // the service guard exists to protect, and gating the common app-mode Quit
        // behind a lock the assistant usually holds is not worth it.
        // If the child vanished between the press and now, there is nothing of
        // ours to signal. Resolve nothing (a fresh spawner would be a 15-second
        // binary-ladder walk that `wait_until_gone` never touches, since it
        // returns on no-pid before its argument), log, and leave.
        match sup.spawner() {
            Some(spawner) => {
                // A stop that gave up is logged, never treated as permission;
                // here the app leaves regardless and `RunEvent::Exit` re-signals
                // any pid still recorded as the last safety net.
                if !sup.stop(spawner.as_ref()) {
                    eprintln!("subshell: quit with the server still running");
                }
            }
            None => eprintln!("subshell: quit with no server of ours running to stop"),
        }
        let target = app.clone();
        let _ = app.run_on_main_thread(move || target.exit(0));
    });
}

/// Stop the background service, then quit. This shares the assistant's
/// in-flight action lock: a `service stop` racing a setup/supervision chain
/// writing the same unit file is the interleaving `desktop_service` refuses, and
/// `service_now` is the bare runner under it. If the lock is taken, refuse this
/// quit (stay up) rather than interleave or misreport a stop; otherwise run the
/// stop on a worker (the manager call can block) and post the exit back.
fn stop_service_then_quit(app: AppHandle) {
    std::thread::spawn(move || {
        let Some(_guard) = control::ActionGuard::try_new() else {
            eprintln!("subshell: a server action is already running; try Quit again when it finishes");
            QUIT_IN_FLIGHT.store(false, Ordering::SeqCst);
            return;
        };
        let settings = app.state::<SettingsState>();
        let stopped = control::service_now(&settings, ServiceCommand::Stop, false);
        if !stopped.ok {
            // Best effort: the person asked to stop it, we tried and the manager
            // did not confirm. Log, and still leave (the guard drops on exit).
            eprintln!(
                "subshell: quit asked to stop the service but it did not confirm: {}",
                stopped.stderr
            );
        }
        let target = app.clone();
        let _ = app.run_on_main_thread(move || target.exit(0));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole matrix, with no runtime and no dialog: not running always quits
    /// silently; a running SERVICE always asks; a running app asks only when it
    /// owns the child, and quits silently when a stranger holds the port (it
    /// cannot stop what it does not own, so it must not promise to).
    #[test]
    fn the_plan_follows_mode_running_and_ownership() {
        assert_eq!(plan(Supervision::App, false, true), Plan::QuitNow);
        assert_eq!(plan(Supervision::App, false, false), Plan::QuitNow);
        assert_eq!(plan(Supervision::Service, false, true), Plan::QuitNow);
        // Service mode: the choice is about the SERVICE, not an app child.
        assert_eq!(plan(Supervision::Service, true, false), Plan::ConfirmServiceChoice);
        assert_eq!(plan(Supervision::Service, true, true), Plan::ConfirmServiceChoice);
        // App mode: confirm only when the child is ours to stop.
        assert_eq!(plan(Supervision::App, true, true), Plan::ConfirmStop);
        assert_eq!(plan(Supervision::App, true, false), Plan::QuitNow);
    }

    /// The quit id is this app's own and is not a router/action/browser id that
    /// another handler would also claim — the global-menu-event hazard that makes
    /// a shared id fire twice. The other dispatchers are prefix-disjoint
    /// (`native:`/`action:`/`zoom:`/`tray:`); these literals pin the ids that
    /// actually dispatch in `tray::on_menu`.
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
