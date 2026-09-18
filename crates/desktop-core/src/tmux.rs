//! Installing tmux with the platform's own package manager.
//!
//! Both apps need this and for the same reason: tmux is a hard stop on
//! launching a pane at all, so a machine without it cannot run a subshell
//! whether the assistant in front of the user is setting up a control plane or
//! enrolling a node. The decision of WHAT may be executed is here rather than
//! in either app because it is a statement about the machine, not about a
//! window — and because two copies of a table that elevates privileges is
//! exactly the drift worth not having.
//!
//! Never bundled: this runs what a user would have run in a terminal, with
//! their own privileges, and reports the manager's own output verbatim.
//! `apps/server/desktop/ui/src/lib/installers.ts` carries the accounting and
//! owns the same decision for the RENDERING side — the webview cannot look at
//! the machine, so it mirrors this table in prose rather than sharing it, and
//! `the_console_install_table_and_the_rust_one_agree` (in that app's
//! `control.rs`) fails the build when a token this runs is removed or changed
//! in the console copy.

use std::time::Duration;

use crate::proc::{run_streaming, LineSink, Run};

/// A package install is not a probe. `ACTION_TIMEOUT` is sized for a CLI
/// answering a question; fetching and unpacking a package over a slow link
/// routinely takes minutes, and timing that out mid-write is worse than
/// waiting.
pub const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

/// What a caller says when the platform offers nothing this app may drive.
///
/// A constant rather than a literal at the two call sites, because it is the
/// sentence a user reads on a screen that has just refused to do anything.
pub const NO_MANAGER: &str = "no package manager this app can drive";

/// The argv that installs tmux here, or None when no manager we can drive is
/// present.
///
/// Parameterized on `platform` (the `std::env::consts::OS` spelling — "macos",
/// not the "darwin" a webview branches on) and on whether `brew` resolves,
/// rather than reading either inline, PURELY so the table is unit-testable off
/// the host that happens to be running the tests. Every caller passes
/// `std::env::consts::OS` and `shell_env::which("brew").is_some()`, so the
/// behaviour is what it always was.
///
/// `apt-get` is hardcoded because the only Linux artifact either app ships is
/// the `.deb`, so every machine this reaches is Debian-family; the note in
/// `installers.ts` carries the lever if that changes.
pub fn install_argv(platform: &str, has_brew: bool) -> Option<Vec<String>> {
    let argv = match platform {
        // No package manager we can drive without installing one first, and
        // Homebrew is too large a thing to install on someone's behalf from a
        // setup screen. The console shows the MacPorts line instead.
        "macos" => {
            if !has_brew {
                return None;
            }
            vec!["brew", "install", "tmux"]
        }
        // pkexec so the user gets their desktop's own password prompt. A bare
        // sudo spawned from a GUI has no terminal to read a password from and
        // hangs until the timeout.
        "linux" => vec!["pkexec", "apt-get", "install", "-y", "tmux"],
        _ => return None,
    };
    Some(argv.into_iter().map(String::from).collect())
}

/// Run the install, reporting each output line as it arrives.
///
/// STREAMED, unlike almost every other spawn either app makes, because this
/// one's wait IS the user experience: `brew install` on a cold cache runs for
/// minutes under a 10-minute deadline, and a screen that says nothing for that
/// long cannot be told apart from a hung one. The manager's own output is the
/// only real progress signal — there is no percentage to invent. A caller with
/// nothing to show passes a sink that drops the lines; the `Run` it gets back
/// is unchanged either way.
///
/// `Err(NO_MANAGER)` — never a panic — where [`install_argv`] answers `None`:
/// the platform offers nothing this app may drive, and the page says so and
/// shows the command to run by hand instead.
pub fn install(platform: &str, has_brew: bool, on_line: LineSink) -> Result<Run, String> {
    let argv = install_argv(platform, has_brew).ok_or(NO_MANAGER)?;
    Ok(run_streaming(&argv, INSTALL_TIMEOUT, on_line))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brew_exists_uses_brew() {
        assert_eq!(install_argv("macos", true).unwrap()[0..2], ["brew", "install"]);
        assert_eq!(install_argv("macos", true).unwrap()[2], "tmux");
    }

    #[test]
    fn no_brew_on_macos_offers_nothing_runnable() {
        assert_eq!(install_argv("macos", false), None);
    }

    #[test]
    fn linux_uses_pkexec_so_the_desktop_prompts_for_the_password() {
        // MEASURED from the server's own table: Linux is
        // ["pkexec","apt-get","install","-y","tmux"] — pkexec, never a bare
        // sudo, because a sudo spawned from a GUI has no terminal to read a
        // password from and hangs until the timeout. It is RUNNABLE.
        assert_eq!(
            install_argv("linux", false).unwrap(),
            ["pkexec", "apt-get", "install", "-y", "tmux"]
        );
    }

    #[test]
    fn an_unknown_platform_offers_nothing() {
        assert_eq!(install_argv("windows", true), None);
    }

    #[test]
    fn a_platform_with_nothing_to_run_refuses_rather_than_spawning() {
        // The `None` arm must not reach `run_streaming` at all — an empty argv
        // there comes back as a Run that merely FAILED, which reads on a page
        // as "the install went wrong" rather than "this machine has no manager
        // I may drive, here is the command to type".
        let sink: LineSink = std::sync::Arc::new(|_: &str| {});
        assert_eq!(install("windows", true, sink).unwrap_err(), NO_MANAGER);
    }
}
