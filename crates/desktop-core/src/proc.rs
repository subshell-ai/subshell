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

use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
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

/// A sink for output lines as they arrive, shared by both pipe threads.
pub type LineSink = Arc<dyn Fn(&str) + Send + Sync>;

/// `run`, reporting each output line the moment it arrives.
///
/// For the one command whose WAIT is the user experience: installing tmux is
/// `brew install`, which can run for minutes on a cold cache, and the blocking
/// `run` hands the page nothing until it is over. A screen that cannot say
/// what is happening for ten minutes (`INSTALL_TIMEOUT`) is indistinguishable
/// from one that has hung.
///
/// Everything `run`'s module doc says about draining still applies and is
/// unchanged: both pipes are read on their own threads, the full text is still
/// accumulated into {@link Run}, and a thread that overruns the deadline is
/// abandoned rather than joined. The only difference is that each line is
/// handed to `on_line` on its way into the buffer, so nothing about the
/// failure reporting changes — a caller that ignores the sink gets exactly
/// what `run` gives it.
///
/// `on_line` runs on the READER threads, so it must be cheap and must not
/// block: the emit it is built for is a queue push.
pub fn run_streaming(argv: &[String], timeout: Duration, on_line: LineSink) -> Run {
    let Some((program, args)) = argv.split_first() else {
        return Run::spawn_failure("empty command".into());
    };
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env("PATH", login_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match cmd.spawn() {
        Ok(child) => wait_draining_lines(child, timeout, on_line),
        Err(e) => Run::spawn_failure(format!("spawn failed: {e}")),
    }
}

/// One pipe, read by line, each line handed to `sink` on its way to the buffer.
fn line_reader<R: Read + Send + 'static>(pipe: Option<R>, sink: LineSink) -> Option<thread::JoinHandle<String>> {
    let pipe = pipe?;
    Some(thread::spawn(move || {
        let mut buf = String::new();
        for line in BufReader::new(pipe).lines() {
            // A read error ends this pipe; whatever arrived already is still
            // the caller's, which is why the buffer is returned rather than
            // discarded on the way out.
            let Ok(line) = line else { break };
            sink(&line);
            buf.push_str(&line);
            buf.push('\n');
        }
        buf
    }))
}

/// {@link wait_draining}, reading by LINE and reporting each one.
fn wait_draining_lines(mut child: Child, timeout: Duration, on_line: LineSink) -> Run {
    let started = Instant::now();
    // A generic fn rather than a closure: stdout and stderr are two different
    // types, and a closure's parameter type is inferred from its first call.
    let out_reader = line_reader(child.stdout.take(), Arc::clone(&on_line));
    let err_reader = line_reader(child.stderr.take(), on_line);

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
    let remaining = timeout
        .saturating_sub(started.elapsed())
        .max(Duration::from_millis(250));
    Run {
        code,
        stdout: join_within(out_reader, remaining),
        stderr: join_within(err_reader, remaining),
        timed_out,
    }
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

    /// The streaming variant reports lines AS THEY ARRIVE and still returns
    /// the whole text — the two halves of its contract.
    #[test]
    fn streaming_reports_each_line_and_still_accumulates() {
        use std::sync::Mutex;
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = {
            let seen = Arc::clone(&seen);
            Arc::new(move |line: &str| seen.lock().unwrap().push(line.to_string())) as LineSink
        };
        let argv = vec![
            "sh".to_string(),
            "-c".to_string(),
            "echo one; echo two >&2; echo three".to_string(),
        ];
        let run = run_streaming(&argv, Duration::from_secs(10), sink);
        assert_eq!(run.code, Some(0));
        let mut lines = seen.lock().unwrap().clone();
        lines.sort();
        assert_eq!(lines, vec!["one", "three", "two"], "every line reached the sink");
        // And the buffers are what a non-streaming caller would have got.
        assert!(
            run.stdout.contains("one") && run.stdout.contains("three"),
            "{}",
            run.stdout
        );
        assert_eq!(run.stderr.trim(), "two");
    }

    /// A sink that is never called must not change the outcome: the streaming
    /// path is `run` plus a callback, not a different contract.
    #[test]
    fn streaming_reports_a_failing_command_like_run_does() {
        let sink = Arc::new(|_: &str| {}) as LineSink;
        let argv = vec!["sh".to_string(), "-c".to_string(), "exit 3".to_string()];
        let run = run_streaming(&argv, Duration::from_secs(10), sink);
        assert_eq!(run.code, Some(3));
        assert!(!run.timed_out);
    }

    /// The deadline still bounds it — the whole reason these spawns exist.
    #[test]
    fn streaming_still_times_out() {
        let sink = Arc::new(|_: &str| {}) as LineSink;
        let argv = vec!["sh".to_string(), "-c".to_string(), "sleep 5".to_string()];
        let run = run_streaming(&argv, Duration::from_millis(300), sink);
        assert!(run.timed_out, "the deadline fired");
        assert_eq!(run.code, None);
    }
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
