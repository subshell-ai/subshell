//! Resetting this machine to a virgin state: the screen request, the stashed
//! consent, and the chain that honours it (spec § 7 of the 2026-09-10 design).
//!
//! The shape of the whole feature is one sentence: **the page supplies a
//! hostname, never a path.** The SPA's danger card asks for typed consent and
//! calls `desktop_open_assistant({ screen: "reset" })`; the Rust side reads the
//! machine at that moment, validates what it found against the one rule that
//! matters (no deletion may contain the installed server binary this reset
//! promises to keep), and stashes the plan; `desktop_reset` then deletes
//! EXACTLY the stashed paths, in the order the confirmation drew, after the
//! service and the pane servers that hold them open are gone.
//!
//! The plan lives in app state rather than being re-read inside
//! `desktop_reset` because the chain stops and uninstalls the very server
//! whose `status --json` reports those paths. Re-reading after step 4 would
//! be asking a dead server where its own data lives (R18); stashing at press
//! time is also what makes the consent spendable — half a run leaves the plan
//! in place so Retry converges, and a finished one clears it.
//!
//! Channel discipline is the crate's, inherited from `desktop_setup`: an
//! in-chain failure answers `Ok(ActionResult { ok: false, stdout: log,
//! stderr })` carrying every word the CLI said up to the stop, and `Err` is
//! reserved for refusals that fire BEFORE the first mutation (spec § 10). A
//! `?` here means "could not even be attempted".

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use subshell_desktop_core::proc::{run, Run, ACTION_TIMEOUT};
use subshell_desktop_core::reset_guards::{consent_granted, delete_guard_ok, is_subshell_socket, path_rules_ok};
use subshell_desktop_core::settings::SettingsState;
use subshell_desktop_core::sidecar;

use crate::control::{ActionResult, ServiceCommand};

/// Which assistant screen the page should present when it comes up.
///
/// A closed enum because the request crosses the boundary FROM the server's
/// page: the remote window may name a screen, never a path or a URL
/// (spec § 7.1). Unknown and absent both mean `Home` — the recovery or
/// first-run screen the page picks from its own probe — so a page older than
/// this feature sees exactly what it always saw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    /// Whatever the probe implies: first run, or the one recovery screen.
    Home,
    Reset,
    /// The bundled server is newer than the installed one (spec § 5.3).
    Update,
}

impl Screen {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Screen::Home => "home",
            Screen::Reset => "reset",
            Screen::Update => "update",
        }
    }
}

/// Parse the (untrusted, optional) `screen` argument. Two accepted words.
pub fn parse_screen(raw: Option<String>) -> Screen {
    match raw.as_deref() {
        Some("reset") => Screen::Reset,
        Some("update") => Screen::Update,
        _ => Screen::Home,
    }
}

/// The five paths a confirmed reset deletes, read off a fresh `status --json`.
///
/// These are DATA, quoted from the server's own report (Task 3 made `status`
/// say them) — nothing here re-derives a path from env, because a reset that
/// deleted what THIS side guessed instead of what the server named would be
/// the R1 failure with a typed hostname in front of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletePlan {
    pub config_env: PathBuf,
    pub database: PathBuf,
    pub logs_dir: PathBuf,
    pub artifacts_dir: PathBuf,
    pub data_dir: PathBuf,
}

/// All-or-nothing (R17): every path present, non-empty and absolute, or
/// there is no plan. A partial block deleted and reported success would be
/// R1's shape again, so a subset is refused exactly like nothing at all.
pub fn parse_delete_plan(status: &Value) -> Option<DeletePlan> {
    let abs = |v: Option<&Value>| -> Option<PathBuf> {
        let s = v?.as_str()?;
        (!s.is_empty() && Path::new(s).is_absolute()).then(|| PathBuf::from(s))
    };
    let paths = status.get("paths")?;
    Some(DeletePlan {
        config_env: abs(status.get("configEnv")?.get("path"))?,
        data_dir: abs(paths.get("dataDir"))?,
        database: abs(paths.get("database"))?,
        logs_dir: abs(paths.get("logsDir"))?,
        artifacts_dir: abs(paths.get("nodeArtifacts"))?,
    })
}

/// What a reset press leaves behind: the requested screen until some page
/// collects it, and the delete plan until the consent is spent.
#[derive(Default)]
pub struct Stash {
    pub screen: Mutex<Option<Screen>>,
    /// Whether a page has proved it is listening, by pulling at least once.
    ///
    /// The only fact that distinguishes "a window exists" from "a window can
    /// hear an event" — and the emit path needs the second. Set by
    /// `desktop_pending_screen`, cleared when a window is built
    /// (`windows::open_assistant`), so a reload cannot leave it lying true.
    pub page_listening: AtomicBool,
    pub plan: Mutex<Option<DeletePlan>>,
}

/// The reset entry's whole Rust side at press time: parse the (untrusted,
/// optional) screen argument, and for `reset` read the machine NOW and stash
/// both the screen request and the validated delete plan (R18). If the read
/// fails or the plan will not parse, the screen still raises — it renders its
/// own refusal from the probe — but nothing is stashed, so `desktop_reset`
/// has nothing to execute either. The page never supplies a path to anything;
/// its only input is the typed hostname.
pub fn arm_and_raise(app: &AppHandle, screen: Option<String>) -> Result<(), String> {
    let stash = app.state::<Stash>();
    let requested = parse_screen(screen);
    if requested == Screen::Reset {
        let settings = app.state::<SettingsState>();
        let p = crate::control::probe_now(settings.get().binary_path.as_deref());
        *stash.plan.lock().unwrap() = p.status.as_ref().and_then(parse_delete_plan);
    }
    // `Home` is stashed too, and deliberately: a live assistant sitting on
    // the reset takeover must come BACK to the recovery screen when the pill
    // is pressed, rather than staying where a previous request left it.
    *stash.screen.lock().unwrap() = Some(requested);
    // "Is a page LISTENING", not "does a window exist".
    //
    // The window's existence was the proxy here, and it is the same fallacy
    // this command's own pull was added to remove. A second press while the
    // first window is still loading sees `is_some()` true, `take()`s the
    // stash and emits into a page that has not booted — the pull then finds
    // nothing and the window takes the ready handoff. A double-press on the
    // dashboard's reset button is all it takes; nothing debounces it.
    //
    // The flag is set by the pull itself, which is the only event that proves
    // a page got far enough to ask, and cleared when a window is built.
    let listening = stash.page_listening.load(Ordering::SeqCst);
    crate::windows::open_assistant(app)?;
    if listening {
        // A live window has no page load left to pull on; deliver now.
        if let Some(s) = stash.screen.lock().unwrap().take() {
            if let Some(w) = app.get_webview_window("wizard") {
                let _ = w.emit("desktop-screen", s.as_str());
            }
        }
    }
    Ok(())
}

/// How long the caller gets before the process goes.
///
/// Not "so the result frame renders" — the chain emits `home` first, which
/// hides the reset screen, so a success is never drawn. What this buys is the
/// IPC RESPONSE landing: a restart that raced it would reach the page as a
/// dropped call rather than as the answer to the button it pressed.
const RESTART_GRACE: std::time::Duration = std::time::Duration::from_millis(400);

/// Restart the app once the caller has its answer.
///
/// **On the MAIN THREAD, deliberately.** Off it, `restart()` routes through
/// `RunEvent::ExitRequested` — which this app PREVENTS while close-to-tray is
/// on and a `main` window exists, and `main` may merely have been HIDDEN by
/// that same preference a moment ago rather than closed. On the main thread
/// Tauri skips those events and restarts the process directly, so the one
/// preference that could swallow this cannot. (Off the main thread the
/// prevented exit does not even fail loudly: that arm parks the caller in
/// `loop { sleep(Duration::MAX) }` forever — tauri 2.11.5 `app.rs`.)
///
/// **It also refuses to start something it cannot finish.** `restart()` is
/// `-> !`: when it cannot resolve the current binary it `exit(0)`s, taking
/// the app down with nothing respawned and nothing said (`process.rs`).
/// `current_binary` reads `/proc/self/exe` or `current_exe()`, so a bundle
/// reached through a symlink is a real way to land there. Resolving it first
/// turns a silent disappearance into a window that is still on screen — the
/// machine is wiped either way, but one of those reads as a crash and the
/// other as the app waiting for the user to set it up again.
fn schedule_restart(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(RESTART_GRACE);
        if let Err(err) = tauri::process::current_binary(&handle.env()) {
            eprintln!("subshell: not restarting after the reset — this app's own path did not resolve: {err}");
            // The assistant is up and on `home`, which on a wiped machine is
            // first run. Leave the person with it rather than with nothing.
            if let Some(w) = handle.get_webview_window("wizard") {
                let _ = w.show();
                let _ = w.set_focus();
            }
            return;
        }
        let on_main = handle.clone();
        if let Err(err) = handle.run_on_main_thread(move || {
            on_main.restart();
        }) {
            // Nothing left to do about it: the windows below were already put
            // where a person needs them, and the page is on first run.
            eprintln!("subshell: could not restart after the reset: {err}");
        }
    });
}

/// Wipe this machine back to virgin, with the typed hostname as consent.
///
/// The order is the confirmation's, step for step (spec § 7.2): stop, close
/// the pane servers, uninstall the service, delete (database, logs,
/// artifacts, data dir minus config.env, config.env), forget this app's own
/// choices, and move the windows. Every guard that can refuse fires before
/// the first mutation; every failure after that is a half-run answered
/// `ok: false` with the verbatim log, plan still stashed so Retry converges.
#[tauri::command(async)]
pub fn desktop_reset(app: AppHandle, typed: String) -> Result<ActionResult, String> {
    // Held for the whole chain: the watch thread must not probe between the
    // uninstall and the deletes and act on what it finds there.
    let _guard = crate::control::ActionGuard::new();
    // The typed string must equal the memo the screen was built from (R15):
    // the probe carries the same memoized `machine_hostname` the page
    // rendered, so comparison is two reads of one OnceLock, never a re-spawn
    // that could race a rename mid-session into an instruction nobody typed.
    // A mismatch is a refusal to start, not a failed run: Err. An EMPTY memo
    // — hostname(1) would not run — is refused by name, because the empty
    // box it used to match is the one thing this gate may never accept
    // (PR review, fail-open finding).
    let memo = crate::control::machine_hostname();
    if memo.is_empty() {
        return Err("this machine's name could not be read, so reset cannot confirm it".into());
    }
    if !consent_granted(&typed, &memo) {
        return Err("the hostname did not match this machine".into());
    }
    let stash = app.state::<Stash>();
    let plan = stash
        .plan
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no reset plan is staged; the reset screen must be opened again".to_string())?;
    let settings = app.state::<SettingsState>();
    // The one thing the confirmation promised to keep: the managed copy's
    // path, resolved exactly as install_server_now resolves it.
    let keep = sidecar::install_path(&crate::server_bin::SERVER_SIDECAR)
        .ok_or_else(|| "cannot locate this app's managed server copy to protect it".to_string())?;
    // Canonicalize the kept path so the containment comparison is between
    // real locations, not spellings (P3). An absent binary keeps the
    // uncanonicalized path, and containment THEN STILL REFUSES a delete
    // target that would contain it (N3): fail-closed on purpose, because
    // that path is where the binary would be reinstalled, so recursively
    // deleting its ancestor is what should stop the chain even with no file
    // standing there yet. Present-but-unresolvable is a refusal.
    let keep = match std::fs::canonicalize(&keep) {
        Ok(k) => k,
        Err(e) if e.kind() == ErrorKind::NotFound => keep,
        Err(e) => return Err(format!("cannot resolve the protected path {keep:?}: {e}")),
    };
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "HOME is unset; reset refuses to delete with no home to guard".to_string())?;

    // The three RECURSIVE deletes get the containment guard (N1). The
    // database is removed as a single file, so its parent directory is never
    // deleted and guarding IT could only refuse a reset that was never going
    // to touch the binary (a database at ~/.local/bin/subshell.db would
    // otherwise refuse on its parent); it keeps its own shape check below.
    for p in [&plan.data_dir, &plan.logs_dir, &plan.artifacts_dir] {
        if !path_rules_ok(p, &home) {
            return Err(format!("refusing to delete {p:?}: fails the shape rules"));
        }
        if !p.exists() {
            continue; // already-deleted is a step succeeding, not a guard case
        }
        let canonical = std::fs::canonicalize(p)
            .map_err(|e| format!("cannot resolve {p:?} to guard it against the protected binary: {e}"))?;
        if !delete_guard_ok(&canonical, &keep) {
            return Err(format!(
                "refusing to delete {p:?}: it contains the installed server binary this reset promises to keep"
            ));
        }
    }
    if !path_rules_ok(&plan.database, &home) || !path_rules_ok(&plan.config_env, &home) {
        return Err("refusing: database or config.env path fails the shape rules".into());
    }

    let mut log = String::new();
    // 2. Stop. Tolerates the CLI's measured refusal for a machine with no
    // service (`controlService` answers exit 1, `nothing installed: no
    // service definition at ...` on stderr): without it a Retry after any
    // step-5 failure dies here forever, because step 4 of the half-run
    // already removed what this step would then refuse on (PR review).
    let stop = crate::control::service_now(&settings, ServiceCommand::Stop, false);
    if let Some(stderr) = push_step(&mut log, &stop, &["nothing installed"]) {
        return Ok(ActionResult {
            ok: false,
            stdout: log,
            stderr,
        });
    }
    // 3. Close this instance's panes (their per-subshell tmux servers).
    if let Some(detail) = close_subshell_tmux(&mut log) {
        return Ok(ActionResult {
            ok: false,
            stdout: log,
            stderr: detail,
        });
    }
    // 4. Uninstall the service, while the binary and config it names exist.
    // Linux answers a missing unit with exit 0 (its "nothing installed" goes
    // to stdout), so this tolerance is belt-and-braces - but anchored on the
    // CLI's real spelling, not the old "not installed", which matched nothing
    // anywhere (PR review).
    let un = crate::control::service_now(&settings, ServiceCommand::Uninstall, false);
    if let Some(stderr) = push_step(&mut log, &un, &["nothing installed"]) {
        return Ok(ActionResult {
            ok: false,
            stdout: log,
            stderr,
        });
    }
    // 5. Delete in the order the screen drew, absence = done, config.env
    // last. Every deletion's failure ends the chain (K2): a surviving
    // signing key announced as a completed wipe is worse than the R1 and
    // R17 cases this document already refused twice, because the hostname
    // was typed against the promise that THESE bytes are gone.
    if let Some(detail) = remove_if_exists(&plan.database, &mut log) {
        return Ok(ActionResult {
            ok: false,
            stdout: log,
            stderr: detail,
        });
    }
    if let Some(detail) = delete_tree(&plan.logs_dir, &mut log) {
        return Ok(ActionResult {
            ok: false,
            stdout: log,
            stderr: detail,
        });
    }
    if let Some(detail) = delete_tree(&plan.artifacts_dir, &mut log) {
        return Ok(ActionResult {
            ok: false,
            stdout: log,
            stderr: detail,
        });
    }
    if let Some(detail) = delete_tree_but(&plan.data_dir, &plan.config_env, &mut log) {
        return Ok(ActionResult {
            ok: false,
            stdout: log,
            stderr: detail,
        });
    }
    if let Some(detail) = remove_if_exists(&plan.config_env, &mut log) {
        return Ok(ActionResult {
            ok: false,
            stdout: log,
            stderr: detail,
        });
    }
    // Remove-if-empty tidies, after the last consented byte is gone. These
    // two stay fire-and-forget: every file the human confirmed IS deleted at
    // this point, and failing to remove a now-empty (or still-populated-by-
    // someone-else's) directory afterward changes no consent. The two paths
    // are the same directory in the default layout (R13), which is exactly
    // why both are allowed to miss.
    let _ = std::fs::remove_dir(plan.config_env.parent().unwrap());
    let _ = std::fs::remove_dir(&plan.data_dir);
    // 6. This app's own choices, which are the machine state this screen owns.
    let _ = settings.update(|s| {
        s.binary_path = None;
        s.onboarded = false;
    });
    *stash.plan.lock().unwrap() = None; // the consent has been spent

    // 7. The app restarts itself.
    //
    // Every fact this process is holding is now about a machine that is gone:
    // memoized probes, the settings it just rewrote, and two windows pointed
    // at an instance that no longer exists. Reaching first run by RESTARTING
    // is by construction; reaching it by closing one window and telling the
    // page to go back was by inference, and the inference ran against a
    // machine still settling — the service is stopped, but a draining port can
    // answer `ready` for a moment longer, and the ready path both re-opens the
    // dashboard and CLOSES the assistant (`desktop_open_main`). Reported on
    // 2026-09-12: the reset window closed and the dashboard stayed.
    //
    // It is also what a person expects after wiping a machine, which is how it
    // was reported.
    //
    // The window steps below stay as the fallback for a restart that does not
    // happen, and because getting rid of `main` immediately is what makes the
    // press feel answered.
    //
    // DESTROY, not close. `close()` raises `CloseRequested`, and this app
    // answers that on `main` by PREVENTING it and hiding the window whenever
    // close-to-tray is on (`lib.rs`) — so the dashboard would still be there,
    // merely invisible, one tray or Dock click from being pointed at a port
    // that no longer answers. That is half of what "the dashboard stayed" was
    // reporting. The preference exists so a click on the red button does not
    // quit the app; it is not a veto on a reset that has already deleted the
    // instance behind the window.
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.destroy();
    }
    if let Some(w) = app.get_webview_window("wizard") {
        let _ = w.emit("desktop-screen", Screen::Home.as_str());
    }
    schedule_restart(&app);
    Ok(ActionResult {
        ok: true,
        stdout: log,
        stderr: String::new(),
    })
}

/// The screen this window was opened for, taken exactly once.
///
/// **A PULL, because the push could not be heard.** The assistant used to be
/// told through a `desktop-screen` event emitted from `on_page_load` — which
/// Tauri fires for `PageLoadEvent::Started` as well as `Finished`. The handler
/// ignored which, so the stash was consumed on `Started`, before the page's
/// JavaScript existed, and the event went to a window with nothing listening.
/// By the time anything could hear it the stash was empty. Measured on
/// 2026-09-12: pressing Reset on the dashboard opened the assistant, which
/// showed the ready handoff and closed itself, because the request never
/// arrived.
///
/// Emitting on `Finished` instead would have narrowed the window without
/// closing it: `listen()` registers over IPC, and nothing orders that against
/// a page-load callback. Asking cannot race — whenever the page is ready to
/// act on an answer, it asks for one.
///
/// A live window is still TOLD directly by [`arm_and_raise`], which has no
/// page load to wait for; the stash is taken once either way, so the two can
/// never both deliver.
#[tauri::command(async)]
pub fn desktop_pending_screen(app: AppHandle) -> Option<String> {
    // Asking IS the proof that this page can hear an event, and it is the
    // only such proof available — see `Stash::page_listening`.
    app.state::<Stash>().page_listening.store(true, Ordering::SeqCst);
    app.state::<Stash>()
        .screen
        .lock()
        .unwrap()
        .take()
        .map(|s| s.as_str().to_string())
}

/// Arm the reset screen from the console itself: the arming half of
/// `arm_and_raise`, without the window half, because this window is already
/// up. Every property of the SPA path is kept — the plan is stashed from a
/// probe taken at press time (R18), and the page still supplies only a
/// hostname. Answers whether a plan parsed; `false` means the screen renders
/// its own refusal, which is the useful information.
#[tauri::command(async)]
pub fn desktop_arm_reset(app: AppHandle, settings: State<'_, SettingsState>) -> bool {
    let p = crate::control::probe_now(settings.get().binary_path.as_deref());
    let plan = p.status.as_ref().and_then(parse_delete_plan);
    let armed = plan.is_some();
    *app.state::<Stash>().plan.lock().unwrap() = plan;
    armed
}

/// Append one verb's verbatim words; return `Some(stderr)` when it failed.
///
/// The chain's rule is the console's: the CLI's words render unedited. A
/// tolerated phrase (the "already done" answers the chain treats as the step
/// succeeding) still goes into the log — the human reads what the CLI said —
/// but does not end the chain.
fn push_step(log: &mut String, r: &ActionResult, tolerated: &[&str]) -> Option<String> {
    log.push_str(&r.stdout);
    if r.ok {
        if !r.stderr.trim().is_empty() {
            log.push_str(&r.stderr);
        }
        return None;
    }
    if tolerated.iter().any(|t| r.stderr.contains(t)) {
        log.push_str(&r.stderr);
        return None;
    }
    Some(r.stderr.clone())
}

/// The one decision every deletion shares, kept pure so K2 is testable where
/// CI runs as root (permission bits are a suggestion there; constructed
/// `io::Error`s are not): absence is the step succeeding, so a Retry
/// converges; a refusal names the path that survived and stops the chain.
fn delete_outcome(res: std::io::Result<()>, path: &Path) -> Option<String> {
    match res {
        Ok(()) => None,
        Err(e) if e.kind() == ErrorKind::NotFound => None,
        Err(e) => Some(format!("could not delete {}: {e}", path.display())),
    }
}

/// Unlink one file, treating "already gone" as done.
fn remove_if_exists(path: &Path, log: &mut String) -> Option<String> {
    if !path.exists() {
        log.push_str(&format!("{} was not there\n", path.display()));
        return None;
    }
    let out = delete_outcome(std::fs::remove_file(path), path);
    if out.is_none() {
        log.push_str(&format!("deleted {}\n", path.display()));
    }
    out
}

/// Delete a whole tree, treating "already gone" as done.
fn delete_tree(root: &Path, log: &mut String) -> Option<String> {
    if !root.exists() {
        log.push_str(&format!("{} was not there\n", root.display()));
        return None;
    }
    let out = delete_outcome(std::fs::remove_dir_all(root), root);
    if out.is_none() {
        log.push_str(&format!("deleted {}\n", root.display()));
    }
    out
}

/// Delete everything under `root` except exactly `keep_out`.
///
/// The walk is manual because `remove_dir_all` has no notion of a kept file:
/// config.env lives INSIDE the default data dir, and the default layout makes
/// that dir the whole consent (R13). Directories are emptied bottom-up and
/// removed best-effort — one that still holds the kept file survives, and its
/// own removal is the next step's job, which is the point. Symlinks are
/// removed as links, never followed.
fn delete_tree_but(root: &Path, keep_out: &Path, log: &mut String) -> Option<String> {
    if !root.exists() {
        log.push_str(&format!("{} was not there\n", root.display()));
        return None;
    }
    let out = delete_outcome(delete_except(root, keep_out), root);
    if out.is_none() {
        log.push_str(&format!("emptied {}\n", root.display()));
    }
    out
}

fn delete_except(dir: &Path, keep_out: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path == keep_out {
            continue;
        }
        if entry.file_type()?.is_dir() {
            delete_except(&path, keep_out)?;
            // Stays when it still holds the kept file: not emptiness, not a
            // failure — the file the human consented to keep is the reason.
            let _ = std::fs::remove_dir(&path);
        } else if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != ErrorKind::NotFound {
                return Err(e);
            }
        }
    }
    Ok(())
}

/// What one `kill-server` answered, over data only — the per-socket decision
/// extracted pure (PR review round 2) the way `delete_outcome` was, so all
/// three arms are pinnable without a tmux server AND the sweep cannot fall
/// out early as success: "abandon the remaining sockets" is absent from the
/// return type, so reintroducing it would take writing it, not forgetting it.
enum SocketOutcome {
    Closed,
    Stale,
    Failed(String),
}

fn socket_kill_outcome(r: &Run, name: &str) -> SocketOutcome {
    if r.ok() {
        return SocketOutcome::Closed;
    }
    // A kill that met a dead server found litter, not a pane. tmux has TWO
    // spellings for that and this used to know only the first, which is the
    // difference between a reset that finishes and one that cannot run at
    // all. Both measured against tmux 3.7c rather than assumed:
    //
    //   error connecting to <path> (No such file or directory)  — no socket file
    //   error connecting to <path> (Socket operation on non-socket) — not a socket
    //   no server running on <path>                             — a real socket, dead server
    //
    // The third is the one a crashed or killed tmux leaves behind, so it is
    // the common case on any machine that has run this product's tests: the
    // socket inode survives its server. Reading it as a failure stopped the
    // chain on the first such file, and a developer box accumulates them in
    // the thousands.
    //
    // Anything else that failed is a pane that SURVIVED, which is a reset
    // that lied — including a spawn that never started, because "no tmux on
    // this machine" is the pre-loop `which`'s fact to know, not this
    // function's to infer.
    let combined = format!("{}{}", r.stdout, r.stderr);
    if combined.contains("error connecting") || combined.contains("no server running on") {
        return SocketOutcome::Stale;
    }
    SocketOutcome::Failed(format!("could not close the pane server {name}: {}", r.detail()))
}

/// Kill the tmux servers this product created and nobody is watching anymore.
///
/// Each pane owns a tmux server on a `subshell-<hash>` socket named by
/// pane-runtime; the directory is tmux's own rule, TMUX_TMPDIR ?? /tmp
/// symlink-resolved with a tmux-<uid> subdir (NOT TMPDIR — on macOS that is a
/// per-user /var/folders path with no sockets in it, and a silent zero-kill
/// would let a reset report success with every pane still running, spec § 7.2
/// step 3 / R1). A kill answered by "error connecting" means the server is
/// already dead: unlink the stale socket and continue. Any other failure ends
/// the chain (as a half-run): a pane that survived is a reset that lied.
fn close_subshell_tmux(log: &mut String) -> Option<String> {
    // "No tmux on this machine" is a fact about the machine, established ONCE
    // before the loop (PR review): drawing it from one failed kill instead
    // would report the step as succeeding while abandoning every remaining
    // socket, on any spawn failure at all - fork refused under memory
    // pressure, a PATH race, anything. Inside the loop a failure is either
    // the stale-socket case or a real refusal that stops the chain, exactly
    // as the uid read below already does.
    if subshell_desktop_core::shell_env::which("tmux").is_none() {
        log.push_str("tmux is not installed; no pane servers to close\n");
        return None;
    }
    let base_raw = std::env::var("TMUX_TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
    let base = std::fs::canonicalize(&base_raw).unwrap_or_else(|_| PathBuf::from(&base_raw));
    // A uid this side cannot read means a directory this side cannot name,
    // which means zero kills reported as success — the R1 shape exactly. So
    // this failure ends the chain, never a silent skip.
    let uid = run(&["id".to_string(), "-u".to_string()], ACTION_TIMEOUT);
    if !uid.ok() {
        return Some(format!(
            "could not read the uid to locate tmux sockets: {}",
            uid.detail()
        ));
    }
    let dir = base.join(format!("tmux-{}", uid.stdout.trim()));
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => {
            log.push_str("no tmux socket directory here; nothing to close\n");
            return None;
        }
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_subshell_socket(&name) {
            continue;
        }
        let r = run(
            &[
                "tmux".to_string(),
                "-L".to_string(),
                name.clone(),
                "kill-server".to_string(),
            ],
            ACTION_TIMEOUT,
        );
        match socket_kill_outcome(&r, &name) {
            SocketOutcome::Closed => log.push_str(&format!("closed pane server {name}\n")),
            SocketOutcome::Stale => {
                let _ = std::fs::remove_file(dir.join(&name));
                log.push_str(&format!("stale socket {name} removed\n"));
            }
            SocketOutcome::Failed(detail) => return Some(detail),
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn screen_parses_closed_and_defaults_open() {
        // Absent and unknown both mean Home — whatever the assistant's own
        // probe implies. A remote page cannot name a screen this enum has
        // not admitted, which is what keeps `update` a read-only raise.
        assert_eq!(parse_screen(None), Screen::Home);
        assert_eq!(parse_screen(Some("reset".into())), Screen::Reset);
        assert_eq!(parse_screen(Some("update".into())), Screen::Update);
        assert_eq!(parse_screen(Some("/etc".into())), Screen::Home);
    }

    /// The word the PAGE branches on is `as_str`, and since the screen request
    /// became a pull (`desktop_pending_screen` answers this string) it is the
    /// whole contract between the two halves — a request the page cannot match
    /// is a window that opens on the wrong screen, silently.
    #[test]
    fn every_screen_round_trips_through_its_wire_word() {
        for screen in [Screen::Home, Screen::Reset, Screen::Update] {
            assert_eq!(parse_screen(Some(screen.as_str().to_string())), screen);
        }
        assert_eq!(Screen::Reset.as_str(), "reset");
        assert_eq!(Screen::Update.as_str(), "update");
        assert_eq!(Screen::Home.as_str(), "home");
    }

    /// Taken ONCE. Two deliverers exist — a live window is told directly, a
    /// booting one asks — and both call `take`, so a request can never be
    /// applied twice (a second application would yank a person off the screen
    /// they are reading).
    /// The delivery decision, which is the whole of the double-press bug.
    ///
    /// A second press while the first window is still loading used to see a
    /// window and emit into a page that had not booted, losing the request.
    /// The flag is the only fact that separates the two states.
    #[test]
    fn a_request_is_emitted_only_once_a_page_has_proved_it_listens() {
        let stash = Stash::default();
        // A window that exists but has never pulled: nothing may be emitted,
        // and the stash must survive for that page to ask for.
        assert!(!stash.page_listening.load(Ordering::SeqCst));
        *stash.screen.lock().unwrap() = Some(Screen::Reset);
        assert!(stash.screen.lock().unwrap().is_some());

        // Once the page asks, a later press can be delivered directly.
        stash.page_listening.store(true, Ordering::SeqCst);
        assert!(stash.page_listening.load(Ordering::SeqCst));
        assert_eq!(stash.screen.lock().unwrap().take(), Some(Screen::Reset));
    }

    #[test]
    fn a_stashed_screen_is_taken_once() {
        let stash = Stash::default();
        *stash.screen.lock().unwrap() = Some(Screen::Reset);
        assert_eq!(stash.screen.lock().unwrap().take(), Some(Screen::Reset));
        assert_eq!(stash.screen.lock().unwrap().take(), None);
    }

    #[test]
    fn plan_parses_all_or_nothing() {
        // R17: a partial block is the same refusal as no block. A subset
        // deleted and reported success is R1's shape again.
        let good = json!({"configEnv": {"path": "/c/config.env", "exists": true},
            "paths": {"dataDir": "/data", "database": "/data/subshell.db",
                      "logsDir": "/data/subshells", "nodeArtifacts": "/data/node-artifacts"}});
        let plan = parse_delete_plan(&good).expect("the four-path block parses");
        assert_eq!(plan.data_dir.to_str().unwrap(), "/data");
        assert_eq!(plan.config_env.to_str().unwrap(), "/c/config.env");
        for missing in [
            json!({"configEnv": {"path": "/c/config.env"}, "paths": {"database": "/d", "logsDir": "/l", "nodeArtifacts": "/n"}}),
            json!({"configEnv": {"path": "/c/config.env"}, "paths": {"dataDir": "", "database": "/d", "logsDir": "/l", "nodeArtifacts": "/n"}}),
            json!({"configEnv": {"path": "/c/config.env"}, "paths": {"dataDir": "relative", "database": "/d", "logsDir": "/l", "nodeArtifacts": "/n"}}),
            json!({"configEnv": {"path": "/c/config.env"}}),
        ] {
            assert!(parse_delete_plan(&missing).is_none(), "must refuse, not partially plan");
        }
    }

    #[test]
    fn an_unremovable_target_is_a_half_run_never_a_success() {
        // K2, decided over the pure half so a root-run CI (where chmod is a
        // suggestion) pins it anyway: absence converges, a refusal stops.
        let p = Path::new("/data/subshell.db");
        assert!(delete_outcome(Ok(()), p).is_none());
        assert!(
            delete_outcome(Err(std::io::Error::from_raw_os_error(2)), p).is_none(),
            "already-deleted is the step succeeding, so Retry converges"
        );
        let survived = delete_outcome(Err(std::io::Error::from_raw_os_error(13)), p)
            .expect("a refusal must surface, never a silent ok:true");
        assert!(
            survived.contains("/data/subshell.db"),
            "the message names the path that survived"
        );
    }

    #[test]
    fn retry_past_an_uninstalled_service_walks_past_the_clis_stop_refusal() {
        // The review's convergence finding, over the pure mechanism: after
        // step 4 uninstalls and step 5 fails, Retry's stop meets
        // `controlService`'s refusal - exit 1, "nothing installed: ..." on
        // STDERR (service.ts `errLine` is code 1). The tolerance is pinned to
        // that measured string; the no-tolerance assertion restates the bug
        // this sequence used to have, and the last line names why the old
        // anchor was inert: "not installed" is not a substring here.
        let refused = ActionResult {
            ok: false,
            stdout: String::new(),
            stderr: "subshell-server: nothing installed: no service definition at /home/u/.config/systemd/user/subshell-server.service (run `subshell-server service install` first)\n".into(),
        };
        let mut log = String::new();
        assert!(
            push_step(&mut log, &refused, &["nothing installed"]).is_none(),
            "a tolerated refusal walks on"
        );
        assert!(
            log.contains("nothing installed"),
            "and the CLI's words still render verbatim"
        );
        let mut strict = String::new();
        assert!(
            push_step(&mut strict, &refused, &[]).is_some(),
            "untolerated, it ends the chain - which is how Retry used to die forever"
        );
        assert!(
            !refused.stderr.contains("not installed"),
            "the phrase the code used to carry matches nothing the CLI emits"
        );
    }

    #[test]
    fn every_kill_answer_lands_in_exactly_one_arm() {
        // PR review round 2's follow-up: the sweep's per-socket decision,
        // pinned so an early exit-as-success from the loop has to be
        // rewritten into the loop to exist again.
        let killed = Run {
            code: Some(0),
            stdout: String::new(),
            stderr: String::new(),
            timed_out: false,
        };
        assert!(matches!(
            socket_kill_outcome(&killed, "subshell-abc"),
            SocketOutcome::Closed
        ));
        let dead_server = Run {
            code: Some(1),
            stdout: String::new(),
            stderr: "error connecting to /tmp/tmux-1000/subshell-abc (No such file or directory)".into(),
            timed_out: false,
        };
        assert!(matches!(
            socket_kill_outcome(&dead_server, "subshell-abc"),
            SocketOutcome::Stale
        ));
        // tmux's OTHER spelling for a dead server, and the one that actually
        // happens: the socket inode outlives its server, so tmux connects and
        // finds nobody. Measured against tmux 3.7c on a real leftover socket.
        // Reading it as a failure stopped the chain on the first such file,
        // and a box that has run this product's tests holds thousands.
        let dead_but_present = Run {
            code: Some(1),
            stdout: String::new(),
            stderr: "no server running on /private/tmp/tmux-501/subshell-abc".into(),
            timed_out: false,
        };
        assert!(matches!(
            socket_kill_outcome(&dead_but_present, "subshell-abc"),
            SocketOutcome::Stale
        ));
        let refused = Run {
            code: Some(1),
            stdout: String::new(),
            stderr: "can't lock socket".into(),
            timed_out: false,
        };
        match socket_kill_outcome(&refused, "subshell-abc") {
            SocketOutcome::Failed(d) => {
                assert!(d.contains("subshell-abc") && d.contains("can't lock socket"));
            }
            _ => panic!("a refusal names the server that survived"),
        }
        // The exact shape this finding started from: a spawn that never
        // started is no longer the "no tmux" case. That fact belongs to the
        // pre-loop which(); here it is a pane that may have survived.
        let unspawned = Run {
            code: None,
            stdout: String::new(),
            stderr: "spawn failed: Resource temporarily unavailable".into(),
            timed_out: false,
        };
        assert!(matches!(
            socket_kill_outcome(&unspawned, "subshell-abc"),
            SocketOutcome::Failed(_)
        ));
    }
}
