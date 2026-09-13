//! Running the server as THIS APP'S CHILD, when the operator chose that over a
//! background service (spec 2026-09-12 server-supervision § 4.2).
//!
//! Everything else in this app spawns a CLI, waits a bounded time and reads
//! what it said. This is the one place that starts a process meant to outlive
//! the call — so it is the one place that has to answer the questions a
//! service manager answers, and it answers them the same way on purpose:
//!
//! - **It respawns on any exit, after five seconds.** That is
//!   `Restart=always` + `RestartSec=5` + `StartLimitIntervalSec=0`, which is
//!   what the systemd unit carries. A crash loop stays a loop rather than
//!   parking in `failed`, because a limiter here would hide the EADDRINUSE
//!   case the unit's own comment exists for — and the probe surfaces the last
//!   exit instead. A restart a PERSON asked for skips that wait.
//! - **It signals the MAIN PID and never the process group.** Each local
//!   subshell's tmux server is a child of the server, so a group signal takes
//!   every live pane with it. `KillMode=process` and
//!   `AbandonProcessGroup=true` are the managers' spellings of the same
//!   promise; this is ours, and it is what earns `paneSafety: "keeps"` in the
//!   deployment view.
//! - **It tells the server who is running it**, so the dashboard can say so
//!   and keep its Restart button working (`SUBSHELL_SUPERVISOR*`, verified
//!   against the server's own parent — `services/server-deployment.ts`).
//!
//! **The loop OWNS its child; nothing else ever holds one.** An earlier
//! revision kept the `Child` in a shared mutex so `stop` could escalate to
//! SIGKILL — and then took it OUT of that mutex for the whole of `wait()`,
//! which is every instant that matters. `stop` therefore always found the
//! slot empty, returned on its first branch, and the entire reap-and-escalate
//! block was unreachable: a SIGTERM and a hope, under a comment claiming it
//! blocked. Escalation is a second bounded `kill` spawn instead (still the
//! pid alone, so the promise above is kept), and waiting is a condvar the
//! reaping thread signals — which is the only arrangement where "the loop
//! owns the child" and "stop blocks until it is gone" are both true.
//!
//! It lives here rather than in `crates/desktop-core` because there is
//! exactly one consumer: Subshell Client's node agent has its own service and
//! no equivalent mode. That is the crate's own rule — an abstraction designed
//! against one real consumer and one guess costs more than the duplication it
//! removes.

use std::io;
use std::path::PathBuf;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime};

/// The gap before a respawn — `RestartSec=5`, deliberately the same number.
pub const RESPAWN_DELAY: Duration = Duration::from_secs(5);

/// How long a `stop` waits for SIGTERM to be honoured before SIGKILL.
///
/// The server closes sockets and exits promptly; this is the budget for one
/// that is wedged rather than the expected shutdown time.
pub const STOP_BOUND: Duration = Duration::from_secs(10);

/// How long SIGKILL gets after that. Not instantaneous either, and a caller
/// blocked forever on an unkillable process is worse than one told it gave up.
const KILL_BOUND: Duration = Duration::from_secs(2);

/// How the last child ended, for the recovery screen's own sentence.
#[derive(Debug, Clone)]
pub struct LastExit {
    /// Exit code, `None` when a signal ended it.
    pub code: Option<i32>,
    pub at: SystemTime,
    /// Whether the app ASKED for this exit. A stop is not a crash.
    pub requested: bool,
    /// Set when the child never STARTED, carrying the reason.
    ///
    /// Distinct from an exit because the commonest cause — a binary that is
    /// missing or not executable — is a different problem from a server that
    /// ran and died, and reporting it as "stopped unexpectedly" sends the
    /// reader to diagnose the wrong thing.
    pub spawn_error: Option<String>,
}

/// What the supervisor is doing right now.
///
/// Deliberately only what a CALLER uses. "Is it meant to be running" and "how
/// long has it been up" were both here and read by nothing: the probe answers
/// the first from the port, which is the fact that matters.
#[derive(Debug, Clone)]
pub struct Snapshot {
    /// The live child's pid, `None` when nothing is running.
    pub pid: Option<u32>,
    /// How the last child ended, `None` when none has.
    pub last_exit: Option<LastExit>,
}

/// A spawned process the supervisor can wait on.
///
/// A trait so the state machine is testable with no processes and no real
/// time: every behaviour worth pinning here is about ORDER, and a test that
/// actually spawned would be pinning the OS instead.
pub trait ChildHandle: Send {
    fn id(&self) -> u32;
    fn wait(&mut self) -> io::Result<ExitStatus>;
}

/// How a child is created, and how it is asked — then made — to stop.
pub trait Spawner: Send + Sync {
    fn spawn(&self) -> io::Result<Box<dyn ChildHandle>>;
    /// Ask this pid to exit — SIGTERM to the PROCESS, never the group.
    fn terminate(&self, pid: u32);
    /// Make it exit — SIGKILL, and again the process alone.
    fn kill(&self, pid: u32);
}

/// The real thing: `subshell-server` with a login PATH, the config dir as cwd,
/// and its console output collected into one file.
pub struct ServerSpawner {
    /// The resolved server argv — the binary alone, so the bare invocation
    /// takes the CLI's boot path.
    pub argv: Vec<String>,
    /// `WorkingDirectory`, for the same reason the unit and plist set one: a
    /// relative `DATABASE_PATH` and bun's cwd-based `.env` lookup both resolve
    /// against it, and a GUI's cwd is not the config home.
    pub cwd: PathBuf,
    /// Where stdout and stderr go, truncated on each spawn.
    pub console_log: PathBuf,
    /// This process's pid, which the server checks the supervisor claim against.
    pub own_pid: u32,
}

impl ServerSpawner {
    /// Create (or truncate) the console log at 0600 inside a 0700 directory.
    ///
    /// The modes are the point rather than a detail: this file holds the
    /// server's raw stdout and stderr, which is the same class of content as
    /// the pane logs and `server.log` — both of which this project writes
    /// 0600 in a 0700 directory and treats as load-bearing
    /// (`.claude/rules/security-context.md`). A bare `File::create` takes the
    /// umask's answer, which on a shared machine is world-readable.
    fn open_console_log(&self) -> io::Result<std::fs::File> {
        if let Some(dir) = self.console_log.parent() {
            let mut builder = std::fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            // An existing directory is not an error, and a real failure
            // surfaces from the open below with its own path in the message.
            let _ = builder.create(dir);
        }
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        opts.open(&self.console_log)
    }

    /// One bounded `kill(1)` spawn — the same call this app already makes for
    /// `hostname`, rather than taking on a `libc` dependency. The argument is
    /// a pid we printed ourselves, never anything from a page.
    ///
    /// **The pid ALONE.** A negative argument would signal the process GROUP,
    /// which is every subshell's tmux server as well, and losing a person's
    /// live panes because they quit a window is the exact failure
    /// `KillMode=process` exists to prevent.
    fn signal(&self, sig: &str, pid: u32) {
        let argv = vec!["kill".to_string(), sig.to_string(), pid.to_string()];
        let _ = subshell_desktop_core::proc::run(&argv, Duration::from_secs(2));
    }
}

impl Spawner for ServerSpawner {
    fn spawn(&self) -> io::Result<Box<dyn ChildHandle>> {
        let Some((program, args)) = self.argv.split_first() else {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty server argv"));
        };
        // TRUNCATED per spawn, not appended: this is the last run's console
        // output, which is the thing worth reading after a crash, and it is
        // bounded by construction. The server's own structured log is the
        // capped one and is a different file.
        // Opened (and truncated) only once the program resolves: a spawn that
        // fails would otherwise throw away the previous run's output, which
        // on a crash loop is the only record of why the last one died.
        let out = self.open_console_log()?;
        let err = out.try_clone()?;
        let child = Command::new(program)
            .args(args)
            .current_dir(&self.cwd)
            .env("PATH", subshell_desktop_core::shell_env::login_path())
            .env("SUBSHELL_SUPERVISOR", "subshell-desktop-server")
            .env("SUBSHELL_SUPERVISOR_PID", self.own_pid.to_string())
            .env("SUBSHELL_SUPERVISOR_LOG", &self.console_log)
            .stdin(Stdio::null())
            .stdout(Stdio::from(out))
            .stderr(Stdio::from(err))
            .spawn()?;
        Ok(Box::new(RealChild(child)))
    }

    fn terminate(&self, pid: u32) {
        self.signal("-TERM", pid);
    }

    fn kill(&self, pid: u32) {
        self.signal("-KILL", pid);
    }
}

struct RealChild(std::process::Child);

impl ChildHandle for RealChild {
    fn id(&self) -> u32 {
        self.0.id()
    }
    fn wait(&mut self) -> io::Result<ExitStatus> {
        self.0.wait()
    }
}

/// Everything one supervisor thread and every caller agree about, under ONE
/// mutex — including whether a loop exists.
///
/// `loop_running` was an `AtomicBool` outside the lock, and that was a
/// check-then-act across two independent words: a `start()` landing between
/// the loop deciding to break and its store of `false` swapped `true`, did
/// nothing, and left a machine with `desired_running` set and no loop — while
/// telling the caller it had started.
#[derive(Default)]
struct State {
    desired_running: bool,
    /// True while a spawn loop exists. Decided in the same critical section
    /// that sets `desired_running`, so the two cannot disagree.
    loop_running: bool,
    pid: Option<u32>,
    last_exit: Option<LastExit>,
    /// Set while a `restart` is in flight, so the loop skips the delay once.
    immediate: bool,
    /// Set by `stop`/`restart`, so the exit they produce is recorded as
    /// asked-for rather than reported to the user as a crash.
    stopping: bool,
}

struct Shared {
    state: Mutex<State>,
    /// Signalled whenever `pid` or `desired_running` changes — which is what
    /// makes `stop` a real wait and the respawn delay interruptible.
    changed: Condvar,
    /// The spawner the loop re-reads on EVERY iteration.
    ///
    /// Held rather than moved into the thread because the argv it carries can
    /// change under a running loop: `desktop_set_server_bin` points at a
    /// different binary, or an install puts the managed copy on a rung that
    /// was not the one resolved at boot. A loop holding the first `Arc`
    /// forever would respawn the old path indefinitely, with nothing in the
    /// UI implying that a full stop and start was needed.
    ///
    /// It is also what lets `RunEvent::Exit` stop the child without building
    /// a spawner — which on that path means without resolving a binary ladder
    /// and a `status --json` on the main thread.
    spawner: Mutex<Option<Arc<dyn Spawner>>>,
}

/// Owns at most one server process.
pub struct Supervisor {
    inner: Arc<Shared>,
    /// How long to wait before respawning after an exit, and how long a stop
    /// waits before escalating. Fields rather than the constants so a test can
    /// pin "it waited" and "it did not" without spending real seconds.
    respawn_delay: Duration,
    stop_bound: Duration,
}

impl Default for Supervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl Supervisor {
    pub fn new() -> Self {
        Supervisor::with_timings(RESPAWN_DELAY, STOP_BOUND)
    }

    /// @internal — for tests, which must not spend fifteen real seconds.
    pub fn with_timings(respawn_delay: Duration, stop_bound: Duration) -> Self {
        Supervisor {
            inner: Arc::new(Shared {
                state: Mutex::new(State::default()),
                changed: Condvar::new(),
                spawner: Mutex::new(None),
            }),
            respawn_delay,
            stop_bound,
        }
    }

    /// The spawner this supervisor last started with, if any.
    ///
    /// `RunEvent::Exit` uses it rather than building one: see the field's own
    /// note for what building one costs on that path.
    pub fn spawner(&self) -> Option<Arc<dyn Spawner>> {
        self.inner.spawner.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Start the server, or do nothing if it is already up. Idempotent.
    ///
    /// A `start` on a LIVE loop still refreshes the spawner, so a binary
    /// chosen or installed since the loop began is what the next respawn
    /// runs.
    pub fn start(&self, spawner: Arc<dyn Spawner>) {
        *self.inner.spawner.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::clone(&spawner));
        let needs_loop = {
            let mut st = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            st.desired_running = true;
            st.stopping = false;
            // A `restart` that found nothing to stop leaves this set; clearing
            // it here stops that borrowed urgency being spent on the NEXT
            // crash, which would silently skip one backoff.
            st.immediate = false;
            // ONE critical section decides both, so a loop on its way out
            // cannot swallow a start and leave nothing running.
            let start_one = !st.loop_running;
            if start_one {
                st.loop_running = true;
            }
            start_one
        };
        self.inner.changed.notify_all();
        if needs_loop {
            self.spawn_loop(spawner);
        }
    }

    /// Stop the server and keep it stopped.
    ///
    /// **Blocks until the child is gone, or the bound expires**, escalating to
    /// SIGKILL once on the way. Callers depend on exactly that: `RunEvent::Exit`
    /// must not leave a server holding the port, and the reset chain must not
    /// begin deleting a database a live process is still writing to.
    /// Returns whether the child is actually GONE. `false` means it outlived
    /// both signals and both bounds — and a caller about to delete the data
    /// that process writes to must treat that as a refusal, not a shrug.
    #[must_use]
    pub fn stop(&self, spawner: &dyn Spawner) -> bool {
        {
            let mut st = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            st.desired_running = false;
            st.stopping = true;
        }
        // Wakes a loop sitting out its respawn delay, so a stop during that
        // window takes effect now rather than up to five seconds later.
        self.inner.changed.notify_all();
        self.wait_until_gone(spawner)
    }

    /// Stop and start again, without the respawn delay.
    ///
    /// The delay is right for a crash — the server may be crash-looping on a
    /// busy port — and wrong for a restart a person asked for, where it is
    /// five seconds of nothing happening.
    /// Returns whether the old child was gone before the new one was asked
    /// for. `false` means two servers may briefly contend for the port.
    #[must_use]
    pub fn restart(&self, spawner: Arc<dyn Spawner>) -> bool {
        {
            let mut st = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            st.immediate = true;
            st.desired_running = true;
            st.stopping = true;
        }
        self.inner.changed.notify_all();
        let gone = self.wait_until_gone(spawner.as_ref());
        // `start` is idempotent against a live loop, and it is what makes a
        // restart work when there is NO loop — after a stop, or after one
        // gave up. Without it `restart` set two flags, woke nobody, and
        // reported success having started nothing.
        self.start(spawner);
        gone
    }

    /// What is running, for the probe.
    pub fn snapshot(&self) -> Snapshot {
        let st = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        Snapshot {
            pid: st.pid,
            last_exit: st.last_exit.clone(),
        }
    }

    /// The live child's pid.
    pub fn pid(&self) -> Option<u32> {
        self.inner.state.lock().unwrap_or_else(|e| e.into_inner()).pid
    }

    /// SIGTERM, wait out the bound on the condvar, then SIGKILL once.
    ///
    /// It waits on a FACT the reaping thread publishes rather than polling a
    /// handle it does not own — which is what the previous revision got
    /// wrong, silently.
    fn wait_until_gone(&self, spawner: &dyn Spawner) -> bool {
        let Some(pid) = self.pid() else { return true };
        spawner.terminate(pid);
        let deadline = Instant::now() + self.stop_bound;
        let mut st = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        while st.pid == Some(pid) {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            let (next, _) = self
                .inner
                .changed
                .wait_timeout(st, left)
                .unwrap_or_else(|e| e.into_inner());
            st = next;
        }
        if st.pid != Some(pid) {
            return true;
        }
        // A server that ignored SIGTERM for the whole bound is wedged, and
        // leaving it holding the port would make every later start fail on
        // EADDRINUSE.
        drop(st);
        spawner.kill(pid);
        let kill_deadline = Instant::now() + KILL_BOUND;
        let mut st = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        while st.pid == Some(pid) {
            let left = kill_deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                // Unkillable from here — uninterruptible sleep, or no longer
                // ours. Returning beats blocking a quit forever.
                // NOT a success. Callers delete databases on this answer.
                eprintln!("subshell: server pid {pid} did not exit; no longer waiting for it");
                return false;
            }
            let (next, _) = self
                .inner
                .changed
                .wait_timeout(st, left)
                .unwrap_or_else(|e| e.into_inner());
            st = next;
        }
        true
    }

    fn spawn_loop(&self, spawner: Arc<dyn Spawner>) {
        let shared = Arc::clone(&self.inner);
        let delay = self.respawn_delay;
        let failed = Arc::clone(&self.inner);
        if std::thread::Builder::new()
            .name("subshell-supervisor".into())
            .spawn(move || {
                loop {
                    // Deciding to leave and RECORDING that we left happen together
                    // — see `leave_if_done`. Split across two critical sections
                    // (which is what this was), a `start()` landing between them
                    // sets `desired_running`, sees `loop_running` still true, and
                    // declines to spawn; the loop then clears the flag and exits,
                    // leaving a machine that wants a server, has no loop, and was
                    // told it started one.
                    if leave_if_done(&shared) {
                        return;
                    }
                    // Re-read every iteration: the binary this should run can
                    // change under a live loop (see `Shared::spawner`).
                    let spawner = shared
                        .spawner
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .clone()
                        .unwrap_or_else(|| Arc::clone(&spawner));
                    let mut child = match spawner.spawn() {
                        Ok(c) => c,
                        Err(err) => {
                            eprintln!("subshell: could not start the server: {err}");
                            // A failed spawn is an exit: the same rhythm, so a
                            // transient cause (a binary mid-install, a log
                            // directory that just became writable) recovers with
                            // nobody pressing anything.
                            record_exit(&shared, None, Some(err.to_string()));
                            if !wait_to_respawn(&shared, delay) {
                                return;
                            }
                            continue;
                        }
                    };
                    {
                        let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                        st.pid = Some(child.id());
                    }
                    shared.changed.notify_all();
                    // OWNED here for the whole wait. Nothing else holds a handle,
                    // so nothing else can be blocked by this — and `stop` waits on
                    // the state this thread publishes instead.
                    let status = child.wait();
                    record_exit(&shared, status.as_ref().ok().and_then(|s| s.code()), None);
                    if !wait_to_respawn(&shared, delay) {
                        return;
                    }
                }
            })
            .is_err()
        {
            // Without this the flag stays true with no thread behind it, and
            // every later `start()` is a silent no-op for the life of the
            // process.
            eprintln!("subshell: could not start the supervisor thread");
            let mut st = failed.state.lock().unwrap_or_else(|e| e.into_inner());
            st.loop_running = false;
        }
    }
}

/// Leave the loop if nothing wants it any more, clearing `loop_running` in
/// the SAME critical section as the decision.
///
/// That togetherness is the whole point: a `start()` that lands between a
/// separate decision and a separate store is swallowed, and the machine ends
/// up wanting a server with no loop to spawn one.
fn leave_if_done(shared: &Arc<Shared>) -> bool {
    let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if st.desired_running {
        return false;
    }
    st.loop_running = false;
    drop(st);
    shared.changed.notify_all();
    true
}

/// Record how a child ended and publish that it is gone.
fn record_exit(shared: &Arc<Shared>, code: Option<i32>, spawn_error: Option<String>) {
    {
        let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        st.pid = None;
        st.last_exit = Some(LastExit {
            code,
            spawn_error,
            at: SystemTime::now(),
            // An exit the app asked for is not a crash, and the recovery
            // screen must not call it one.
            requested: st.stopping,
        });
    }
    shared.changed.notify_all();
}

/// Wait out the respawn delay unless the caller asked for an immediate one, or
/// asked to stop. Returns whether the loop should spawn again.
///
/// A condvar wait rather than a sleep, so `stop` and `restart` take effect at
/// once instead of up to `RESPAWN_DELAY` later.
fn wait_to_respawn(shared: &Arc<Shared>, delay: Duration) -> bool {
    let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if !st.desired_running {
        st.loop_running = false;
        drop(st);
        shared.changed.notify_all();
        return false;
    }
    if std::mem::replace(&mut st.immediate, false) {
        return true;
    }
    let deadline = Instant::now() + delay;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return st.desired_running;
        }
        let (next, _) = shared.changed.wait_timeout(st, left).unwrap_or_else(|e| e.into_inner());
        st = next;
        if !st.desired_running {
            return false;
        }
        // A restart arriving mid-delay is the interruption this wait exists
        // for: take it now rather than at the end of a wait nobody wants.
        if std::mem::replace(&mut st.immediate, false) {
            return true;
        }
    }
}

/// One sentence about the last exit, for the recovery screen.
///
/// `None` when nothing has exited, when the app ASKED for it, and when it is
/// old news. A server the user stopped is not a problem to report, and a
/// crash an hour ago on a machine that has been fine since is history rather
/// than a diagnosis — reporting either turns the crash-loop signal this
/// exists for into noise.
pub fn last_exit_sentence(last: Option<LastExit>, now: SystemTime, within: Duration) -> Option<String> {
    let last = last?;
    if last.requested {
        return None;
    }
    let since = now.duration_since(last.at).ok()?;
    if since > within {
        return None;
    }
    let ago = since.as_secs();
    let when = if ago <= 1 {
        "just now".to_string()
    } else {
        format!("{ago} seconds ago")
    };
    if let Some(why) = last.spawn_error {
        return Some(format!("subshell-server could not start {when}: {why}"));
    }
    Some(match last.code {
        // Exit 0 that nobody asked for is still unexpected — the server chose
        // to leave — but it is not a crash, and "code 0" would read as one.
        Some(0) => format!("subshell-server exited {when}"),
        Some(code) => format!("subshell-server exited with code {code} {when}"),
        None => format!("subshell-server stopped unexpectedly {when}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::mpsc;

    /// A child that exits only when its flag is set — so a test can model a
    /// server that IGNORES SIGTERM, which is the case the escalation exists
    /// for and the one the previous fake could not express.
    struct FakeChild {
        id: u32,
        exited: Arc<AtomicBool>,
        code: i32,
    }

    impl ChildHandle for FakeChild {
        fn id(&self) -> u32 {
            self.id
        }
        fn wait(&mut self) -> io::Result<ExitStatus> {
            while !self.exited.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(1));
            }
            Ok(status_with(self.code))
        }
    }

    fn status_with(code: i32) -> ExitStatus {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            ExitStatus::from_raw(code << 8)
        }
        #[cfg(not(unix))]
        {
            let _ = code;
            unimplemented!("this app ships linux-x64 and darwin-arm64 only")
        }
    }

    struct FakeSpawner {
        spawns: Mutex<Vec<u32>>,
        /// Each spawned child's exit flag, BY PID — so a signal reaches the
        /// child it names rather than whichever was spawned last.
        live: Mutex<HashMap<u32, Arc<AtomicBool>>>,
        signals: Mutex<Vec<(String, u32)>>,
        /// When false, SIGTERM is ignored: a wedged server.
        honours_term: AtomicBool,
        next: AtomicU32,
        tx: mpsc::Sender<u32>,
    }

    impl Spawner for FakeSpawner {
        fn spawn(&self) -> io::Result<Box<dyn ChildHandle>> {
            let id = self.next.fetch_add(1, Ordering::SeqCst);
            let exited = Arc::new(AtomicBool::new(false));
            self.spawns.lock().unwrap().push(id);
            self.live.lock().unwrap().insert(id, Arc::clone(&exited));
            let _ = self.tx.send(id);
            Ok(Box::new(FakeChild { id, exited, code: 1 }))
        }
        fn terminate(&self, pid: u32) {
            self.signals.lock().unwrap().push(("-TERM".into(), pid));
            if self.honours_term.load(Ordering::SeqCst) {
                self.end(pid);
            }
        }
        fn kill(&self, pid: u32) {
            self.signals.lock().unwrap().push(("-KILL".into(), pid));
            // SIGKILL is not refusable, and the fake must not pretend it is.
            self.end(pid);
        }
    }

    impl FakeSpawner {
        fn end(&self, pid: u32) {
            if let Some(flag) = self.live.lock().unwrap().get(&pid) {
                flag.store(true, Ordering::SeqCst);
            }
        }
        /// End a child the way a crash would — without anyone asking.
        fn crash(&self, pid: u32) {
            self.end(pid);
        }
        fn signalled(&self) -> Vec<(String, u32)> {
            self.signals.lock().unwrap().clone()
        }
        fn spawn_count(&self) -> usize {
            self.spawns.lock().unwrap().len()
        }
    }

    fn harness() -> (Arc<FakeSpawner>, mpsc::Receiver<u32>) {
        let (tx, rx) = mpsc::channel();
        (
            Arc::new(FakeSpawner {
                spawns: Mutex::new(Vec::new()),
                live: Mutex::new(HashMap::new()),
                signals: Mutex::new(Vec::new()),
                honours_term: AtomicBool::new(true),
                next: AtomicU32::new(100),
                tx,
            }),
            rx,
        )
    }

    /// Wait for the loop to reach its next spawn, or fail rather than hang.
    fn next_spawn(rx: &mpsc::Receiver<u32>) -> u32 {
        rx.recv_timeout(Duration::from_secs(5)).expect("a spawn")
    }

    /// Timings a test can afford, with the same SHAPE as the real ones.
    fn quick() -> Supervisor {
        Supervisor::with_timings(Duration::from_millis(40), Duration::from_millis(120))
    }

    #[test]
    fn start_is_idempotent() {
        let (spawner, rx) = harness();
        let sup = quick();
        sup.start(Arc::clone(&spawner) as Arc<dyn Spawner>);
        next_spawn(&rx);
        sup.start(Arc::clone(&spawner) as Arc<dyn Spawner>);
        std::thread::sleep(Duration::from_millis(20));
        // One server, not two racing for the port.
        assert_eq!(spawner.spawn_count(), 1);
        assert!(sup.stop(spawner.as_ref()));
    }

    /// The unit's `Restart=always`, as behaviour.
    #[test]
    fn a_crash_respawns() {
        let (spawner, rx) = harness();
        let sup = quick();
        sup.start(Arc::clone(&spawner) as Arc<dyn Spawner>);
        let first = next_spawn(&rx);
        spawner.crash(first);
        next_spawn(&rx);
        assert_eq!(spawner.spawn_count(), 2);
        // Nothing was signalled: it died on its own.
        assert_eq!(spawner.signalled(), vec![]);
        assert!(sup.stop(spawner.as_ref()));
    }

    /// **The contract this module exists to keep**, and the one the previous
    /// revision silently broke: `stop` returns only once the child is GONE.
    #[test]
    fn stop_blocks_until_the_child_is_actually_gone() {
        let (spawner, rx) = harness();
        let sup = quick();
        sup.start(Arc::clone(&spawner) as Arc<dyn Spawner>);
        let pid = next_spawn(&rx);
        assert!(sup.stop(spawner.as_ref()));
        // Not "a signal was sent" — GONE. `RunEvent::Exit` and the reset
        // chain both proceed on this being true.
        assert_eq!(sup.pid(), None);
        assert_eq!(spawner.signalled(), vec![("-TERM".to_string(), pid)]);
        std::thread::sleep(Duration::from_millis(80));
        assert_eq!(spawner.spawn_count(), 1, "a stop stays stopped");
    }

    /// A server that ignores SIGTERM gets SIGKILL — the case the escalation
    /// was written for, which the old fake could not express because it
    /// exited the child synchronously inside `terminate`.
    #[test]
    fn a_wedged_server_is_killed_and_every_signal_names_the_pid_alone() {
        let (spawner, rx) = harness();
        spawner.honours_term.store(false, Ordering::SeqCst);
        let sup = quick();
        sup.start(Arc::clone(&spawner) as Arc<dyn Spawner>);
        let pid = next_spawn(&rx);

        let started = Instant::now();
        assert!(sup.stop(spawner.as_ref()));
        // It waited out the bound before escalating, rather than killing at once.
        assert!(
            started.elapsed() >= Duration::from_millis(120),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(sup.pid(), None, "and it is gone afterwards");

        let signals = spawner.signalled();
        assert_eq!(signals, vec![("-TERM".to_string(), pid), ("-KILL".to_string(), pid)]);
        // Every signal names the pid ALONE. A negative argument here is the
        // process GROUP, which is every live subshell's tmux server.
        for (_, target) in signals {
            assert_eq!(target, pid);
        }
    }

    /// A restart after a stop must actually start something. The previous
    /// revision set two flags, woke nobody, and reported success.
    #[test]
    fn restart_works_when_no_loop_is_left() {
        let (spawner, rx) = harness();
        let sup = quick();
        sup.start(Arc::clone(&spawner) as Arc<dyn Spawner>);
        next_spawn(&rx);
        assert!(sup.stop(spawner.as_ref()));
        assert_eq!(spawner.spawn_count(), 1);

        assert!(
            sup.restart(Arc::clone(&spawner) as Arc<dyn Spawner>),
            "restart reported it got the old one down"
        );
        next_spawn(&rx);
        assert_eq!(spawner.spawn_count(), 2, "restart started a server again");
        assert!(sup.pid().is_some());
        assert!(sup.stop(spawner.as_ref()));
    }

    #[test]
    fn restart_comes_back_without_waiting_out_the_delay() {
        let (spawner, rx) = harness();
        // A delay long enough that waiting it out would be unmistakable.
        let sup = Supervisor::with_timings(Duration::from_secs(30), Duration::from_millis(120));
        sup.start(Arc::clone(&spawner) as Arc<dyn Spawner>);
        next_spawn(&rx);

        let started = Instant::now();
        assert!(sup.restart(Arc::clone(&spawner) as Arc<dyn Spawner>));
        next_spawn(&rx);
        // Five seconds of nothing is right for a crash and wrong for a button.
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
        assert_eq!(spawner.spawn_count(), 2);
        assert!(sup.stop(spawner.as_ref()));
    }

    /// A stop during the respawn window must take effect now, not at the end
    /// of a wait nobody wants.
    #[test]
    fn a_stop_interrupts_the_respawn_delay() {
        let (spawner, rx) = harness();
        let sup = Supervisor::with_timings(Duration::from_secs(30), Duration::from_millis(120));
        sup.start(Arc::clone(&spawner) as Arc<dyn Spawner>);
        let pid = next_spawn(&rx);
        spawner.crash(pid);
        // Let the loop reach its delay.
        std::thread::sleep(Duration::from_millis(50));

        let started = Instant::now();
        assert!(sup.stop(spawner.as_ref()));
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(spawner.spawn_count(), 1, "and it did not come back");
    }

    #[test]
    fn the_snapshot_records_how_the_last_child_ended() {
        let (spawner, rx) = harness();
        let sup = quick();
        sup.start(Arc::clone(&spawner) as Arc<dyn Spawner>);
        let pid = next_spawn(&rx);
        assert_eq!(sup.pid(), Some(pid));
        spawner.crash(pid);
        next_spawn(&rx);
        let last = sup.snapshot().last_exit.expect("an exit was recorded");
        assert_eq!(last.code, Some(1));
        assert!(!last.requested, "a crash is not asked-for");
        assert_eq!(last.spawn_error, None, "it started fine; it died after");
        assert!(sup.stop(spawner.as_ref()));
    }

    #[test]
    fn a_stop_is_recorded_as_asked_for() {
        let (spawner, rx) = harness();
        let sup = quick();
        sup.start(Arc::clone(&spawner) as Arc<dyn Spawner>);
        next_spawn(&rx);
        assert!(sup.stop(spawner.as_ref()));
        let last = sup.snapshot().last_exit.expect("an exit");
        assert!(last.requested);
        // ...which is what keeps the recovery screen from calling the app's
        // own SIGTERM an unexpected stop.
        assert_eq!(last_exit_sentence(Some(last), SystemTime::now(), RESPAWN_DELAY), None);
    }

    #[test]
    fn the_exit_sentence_speaks_only_of_a_recent_unasked_exit() {
        let now = SystemTime::now();
        let recent = LastExit {
            code: Some(1),
            at: now - Duration::from_secs(3),
            requested: false,
            spawn_error: None,
        };
        let line = last_exit_sentence(Some(recent.clone()), now, RESPAWN_DELAY).unwrap();
        assert!(line.contains("code 1"), "{line}");
        assert!(line.contains("3 seconds ago"), "{line}");

        // Stale: a crash an hour ago on a machine fine since is history, and
        // reporting it would make the crash-loop signal noise.
        let old = LastExit {
            at: now - Duration::from_secs(3600),
            ..recent.clone()
        };
        assert_eq!(last_exit_sentence(Some(old), now, RESPAWN_DELAY), None);

        // Asked for: never an error, however recent.
        let asked = LastExit {
            requested: true,
            ..recent.clone()
        };
        assert_eq!(last_exit_sentence(Some(asked), now, RESPAWN_DELAY), None);

        // A signal death has no code and must not print one.
        let signalled = LastExit {
            code: None,
            ..recent.clone()
        };
        assert!(last_exit_sentence(Some(signalled), now, RESPAWN_DELAY)
            .unwrap()
            .contains("stopped unexpectedly"));

        // Exit 0 nobody asked for: unexpected, but not a crash.
        let clean = LastExit {
            code: Some(0),
            ..recent
        };
        let clean_line = last_exit_sentence(Some(clean), now, RESPAWN_DELAY).unwrap();
        assert!(!clean_line.contains("code"), "{clean_line}");

        // Nothing has exited: say nothing.
        assert_eq!(last_exit_sentence(None, now, RESPAWN_DELAY), None);
    }
}
