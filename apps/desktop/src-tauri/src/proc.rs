//! Running `subshell-server` — always with a login PATH, always with a deadline.
//!
//! The CLI's own contract is that every subcommand except `mcp` runs to
//! completion and exits SYNCHRONOUSLY, so these calls are expected to be
//! fast. The timeout is not for them: it is for a host where `systemctl` or
//! `launchctl` itself wedges, which would otherwise hang a GUI with no way out.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::Duration;
use wait_timeout::ChildExt;

use crate::shell_env::login_path;

/// What a finished command left behind.
#[derive(Debug, Clone)]
pub struct Run {
    /// Exit code; `None` when the process was killed by a signal or the deadline.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    /// True when the deadline fired and the child was killed.
    pub timed_out: bool,
}

impl Run {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }
    /// The operator-facing one-liner: stderr first, since that is where the CLI explains itself.
    pub fn detail(&self) -> String {
        let err = self.stderr.trim();
        if !err.is_empty() {
            return err.lines().collect::<Vec<_>>().join(" ");
        }
        let out = self.stdout.trim();
        if !out.is_empty() {
            return out.lines().collect::<Vec<_>>().join(" ");
        }
        if self.timed_out {
            "timed out".to_string()
        } else {
            "no output".to_string()
        }
    }
}

/// Run `argv` with a login PATH and a deadline. Never panics; a spawn failure
/// comes back as a `Run` with no code and the reason in `stderr`.
pub fn run(argv: &[String], timeout: Duration) -> Run {
    let Some((program, args)) = argv.split_first() else {
        return Run { code: None, stdout: String::new(), stderr: "empty command".into(), timed_out: false };
    };
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env("PATH", login_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // A GUI launch has no TTY, which is exactly what the CLI's interactive
    // prompts gate on — so `init`/`configure` take their non-interactive path
    // without us having to ask for it.
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Run { code: None, stdout: String::new(), stderr: format!("spawn failed: {e}"), timed_out: false }
        }
    };
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let (status, timed_out) = match child.wait_timeout(timeout) {
        Ok(Some(s)) => (Some(s), false),
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            (None, true)
        }
        Err(e) => {
            return Run { code: None, stdout: String::new(), stderr: format!("wait failed: {e}"), timed_out: false }
        }
    };
    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(p) = out_pipe.as_mut() {
        let _ = p.read_to_string(&mut stdout);
    }
    if let Some(p) = err_pipe.as_mut() {
        let _ = p.read_to_string(&mut stderr);
    }
    Run { code: status.and_then(|s| s.code()), stdout, stderr, timed_out }
}

/// The deadline for a read-only query (`status`, `service status`).
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(15);
/// The deadline for something that drives the service manager or writes config.
pub const ACTION_TIMEOUT: Duration = Duration::from_secs(90);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_stdout_and_exit_code() {
        let r = run(&["/bin/echo".into(), "hello".into()], QUERY_TIMEOUT);
        assert!(r.ok());
        assert_eq!(r.stdout.trim(), "hello");
        assert!(!r.timed_out);
    }

    #[test]
    fn reports_a_nonzero_exit() {
        let r = run(&["/bin/sh".into(), "-c".into(), "echo boom >&2; exit 3".into()], QUERY_TIMEOUT);
        assert_eq!(r.code, Some(3));
        assert_eq!(r.detail(), "boom");
    }

    // A wedged manager command must not hang the GUI.
    #[test]
    fn kills_on_the_deadline() {
        let r = run(&["/bin/sleep".into(), "5".into()], Duration::from_millis(200));
        assert!(r.timed_out);
        assert_eq!(r.code, None);
    }

    #[test]
    fn a_missing_binary_is_an_error_not_a_panic() {
        let r = run(&["/nonexistent/subshell-server".into()], QUERY_TIMEOUT);
        assert_eq!(r.code, None);
        assert!(r.detail().contains("spawn failed"));
    }

    // Every spawn carries the login PATH, not the GUI's stunted one.
    #[test]
    fn injects_the_login_path() {
        let r = run(&["/bin/sh".into(), "-c".into(), "printf %s \"$PATH\"".into()], QUERY_TIMEOUT);
        assert_eq!(r.stdout, login_path());
    }
}
