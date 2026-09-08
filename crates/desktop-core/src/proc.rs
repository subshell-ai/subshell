//! Running `subshell-server` — always with a login PATH, always with a deadline.
//!
//! The deadline is not for the CLI. Its own contract is that every subcommand
//! except `mcp` runs to completion and exits SYNCHRONOUSLY, so these calls are
//! fast. It is for a host where `systemctl` or `launchctl` itself wedges, or
//! where the chosen binary is not what we think it is — which would otherwise
//! hang a GUI with no way out.
//!
//! **Both pipes are drained on their own threads**, and that is load-bearing
//! rather than tidy. Waiting for exit and reading afterwards is the classic
//! pipe deadlock, and it fails in two directions at once, both measured:
//!
//! - A child writing more than the ~64 KiB pipe buffer BLOCKS on write while
//!   we block on wait, so a command that finishes in 5 ms is killed at the
//!   deadline and reported as a timeout (measured: 128 KiB of stdout turned a
//!   5 ms command into a 3 s "timeout").
//! - A pipe fd is held by every DESCENDANT that inherited it, not just the
//!   child. If the command leaves anything in the background, `wait` returns
//!   at once and the READ blocks for that descendant's whole lifetime — with
//!   the deadline already spent (measured: a 2 s deadline returned after 8 s,
//!   `timed_out: false`).
//!
//! Closing the read ends instead would be worse: the child's next write then
//! takes SIGPIPE, which changes what a killed command reports.

use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
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

    /// A spawn that never started.
    fn spawn_failure(reason: String) -> Self {
        Run {
            code: None,
            stdout: String::new(),
            stderr: reason,
            timed_out: false,
        }
    }
}

/// Run `argv` with a login PATH and a deadline.
///
/// Never panics; a spawn failure comes back as a `Run` with no code and the
/// reason in `stderr`.
pub fn run(argv: &[String], timeout: Duration) -> Run {
    run_with_path(argv, timeout, login_path())
}

/// `run`, with the PATH given explicitly.
///
/// Exists for `shell_env`, which needs a bounded spawn to DISCOVER the login
/// PATH and would otherwise recurse into the very `OnceLock` it is filling.
pub fn run_with_path(argv: &[String], timeout: Duration, path: &str) -> Run {
    let Some((program, args)) = argv.split_first() else {
        return Run::spawn_failure("empty command".into());
    };
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env("PATH", path)
        // A GUI launch has no TTY, which is exactly what the CLI's interactive
        // prompts gate on — so `init`/`configure` take their non-interactive
        // path without us having to ask for it. `null` rather than inherit so
        // a child can never block waiting on a stdin nobody will write to.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match cmd.spawn() {
        Ok(child) => wait_draining(child, timeout),
        Err(e) => Run::spawn_failure(format!("spawn failed: {e}")),
    }
}

/// Drain both pipes concurrently, then wait, then collect.
fn wait_draining(mut child: Child, timeout: Duration) -> Run {
    let started = Instant::now();
    let out_pipe = child.stdout.take();
    let err_pipe = child.stderr.take();
    let out_reader = out_pipe.map(|mut p| {
        thread::spawn(move || {
            let mut buf = String::new();
            let _ = p.read_to_string(&mut buf);
            buf
        })
    });
    let err_reader = err_pipe.map(|mut p| {
        thread::spawn(move || {
            let mut buf = String::new();
            let _ = p.read_to_string(&mut buf);
            buf
        })
    });

    let (code, timed_out) = match child.wait_timeout(timeout) {
        Ok(Some(status)) => (status.code(), false),
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            (None, true)
        }
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Run::spawn_failure(format!("wait failed: {e}"));
        }
    };

    // The readers should finish the moment the last holder of each pipe is
    // gone. A descendant still holding one is exactly the hang this design
    // exists to bound, so give them what is left of the deadline and ABANDON
    // any that overruns — a detached thread blocked on a read costs one thread
    // and no correctness, where joining it would cost the whole GUI.
    let remaining = timeout
        .saturating_sub(started.elapsed())
        .max(Duration::from_millis(250));
    let stdout = join_within(out_reader, remaining);
    let stderr = join_within(err_reader, remaining);
    Run {
        code,
        stdout,
        stderr,
        timed_out,
    }
}

/// Join a reader thread if it finishes within `budget`, else abandon it.
fn join_within(handle: Option<thread::JoinHandle<String>>, budget: Duration) -> String {
    let Some(handle) = handle else { return String::new() };
    let deadline = Instant::now() + budget;
    while !handle.is_finished() {
        if Instant::now() >= deadline {
            return String::new();
        }
        thread::sleep(Duration::from_millis(5));
    }
    handle.join().unwrap_or_default()
}

/// The deadline for a read-only query (`status`, `service status`).
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(15);
/// The deadline for something that drives the service manager or writes config.
pub const ACTION_TIMEOUT: Duration = Duration::from_secs(90);
/// The deadline for probing the environment (login shell, `plutil`, `xattr`).
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

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
        let r = run(
            &["/bin/sh".into(), "-c".into(), "echo boom >&2; exit 3".into()],
            QUERY_TIMEOUT,
        );
        assert_eq!(r.code, Some(3));
        assert_eq!(r.detail(), "boom");
    }

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

    #[test]
    fn injects_the_login_path() {
        let r = run(
            &["/bin/sh".into(), "-c".into(), "printf %s \"$PATH\"".into()],
            QUERY_TIMEOUT,
        );
        assert_eq!(r.stdout, login_path());
    }

    // Measured before the concurrent drain: 128 KiB of stdout turned a 5 ms
    // command into a 3 s "timeout" with the child SIGKILLed mid-write, because
    // it blocked on a full pipe while we blocked on wait.
    #[test]
    fn a_child_larger_than_the_pipe_buffer_is_not_a_timeout() {
        let started = Instant::now();
        let r = run(
            &[
                "/bin/sh".into(),
                "-c".into(),
                "yes abcdefghijklmnopqrstuvwxyz | head -c 262144".into(),
            ],
            Duration::from_secs(10),
        );
        assert!(r.ok(), "should have succeeded, got {:?} / {}", r.code, r.detail());
        assert!(!r.timed_out);
        assert_eq!(r.stdout.len(), 262_144);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "took {:?}",
            started.elapsed()
        );
    }

    // A pipe fd is held by every descendant that inherited it. Before the
    // abandon-on-overrun rule, a 2 s deadline here returned after 8 s with
    // `timed_out: false` — the deadline provably did nothing.
    #[test]
    fn a_backgrounded_descendant_cannot_outlive_the_deadline() {
        let started = Instant::now();
        let r = run(
            &["/bin/sh".into(), "-c".into(), "(sleep 8) & echo started; exit 0".into()],
            Duration::from_millis(600),
        );
        assert_eq!(r.code, Some(0));
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "blocked for {:?}",
            started.elapsed()
        );
    }

    // The shell_env seam: a bounded spawn that does NOT consult login_path(),
    // because it is what discovers it.
    #[test]
    fn run_with_path_uses_the_path_it_is_given() {
        let r = run_with_path(
            &["/bin/sh".into(), "-c".into(), "printf %s \"$PATH\"".into()],
            QUERY_TIMEOUT,
            "/nowhere:/also-nowhere",
        );
        assert_eq!(r.stdout, "/nowhere:/also-nowhere");
    }
}
