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
//!   exit instead.
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
//! It lives here rather than in `crates/desktop-core` because there is
//! exactly one consumer: Subshell Client's node agent has its own service and
//! no equivalent mode. That is the crate's own rule — an abstraction designed
//! against one real consumer and one guess costs more than the duplication it
//! removes.

use std::io;
use std::path::PathBuf;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime};

/// The gap before a respawn — `RestartSec=5`, deliberately the same number.
pub const RESPAWN_DELAY: Duration = Duration::from_secs(5);

/// How long a `stop` waits for SIGTERM to be honoured before SIGKILL.
///
/// The server closes sockets and exits promptly; this is the budget for one
/// that is wedged rather than the expected shutdown time.
pub const STOP_BOUND: Duration = Duration::from_secs(10);

/// Poll interval while waiting for a terminated child to actually go.
const REAP_TICK: Duration = Duration::from_millis(100);

/// How the last child ended, for the recovery screen's own sentence.
#[derive(Debug, Clone, Copy)]
pub struct LastExit {
    /// Exit code, `None` when a signal ended it.
    pub code: Option<i32>,
    pub at: SystemTime,
}

/// What the supervisor is doing right now.
///
/// Deliberately only what a CALLER uses. "Is it meant to be running" and "how
/// long has it been up" were both here and read by nothing: the probe answers
/// the first from the port, which is the fact that matters, and nothing has
/// ever wanted the second.
#[derive(Debug, Clone)]
pub struct Snapshot {
    /// The live child's pid, `None` when nothing is running.
    pub pid: Option<u32>,
    /// How the last child ended, `None` when none has.
    pub last_exit: Option<LastExit>,
}

/// A spawned process the supervisor can wait on and signal.
///
/// A trait so the state machine is testable with no processes and no real
/// time: every behaviour worth pinning here (respawn after an exit, stop
/// without a respawn, restart without the delay) is about ORDER, and a test
/// that actually spawned would be pinning the OS instead.
pub trait ChildHandle: Send {
    fn id(&self) -> u32;
    fn wait(&mut self) -> io::Result<ExitStatus>;
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>>;
    fn kill(&mut self) -> io::Result<()>;
}

/// How a child is created, and how it is asked to stop.
pub trait Spawner: Send + Sync {
    fn spawn(&self) -> io::Result<Box<dyn ChildHandle>>;
    /// Ask this pid to exit — SIGTERM to the PROCESS, never the group.
    fn terminate(&self, pid: u32);
    /// Sleep, injected so the respawn delay costs a test nothing.
    fn sleep(&self, d: Duration);
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

impl Spawner for ServerSpawner {
    fn spawn(&self) -> io::Result<Box<dyn ChildHandle>> {
        let Some((program, args)) = self.argv.split_first() else {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty server argv"));
        };
        if let Some(dir) = self.console_log.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // TRUNCATED per spawn, not appended: this is the last run's console
        // output, which is the thing worth reading after a crash, and it is
        // bounded by construction rather than by a sweep. The server's own
        // structured log is the capped one and is a different file.
        let out = std::fs::File::create(&self.console_log)?;
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
        // `kill(1)` as one bounded spawn rather than a `libc` dependency —
        // the same call this app already makes for `hostname`. The argument
        // is a pid we printed ourselves, never anything from a page.
        //
        // The pid ALONE. A negative argument would signal the process GROUP,
        // which is every subshell's tmux server as well, and losing a
        // person's live panes because they quit a window is the exact failure
        // `KillMode=process` exists to prevent.
        let argv = vec!["kill".to_string(), "-TERM".to_string(), pid.to_string()];
        let _ = subshell_desktop_core::proc::run(&argv, Duration::from_secs(2));
    }

    fn sleep(&self, d: Duration) {
        std::thread::sleep(d);
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
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.0.try_wait()
    }
    fn kill(&mut self) -> io::Result<()> {
        self.0.kill()
    }
}

/// The shared state one supervisor thread and every caller agree about.
#[derive(Default)]
struct State {
    desired_running: bool,
    pid: Option<u32>,
    started: Option<Instant>,
    last_exit: Option<LastExit>,
    /// Set while a `restart` is in flight, so the loop skips the delay once.
    immediate: bool,
}

/// Owns at most one server process.
pub struct Supervisor {
    state: Arc<(Mutex<State>, Condvar)>,
    /// The live child, held so `stop` can escalate to SIGKILL.
    child: Arc<Mutex<Option<Box<dyn ChildHandle>>>>,
    running: Arc<AtomicBool>,
    /// Mirrors `State.pid` for lock-free reads from the probe's hot path.
    pid: Arc<AtomicU32>,
}

impl Default for Supervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl Supervisor {
    pub fn new() -> Self {
        Supervisor {
            state: Arc::new((Mutex::new(State::default()), Condvar::new())),
            child: Arc::new(Mutex::new(None)),
            running: Arc::new(AtomicBool::new(false)),
            pid: Arc::new(AtomicU32::new(0)),
        }
    }

    /// Start the server, or do nothing if it is already up. Idempotent.
    pub fn start(&self, spawner: Arc<dyn Spawner>) {
        {
            let mut st = self.state.0.lock().unwrap_or_else(|e| e.into_inner());
            st.desired_running = true;
        }
        if self.running.swap(true, Ordering::SeqCst) {
            // A loop is already up; it reads `desired_running` after each wait
            // and will spawn again on its own.
            self.state.1.notify_all();
            return;
        }
        self.spawn_loop(spawner);
    }

    /// Stop the server and keep it stopped. Idempotent; blocks until it is gone.
    pub fn stop(&self, spawner: &dyn Spawner) {
        {
            let mut st = self.state.0.lock().unwrap_or_else(|e| e.into_inner());
            st.desired_running = false;
        }
        // Wake a loop that is sitting in its respawn delay so it notices.
        self.state.1.notify_all();
        self.terminate_child(spawner);
    }

    /// Stop and start again, without the respawn delay.
    ///
    /// The delay is right for a crash — the server may be crash-looping on a
    /// busy port — and wrong for a restart a person asked for, where it is
    /// five seconds of nothing happening.
    pub fn restart(&self, spawner: &dyn Spawner) {
        {
            let mut st = self.state.0.lock().unwrap_or_else(|e| e.into_inner());
            st.immediate = true;
            st.desired_running = true;
        }
        self.terminate_child(spawner);
        self.state.1.notify_all();
    }

    /// What is running, for the probe.
    pub fn snapshot(&self) -> Snapshot {
        let st = self.state.0.lock().unwrap_or_else(|e| e.into_inner());
        Snapshot {
            pid: st.pid,
            last_exit: st.last_exit,
        }
    }

    /// The live child's pid without taking the state lock.
    pub fn pid(&self) -> Option<u32> {
        match self.pid.load(Ordering::SeqCst) {
            0 => None,
            p => Some(p),
        }
    }

    /// SIGTERM, wait out `STOP_BOUND`, then SIGKILL.
    fn terminate_child(&self, spawner: &dyn Spawner) {
        let pid = self.pid();
        let Some(pid) = pid else { return };
        spawner.terminate(pid);
        let deadline = Instant::now() + STOP_BOUND;
        loop {
            {
                let mut held = self.child.lock().unwrap_or_else(|e| e.into_inner());
                match held.as_mut().map(|c| c.try_wait()) {
                    // Gone, or never there.
                    None | Some(Ok(Some(_))) => return,
                    Some(Err(_)) => return,
                    Some(Ok(None)) => {}
                }
                if Instant::now() >= deadline {
                    // Last resort. A server that ignored SIGTERM for ten
                    // seconds is wedged, and leaving it holding the port would
                    // make every later start fail on EADDRINUSE.
                    if let Some(c) = held.as_mut() {
                        let _ = c.kill();
                    }
                    return;
                }
            }
            spawner.sleep(REAP_TICK);
        }
    }

    fn spawn_loop(&self, spawner: Arc<dyn Spawner>) {
        let state = Arc::clone(&self.state);
        let child_slot = Arc::clone(&self.child);
        let running = Arc::clone(&self.running);
        let pid_cell = Arc::clone(&self.pid);
        std::thread::spawn(move || {
            loop {
                if !state.0.lock().unwrap_or_else(|e| e.into_inner()).desired_running {
                    break;
                }
                let spawned = match spawner.spawn() {
                    Ok(c) => c,
                    Err(err) => {
                        eprintln!("subshell: could not start the server: {err}");
                        // Treat a failed spawn as an exit: the same five-second
                        // rhythm, so a transient cause (a binary mid-install)
                        // recovers without a person pressing anything.
                        let mut st = state.0.lock().unwrap_or_else(|e| e.into_inner());
                        st.last_exit = Some(LastExit {
                            code: None,
                            at: SystemTime::now(),
                        });
                        drop(st);
                        if !wait_to_respawn(&state, spawner.as_ref()) {
                            break;
                        }
                        continue;
                    }
                };
                let pid = spawned.id();
                pid_cell.store(pid, Ordering::SeqCst);
                {
                    let mut st = state.0.lock().unwrap_or_else(|e| e.into_inner());
                    st.pid = Some(pid);
                    st.started = Some(Instant::now());
                }
                *child_slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(spawned);

                // The wait must NOT hold the child lock: `stop` needs it to
                // escalate to SIGKILL while this thread is parked here.
                let status = {
                    let mut held = child_slot.lock().unwrap_or_else(|e| e.into_inner());
                    let taken = held.take();
                    drop(held);
                    match taken {
                        Some(mut c) => {
                            let waited = c.wait();
                            // Put it back only if nothing replaced it.
                            let mut slot = child_slot.lock().unwrap_or_else(|e| e.into_inner());
                            if slot.is_none() {
                                *slot = Some(c);
                            }
                            waited
                        }
                        None => Ok(exit_status_placeholder()),
                    }
                };
                pid_cell.store(0, Ordering::SeqCst);
                {
                    let mut st = state.0.lock().unwrap_or_else(|e| e.into_inner());
                    st.pid = None;
                    st.started = None;
                    st.last_exit = Some(LastExit {
                        code: status.as_ref().ok().and_then(|s| s.code()),
                        at: SystemTime::now(),
                    });
                }
                *child_slot.lock().unwrap_or_else(|e| e.into_inner()) = None;
                if !wait_to_respawn(&state, spawner.as_ref()) {
                    break;
                }
            }
            running.store(false, Ordering::SeqCst);
        });
    }
}

/// Sleep out the respawn delay unless the caller asked for an immediate one.
/// Returns whether the loop should spawn again.
fn wait_to_respawn(state: &Arc<(Mutex<State>, Condvar)>, spawner: &dyn Spawner) -> bool {
    let immediate = {
        let mut st = state.0.lock().unwrap_or_else(|e| e.into_inner());
        if !st.desired_running {
            return false;
        }
        std::mem::replace(&mut st.immediate, false)
    };
    if !immediate {
        spawner.sleep(RESPAWN_DELAY);
    }
    state.0.lock().unwrap_or_else(|e| e.into_inner()).desired_running
}

/// A stand-in status for the "the child vanished from under us" branch, which
/// only happens when `stop` took it to SIGKILL while this thread was between
/// locks. Reported as a signal death, which is what it was.
fn exit_status_placeholder() -> ExitStatus {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        ExitStatus::from_raw(9)
    }
    #[cfg(not(unix))]
    {
        Command::new("cmd")
            .arg("/c")
            .arg("exit 1")
            .status()
            .expect("placeholder")
    }
}

/// One sentence about the last exit, for the recovery screen.
///
/// `None` when nothing has exited: a server that has never crashed has
/// nothing to say, and a blank "exited" line would read as one that had.
pub fn last_exit_sentence(last: Option<LastExit>, now: SystemTime) -> Option<String> {
    let last = last?;
    let ago = now.duration_since(last.at).ok()?.as_secs();
    let when = match ago {
        0..=1 => "just now".to_string(),
        2..=59 => format!("{ago} seconds ago"),
        60..=3599 => format!("{} minutes ago", ago / 60),
        _ => format!("{} hours ago", ago / 3600),
    };
    Some(match last.code {
        Some(code) => format!("subshell-server exited with code {code} {when}"),
        None => format!("subshell-server stopped unexpectedly {when}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    /// A child that exits when told to, recording what was asked of it.
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
        fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            Ok(self.exited.load(Ordering::SeqCst).then(|| status_with(self.code)))
        }
        fn kill(&mut self) -> io::Result<()> {
            self.exited.store(true, Ordering::SeqCst);
            Ok(())
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
            unimplemented!()
        }
    }

    struct FakeSpawner {
        spawns: Arc<Mutex<Vec<u32>>>,
        /// Each spawned child's exit flag, so a test can end one.
        live: Arc<Mutex<Vec<Arc<AtomicBool>>>>,
        /// Every sleep the loop took, so the delay is assertable.
        sleeps: Arc<Mutex<Vec<Duration>>>,
        /// Pids handed to `terminate`, to pin "the process, never the group".
        signalled: Arc<Mutex<Vec<u32>>>,
        next: Arc<AtomicU32>,
        tx: mpsc::Sender<u32>,
    }

    impl Spawner for FakeSpawner {
        fn spawn(&self) -> io::Result<Box<dyn ChildHandle>> {
            let id = self.next.fetch_add(1, Ordering::SeqCst);
            let exited = Arc::new(AtomicBool::new(false));
            self.spawns.lock().unwrap().push(id);
            self.live.lock().unwrap().push(Arc::clone(&exited));
            let _ = self.tx.send(id);
            Ok(Box::new(FakeChild { id, exited, code: 1 }))
        }
        fn terminate(&self, pid: u32) {
            self.signalled.lock().unwrap().push(pid);
            // A real SIGTERM ends the process; the fake honours it the same way.
            if let Some(flag) = self.live.lock().unwrap().last() {
                flag.store(true, Ordering::SeqCst);
            }
        }
        fn sleep(&self, d: Duration) {
            self.sleeps.lock().unwrap().push(d);
        }
    }

    fn harness() -> (Arc<FakeSpawner>, mpsc::Receiver<u32>) {
        let (tx, rx) = mpsc::channel();
        (
            Arc::new(FakeSpawner {
                spawns: Arc::new(Mutex::new(Vec::new())),
                live: Arc::new(Mutex::new(Vec::new())),
                sleeps: Arc::new(Mutex::new(Vec::new())),
                signalled: Arc::new(Mutex::new(Vec::new())),
                next: Arc::new(AtomicU32::new(100)),
                tx,
            }),
            rx,
        )
    }

    /// Wait for the loop to reach its Nth spawn, or fail rather than hang.
    fn await_spawns(rx: &mpsc::Receiver<u32>, n: usize) {
        for _ in 0..n {
            rx.recv_timeout(Duration::from_secs(5)).expect("a spawn");
        }
    }

    #[test]
    fn start_is_idempotent() {
        let (spawner, rx) = harness();
        let sup = Supervisor::new();
        sup.start(Arc::clone(&spawner) as Arc<dyn Spawner>);
        await_spawns(&rx, 1);
        sup.start(Arc::clone(&spawner) as Arc<dyn Spawner>);
        std::thread::sleep(Duration::from_millis(50));
        // One server, not two racing for the port.
        assert_eq!(spawner.spawns.lock().unwrap().len(), 1);
        sup.stop(spawner.as_ref());
    }

    /// The unit's `Restart=always` + `RestartSec=5`, as behaviour.
    #[test]
    fn a_crash_respawns_after_the_delay() {
        let (spawner, rx) = harness();
        let sup = Supervisor::new();
        sup.start(Arc::clone(&spawner) as Arc<dyn Spawner>);
        await_spawns(&rx, 1);
        // The server dies on its own — an EADDRINUSE loop, say.
        spawner.live.lock().unwrap()[0].store(true, Ordering::SeqCst);
        await_spawns(&rx, 1);
        assert_eq!(spawner.spawns.lock().unwrap().len(), 2);
        assert!(
            spawner.sleeps.lock().unwrap().contains(&RESPAWN_DELAY),
            "a crash waits RESPAWN_DELAY before coming back"
        );
        sup.stop(spawner.as_ref());
    }

    #[test]
    fn stop_terminates_the_pid_and_does_not_respawn() {
        let (spawner, rx) = harness();
        let sup = Supervisor::new();
        sup.start(Arc::clone(&spawner) as Arc<dyn Spawner>);
        await_spawns(&rx, 1);
        let pid = spawner.spawns.lock().unwrap()[0];
        sup.stop(spawner.as_ref());
        std::thread::sleep(Duration::from_millis(50));
        // THE PID, positive — a negative argument would be the process group,
        // which is every live subshell's tmux server.
        assert_eq!(*spawner.signalled.lock().unwrap(), vec![pid]);
        assert_eq!(spawner.spawns.lock().unwrap().len(), 1, "a stop stays stopped");
        assert_eq!(sup.pid(), None, "and nothing is left running");
    }

    #[test]
    fn restart_comes_back_without_waiting() {
        let (spawner, rx) = harness();
        let sup = Supervisor::new();
        sup.start(Arc::clone(&spawner) as Arc<dyn Spawner>);
        await_spawns(&rx, 1);
        spawner.sleeps.lock().unwrap().clear();
        sup.restart(spawner.as_ref());
        await_spawns(&rx, 1);
        assert_eq!(spawner.spawns.lock().unwrap().len(), 2);
        // Five seconds of nothing is right for a crash and wrong for a button.
        assert!(
            !spawner.sleeps.lock().unwrap().contains(&RESPAWN_DELAY),
            "a restart someone asked for skips the crash delay"
        );
        sup.stop(spawner.as_ref());
    }

    #[test]
    fn the_snapshot_records_how_the_last_child_ended() {
        let (spawner, rx) = harness();
        let sup = Supervisor::new();
        sup.start(Arc::clone(&spawner) as Arc<dyn Spawner>);
        await_spawns(&rx, 1);
        assert!(sup.pid().is_some());
        spawner.live.lock().unwrap()[0].store(true, Ordering::SeqCst);
        await_spawns(&rx, 1);
        let snap = sup.snapshot();
        assert_eq!(snap.last_exit.map(|e| e.code), Some(Some(1)));
        sup.stop(spawner.as_ref());
    }

    #[test]
    fn the_exit_sentence_names_the_code_and_when() {
        let now = SystemTime::now();
        let five_ago = now - Duration::from_secs(5);
        let line = last_exit_sentence(
            Some(LastExit {
                code: Some(1),
                at: five_ago,
            }),
            now,
        )
        .unwrap();
        assert!(line.contains("code 1"), "{line}");
        assert!(line.contains("5 seconds ago"), "{line}");
        // A signal death has no code, and must not print one.
        let signalled = last_exit_sentence(
            Some(LastExit {
                code: None,
                at: five_ago,
            }),
            now,
        )
        .unwrap();
        assert!(signalled.contains("stopped unexpectedly"), "{signalled}");
        // Nothing has exited: say nothing, rather than print a blank exit.
        assert_eq!(last_exit_sentence(None, now), None);
    }
}
