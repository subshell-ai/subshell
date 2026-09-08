//! Whether hiding a window to the system tray is safe on THIS desktop, right now.
//!
//! macOS always has a menu bar. Linux does not always have a tray: the icon
//! rides the StatusNotifierItem protocol (through libayatana-appindicator), and
//! it is drawn only if some HOST has registered itself with the watcher on the
//! session bus. KDE registers one and so does GNOME *with* the AppIndicator
//! extension; a stock GNOME does not. Where none is registered the icon is
//! SILENTLY INVISIBLE — no error, no event, nothing to detect it by — so a
//! window hidden to it is unreachable and relaunching (single-instance) is the
//! only way back.
//!
//! That is why close-to-tray used to be `cfg!(target_os = "macos")`. The
//! reasoning was sound and the check was too blunt: it also refused the
//! feature to every KDE user, and to every GNOME user who had installed the
//! extension. So the platform check is replaced by the actual question —
//!
//! ```text
//! busctl --user get-property org.kde.StatusNotifierWatcher /StatusNotifierWatcher \
//!   org.kde.StatusNotifierWatcher IsStatusNotifierHostRegistered
//! ```
//!
//! — which prints `b true` or `b false`.
//!
//! **Shelled out, not linked.** Every other conversation these apps have with
//! the OS is a CLI call (`systemctl`, `launchctl`, `plutil`, `dscl`, `xattr`),
//! so a D-Bus crate would be the one exception, and it would cost both apps
//! compile time to ask a single boolean question. `busctl` belongs to
//! `systemd`, which these apps already require on Linux — they write a
//! `systemd --user` unit and drive it with `systemctl --user`. `gdbus` is a
//! FALLBACK for where it happens to be installed and is never depended on:
//! `libwebkit2gtk-4.1-0` pulls in `libglib2.0-0t64` (the library), NOT
//! `libglib2.0-bin` (the tools).
//!
//! **Every failure means "no tray".** No session bus, no watcher, no such
//! tool, a timeout, an answer that is not exactly affirmative — all of them
//! mean the icon may not appear, and the safe answer to "may not appear" is
//! not to hide the window.
//!
//! **This probe is a FALSE NEGATIVE on the older XEmbed tray** — some XFCE and
//! MATE setups — where libayatana-appindicator can still fall back to
//! `GtkStatusIcon` and draw a perfectly visible icon with no StatusNotifier
//! host anywhere on the bus. So the answer is "none was DETECTED", never
//! "there is no tray": both consoles word it that way, and both offer the
//! switch DISABLED with a re-check rather than hiding it, because a user who
//! can see their own tray must not be told it does not exist.
//!
//! **Deliberately not memoized — not even behind a TTL.** A user can install
//! the AppIndicator extension, or log into a different session type, while the
//! app is running, and the whole safety argument rests on the answer being
//! current at the moment the window is about to disappear. Neither caller is a
//! timer (a settings read happens on mount and after an action; the other is
//! the window-close handler), so one `busctl` per call — milliseconds on a
//! healthy bus — buys nothing worth a stale "supported".

use std::time::Duration;

use serde::Serialize;

#[cfg(target_os = "linux")]
use crate::proc::run;
use crate::proc::Run;
#[cfg(target_os = "linux")]
use crate::shell_env::which;

/// The watcher's bus name — and, as it happens, its interface name too.
const WATCHER_SERVICE: &str = "org.kde.StatusNotifierWatcher";
/// The watcher's object path.
const WATCHER_PATH: &str = "/StatusNotifierWatcher";
/// The interface the property lives on. Identical to [`WATCHER_SERVICE`], and
/// named separately because they are two different D-Bus coordinates that only
/// happen to spell the same.
const WATCHER_INTERFACE: &str = "org.kde.StatusNotifierWatcher";
/// The one boolean this module is about: has any host registered to DRAW items?
const HOST_REGISTERED_PROPERTY: &str = "IsStatusNotifierHostRegistered";

/// The primary tool. `systemd`'s, so it is present wherever these apps'
/// `systemctl --user` service management is.
const BUSCTL: &str = "busctl";
/// The fallback tool, used only where it is already installed.
const GDBUS: &str = "gdbus";

/// What an affirmative `busctl get-property` prints for a boolean, verbatim.
const BUSCTL_YES: &str = "b true";
/// What an affirmative `gdbus call … Properties.Get` prints, verbatim.
const GDBUS_YES: &str = "(<true>,)";

/// The deadline for one tray probe.
///
/// Tighter than [`crate::proc::PROBE_TIMEOUT`] because this runs on the
/// WINDOW-CLOSE path, on the main thread: a wedged session bus has to cost a
/// visible pause, never a hung app. `busctl` on a healthy bus answers in
/// single-digit milliseconds.
pub const TRAY_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Whether closing a window to the tray is safe here — and when it is not, why.
///
/// Three states rather than a boolean because the two "no" answers call for
/// different UI: one is a fact about the platform, the other is a fact about
/// this desktop session that a re-check can overturn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TraySupport {
    /// A tray is there: macOS always, Linux with a StatusNotifier host registered.
    Supported,
    /// Linux, with no StatusNotifier host on the session bus.
    ///
    /// Not permanent and not certain — installing GNOME's AppIndicator
    /// extension flips it without a restart, and the XEmbed fallback described
    /// in the module docs can draw an icon this probe cannot see.
    NotDetected,
    /// A platform with no tray at all, where no probe will ever say otherwise.
    Unsupported,
}

impl TraySupport {
    /// Whether hiding a window to the tray is safe.
    pub fn supported(self) -> bool {
        matches!(self, TraySupport::Supported)
    }
}

/// Ask this desktop, fresh. See the module docs for why there is no cache.
pub fn tray_support() -> TraySupport {
    detect()
}

#[cfg(target_os = "macos")]
fn detect() -> TraySupport {
    TraySupport::Supported
}

#[cfg(target_os = "linux")]
fn detect() -> TraySupport {
    probe_status_notifier_host(which, |argv| run(argv, TRAY_PROBE_TIMEOUT))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn detect() -> TraySupport {
    TraySupport::Unsupported
}

/// Whether a stored close-to-tray preference should be honoured HERE.
///
/// The clamp is on READ as well as on write: a settings file is a file. One
/// copied from a machine that had a tray, or written by a build that predates
/// the refusal, would otherwise hide the window into an icon this desktop
/// never draws — and relaunching is then the only way back.
pub fn effective_close_to_tray(stored: bool, support: TraySupport) -> bool {
    stored && support.supported()
}

/// The Linux probe, with both effects injected.
///
/// `locate` finds a tool on the login PATH (so a missing one costs no spawn at
/// all, and so the ABSOLUTE path is what gets executed — `Command`'s own PATH
/// search does not reliably use the `PATH` we hand the child). `spawn` runs
/// one argv. Injected so every failure mode — no bus, no watcher, no tool, a
/// timeout, a garbage answer — is a test rather than a story.
pub fn probe_status_notifier_host(
    locate: impl Fn(&str) -> Option<String>,
    mut spawn: impl FnMut(&[String]) -> Run,
) -> TraySupport {
    if let Some(busctl) = locate(BUSCTL) {
        let answer = spawn(&busctl_argv(&busctl));
        if says_yes(&answer, BUSCTL_YES) {
            return TraySupport::Supported;
        }
        // A `busctl` that RAN and did not say yes has answered the question.
        // Asking a second tool the same property on the same bus cannot know
        // better, and this is on the window-close path — so only a `busctl`
        // that could not be executed at all is worth a fallback.
        if !could_not_run(&answer) {
            return TraySupport::NotDetected;
        }
    }
    if let Some(gdbus) = locate(GDBUS) {
        if says_yes(&spawn(&gdbus_argv(&gdbus)), GDBUS_YES) {
            return TraySupport::Supported;
        }
    }
    TraySupport::NotDetected
}

/// `busctl --user get-property <service> <path> <interface> <property>`.
pub fn busctl_argv(busctl: &str) -> Vec<String> {
    vec![
        busctl.to_string(),
        "--user".to_string(),
        "get-property".to_string(),
        WATCHER_SERVICE.to_string(),
        WATCHER_PATH.to_string(),
        WATCHER_INTERFACE.to_string(),
        HOST_REGISTERED_PROPERTY.to_string(),
    ]
}

/// The same question through glib's tool, for a host that has no `busctl`.
pub fn gdbus_argv(gdbus: &str) -> Vec<String> {
    vec![
        gdbus.to_string(),
        "call".to_string(),
        "--session".to_string(),
        "--dest".to_string(),
        WATCHER_SERVICE.to_string(),
        "--object-path".to_string(),
        WATCHER_PATH.to_string(),
        "--method".to_string(),
        "org.freedesktop.DBus.Properties.Get".to_string(),
        WATCHER_INTERFACE.to_string(),
        HOST_REGISTERED_PROPERTY.to_string(),
    ]
}

/// Strictly affirmative: exit 0, and stdout that is EXACTLY the expected
/// answer once trimmed.
///
/// Strict on purpose. "Not affirmative" is the safe answer, so anything else —
/// a bus-address error on stderr, an `Unknown object` refusal, empty output, a
/// tool whose output format changed — lands there rather than being guessed at.
fn says_yes(answer: &Run, expected: &str) -> bool {
    answer.ok() && answer.stdout.trim() == expected
}

/// A `Run` that never became a process: no exit code, and not our deadline
/// either (a timeout means the tool ran and the BUS did not answer, which is
/// itself an answer).
fn could_not_run(answer: &Run) -> bool {
    answer.code.is_none() && !answer.timed_out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// A fake `Run` for a tool that answered.
    fn answered(code: i32, stdout: &str) -> Run {
        Run {
            code: Some(code),
            stdout: stdout.to_string(),
            stderr: String::new(),
            timed_out: false,
        }
    }

    /// What `proc::run` returns for a binary that could not be executed.
    fn spawn_failed() -> Run {
        Run {
            code: None,
            stdout: String::new(),
            stderr: "spawn failed: No such file or directory (os error 2)".to_string(),
            timed_out: false,
        }
    }

    /// What `proc::run` returns when the deadline fired.
    fn timed_out() -> Run {
        Run {
            code: None,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: true,
        }
    }

    /// Every tool present, each spawn answered from `answers` in order, and
    /// every argv recorded.
    fn probe_with(present: &[&str], answers: Vec<Run>) -> (TraySupport, Vec<Vec<String>>) {
        let present: Vec<String> = present.iter().map(|s| (*s).to_string()).collect();
        let seen = RefCell::new(Vec::new());
        let queue = RefCell::new(answers.into_iter());
        let support = probe_status_notifier_host(
            |name| present.iter().find(|p| *p == name).map(|_| format!("/usr/bin/{name}")),
            |argv| {
                seen.borrow_mut().push(argv.to_vec());
                queue.borrow_mut().next().expect("an unexpected extra spawn")
            },
        );
        (support, seen.into_inner())
    }

    #[test]
    fn a_registered_host_is_the_only_yes() {
        let (support, spawns) = probe_with(&[BUSCTL, GDBUS], vec![answered(0, "b true\n")]);
        assert_eq!(support, TraySupport::Supported);
        // One spawn: an affirmative answer ends the probe.
        assert_eq!(spawns.len(), 1);
    }

    #[test]
    fn no_registered_host_is_a_no() {
        let (support, spawns) = probe_with(&[BUSCTL, GDBUS], vec![answered(0, "b false\n")]);
        assert_eq!(support, TraySupport::NotDetected);
        // `gdbus` is NOT consulted: busctl ran and answered, and this is on
        // the window-close path.
        assert_eq!(spawns.len(), 1);
    }

    // The no-session-bus case, which is what a container and a headless CI box
    // are: `busctl` exits 1 with "Failed to set bus address: $DBUS_SESSION_BUS_ADDRESS
    // and $XDG_RUNTIME_DIR not defined".
    #[test]
    fn a_refusal_is_a_no() {
        let (support, _) = probe_with(&[BUSCTL], vec![answered(1, "")]);
        assert_eq!(support, TraySupport::NotDetected);
    }

    #[test]
    fn an_empty_answer_is_a_no() {
        let (support, _) = probe_with(&[BUSCTL], vec![answered(0, "")]);
        assert_eq!(support, TraySupport::NotDetected);
    }

    #[test]
    fn garbage_is_a_no() {
        for stdout in ["true", "b", "b maybe", "b TRUE", "s \"true\"", "b true b false"] {
            let (support, _) = probe_with(&[BUSCTL], vec![answered(0, stdout)]);
            assert_eq!(support, TraySupport::NotDetected, "accepted {stdout:?}");
        }
    }

    // An affirmative BODY under a non-zero exit is not an affirmative answer.
    #[test]
    fn a_yes_from_a_failed_command_is_a_no() {
        let (support, _) = probe_with(&[BUSCTL], vec![answered(1, "b true")]);
        assert_eq!(support, TraySupport::NotDetected);
    }

    // A wedged bus. The tool ran, so nothing else is asked — and the deadline
    // is what keeps the close handler from hanging.
    #[test]
    fn a_timeout_is_a_no_and_asks_nothing_else() {
        let (support, spawns) = probe_with(&[BUSCTL, GDBUS], vec![timed_out()]);
        assert_eq!(support, TraySupport::NotDetected);
        assert_eq!(spawns.len(), 1);
    }

    #[test]
    fn the_probe_deadline_is_shorter_than_the_general_one() {
        assert!(TRAY_PROBE_TIMEOUT <= crate::proc::PROBE_TIMEOUT);
    }

    // No tool at all: no spawn, and the safe answer.
    #[test]
    fn a_missing_tool_is_a_no_and_costs_no_spawn() {
        let (support, spawns) = probe_with(&[], vec![]);
        assert_eq!(support, TraySupport::NotDetected);
        assert!(spawns.is_empty());
    }

    // `gdbus` is the fallback for a host without `busctl` — never a dependency,
    // so it is only ever reached when it is already installed.
    #[test]
    fn gdbus_answers_where_there_is_no_busctl() {
        let (support, spawns) = probe_with(&[GDBUS], vec![answered(0, "(<true>,)\n")]);
        assert_eq!(support, TraySupport::Supported);
        assert_eq!(spawns.len(), 1);
        assert_eq!(spawns[0][0], "/usr/bin/gdbus");
    }

    #[test]
    fn gdbus_is_parsed_as_strictly_as_busctl() {
        for stdout in ["(<false>,)", "true", "(<true>", ""] {
            let (support, _) = probe_with(&[GDBUS], vec![answered(0, stdout)]);
            assert_eq!(support, TraySupport::NotDetected, "accepted {stdout:?}");
        }
    }

    // A tool that `locate` found and `spawn` could not execute — deleted
    // underneath us, or not executable — is the one case worth a second tool.
    #[test]
    fn a_busctl_that_cannot_run_falls_through_to_gdbus() {
        let (support, spawns) = probe_with(&[BUSCTL, GDBUS], vec![spawn_failed(), answered(0, "(<true>,)")]);
        assert_eq!(support, TraySupport::Supported);
        assert_eq!(spawns.len(), 2);
    }

    // The four D-Bus coordinates, in the order `busctl` takes them. Getting
    // any one of them wrong answers "no tray" on every desktop, forever, with
    // nothing to explain it.
    #[test]
    fn the_probe_asks_for_the_host_registered_property() {
        let argv = busctl_argv("/usr/bin/busctl");
        assert_eq!(
            argv,
            vec![
                "/usr/bin/busctl",
                "--user",
                "get-property",
                "org.kde.StatusNotifierWatcher",
                "/StatusNotifierWatcher",
                "org.kde.StatusNotifierWatcher",
                "IsStatusNotifierHostRegistered",
            ]
        );
        let gdbus = gdbus_argv("/usr/bin/gdbus");
        assert!(gdbus.contains(&"--session".to_string()));
        assert!(gdbus.contains(&"org.freedesktop.DBus.Properties.Get".to_string()));
        assert!(gdbus.contains(&HOST_REGISTERED_PROPERTY.to_string()));
    }

    // The answer is recomputed on every call, which is the whole safety
    // argument: a host that goes away between the setting and the close must
    // change the answer.
    #[test]
    fn the_answer_is_never_reused() {
        let locate = |name: &str| Some(format!("/usr/bin/{name}"));
        let calls = RefCell::new(0);
        let mut spawn = |_: &[String]| {
            *calls.borrow_mut() += 1;
            if *calls.borrow() == 1 {
                answered(0, "b true")
            } else {
                answered(0, "b false")
            }
        };
        assert_eq!(probe_status_notifier_host(locate, &mut spawn), TraySupport::Supported);
        assert_eq!(probe_status_notifier_host(locate, &mut spawn), TraySupport::NotDetected);
    }

    // Nothing in this module may hold the answer between calls — see the
    // module docs. Written as a source scan because a memo added later would
    // pass every other test here.
    #[test]
    fn nothing_in_this_module_memoizes() {
        let source = include_str!("tray.rs");
        for memo in [
            concat!("Once", "Lock"),
            concat!("Once", "Cell"),
            concat!("static", " mut"),
        ] {
            assert!(!source.contains(memo), "this module must not hold state: found {memo}");
        }
    }

    #[test]
    fn a_stored_preference_is_honoured_only_where_the_tray_answered() {
        assert!(effective_close_to_tray(true, TraySupport::Supported));
        assert!(!effective_close_to_tray(true, TraySupport::NotDetected));
        assert!(!effective_close_to_tray(true, TraySupport::Unsupported));
        // And it never invents one.
        assert!(!effective_close_to_tray(false, TraySupport::Supported));
    }

    // The wire strings both consoles branch on.
    #[test]
    fn the_three_states_serialize_kebab_case() {
        let json = |s: TraySupport| serde_json::to_string(&s).unwrap();
        assert_eq!(json(TraySupport::Supported), "\"supported\"");
        assert_eq!(json(TraySupport::NotDetected), "\"not-detected\"");
        assert_eq!(json(TraySupport::Unsupported), "\"unsupported\"");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_always_has_a_menu_bar() {
        assert_eq!(tray_support(), TraySupport::Supported);
    }

    // Runs for real in the Linux container, which has no session bus: the
    // "no bus → no tray" path, end to end, through `busctl` itself. Skipped on
    // a real desktop session, where the honest answer is whatever that
    // session's watcher says.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_linux_session_with_no_bus_detects_nothing() {
        if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some() || std::env::var_os("XDG_RUNTIME_DIR").is_some() {
            return;
        }
        assert_eq!(tray_support(), TraySupport::NotDetected);
        assert!(!effective_close_to_tray(true, tray_support()));
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    #[test]
    fn a_platform_with_no_tray_says_so() {
        assert_eq!(tray_support(), TraySupport::Unsupported);
    }
}
