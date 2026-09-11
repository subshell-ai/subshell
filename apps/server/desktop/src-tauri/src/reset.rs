//! Resetting this machine to a virgin state: the screen request, the stashed
//! consent, and the chain that honours it (spec § 7 of the 2026-09-10 design).
//!
//! The shape of the whole feature is one sentence: **the page supplies a
//! hostname, never a path.** The SPA's danger card asks for typed consent and
//! calls `desktop_open_console({ screen: "reset" })`; the Rust side reads the
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
use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use subshell_desktop_core::proc::{run, ACTION_TIMEOUT};
use subshell_desktop_core::settings::SettingsState;
use subshell_desktop_core::sidecar;

use crate::control::{ActionResult, ServiceCommand};

/// Which console view the page should present when it comes up.
///
/// A closed enum because the request crosses the boundary FROM the server's
/// page: the remote window may name a screen, never a path or a URL
/// (spec § 7.1). Unknown and absent both mean the ordinary console, so a
/// page older than this feature sees exactly what it always saw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Console,
    Reset,
}

impl Screen {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Screen::Console => "console",
            Screen::Reset => "reset",
        }
    }
}

/// Parse the (untrusted, optional) `screen` argument. One accepted word.
pub fn parse_screen(raw: Option<String>) -> Screen {
    match raw.as_deref() {
        Some("reset") => Screen::Reset,
        _ => Screen::Console,
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

/// The shape rules every deletion target must pass: absolute, never the
/// filesystem root, never the home directory itself.
///
/// Pure over the spelling, deliberately — the containment question (does this
/// path hold the binary?) is [`delete_guard_ok`], and the chain canonicalizes
/// both sides before asking it (P3), because a prefix test between a symlinked
/// and a real spelling passes while the delete still reaches the binary.
pub fn path_rules_ok(p: &Path, home: &Path) -> bool {
    p.is_absolute() && p != Path::new("/") && p != home
}

/// Whether deleting `dir` recursively could reach `keep`. False when `dir`
/// IS `keep` or contains it. **Both arguments must be canonicalized by the
/// caller** (P3); a path that exists but cannot be canonicalized is handled
/// as a refusal at the call site, not here.
pub fn delete_guard_ok(dir: &Path, keep: &Path) -> bool {
    dir != keep && !keep.starts_with(dir)
}

/// Whether a tmux socket name is one this product created. Mirrors
/// `tmuxSocketFor` (`subshell-${hash}`) in pane-runtime — a kill must sweep
/// exactly our servers and never a tmux session belonging to anything else
/// on the machine. Pinned to the other side by containment below, the way
/// the installer table pins its TypeScript twin.
pub fn is_subshell_socket(name: &str) -> bool {
    name.starts_with("subshell-")
}

/// What a reset press leaves behind: the requested screen until some page
/// collects it, and the delete plan until the consent is spent.
#[derive(Default)]
pub struct Stash {
    pub screen: Mutex<Option<Screen>>,
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
    if parse_screen(screen.clone()) == Screen::Reset {
        let settings = app.state::<SettingsState>();
        let p = crate::control::probe_now(settings.get().binary_path.as_deref());
        *stash.plan.lock().unwrap() = p.status.as_ref().and_then(parse_delete_plan);
        *stash.screen.lock().unwrap() = Some(Screen::Reset);
    }
    // open_manage_window, not open_console: this runs only once the machine
    // IS onboarded (desktop_open_console gates the rest), and the manage
    // window's own rule — raising the console retires the wizard — must hold
    // for this opener exactly as it holds for the tray, the menu and the
    // pill. Two openers of one window must not disagree about the other.
    let existed = app.get_webview_window("console").is_some();
    crate::windows::open_manage_window(app)?;
    if existed {
        // A live window has no page-load to catch the stash; deliver now.
        if let Some(s) = stash.screen.lock().unwrap().take() {
            if let Some(w) = app.get_webview_window("console") {
                let _ = w.emit("desktop-screen", s.as_str());
            }
        }
    }
    Ok(())
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
    // The typed string must equal the memo the screen was built from (R15):
    // the probe carries the same memoized `machine_hostname` the page
    // rendered, so comparison is two reads of one OnceLock, never a re-spawn
    // that could race a rename mid-session into an instruction nobody typed.
    // A mismatch is a refusal to start, not a failed run: Err.
    if typed.trim() != crate::control::machine_hostname() {
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
    // 2. Stop, tolerating "there is nothing to stop" (the CLI's own words).
    let stop = crate::control::service_now(&settings, ServiceCommand::Stop, false);
    if let Some(stderr) = push_step(&mut log, &stop, &[]) {
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
    let un = crate::control::service_now(&settings, ServiceCommand::Uninstall, false);
    if let Some(stderr) = push_step(&mut log, &un, &["not installed"]) {
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
                                        // 7. Windows, in the order that keeps the app alive (N2; spec § 7.2
                                        // step 7 amended to match): close main (its port just died), OPEN THE
                                        // WIZARD, and close the console last. The order is not cosmetic: if the
                                        // console closed while it was the last window, the zero-window moment
                                        // runs the last-window path, and lib.rs's ExitRequested prevent-exit
                                        // fires only when a `main` window exists — which a reset may well have
                                        // just closed. An app that quits in the middle of the one command that
                                        // is supposed to land the user in the wizard is the failure this order
                                        // forecloses.
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.close();
    }
    match crate::windows::open_wizard(&app) {
        Ok(_) => {
            if let Some(w) = app.get_webview_window("console") {
                let _ = w.close();
            }
        }
        // M2: the machine IS reset; a window that would not build does not
        // undo that, and the stash is already spent, so answering Err here
        // would tell the user the wipe failed on a machine where it fully
        // succeeded — with Retry impossible ("no plan stashed") and no route
        // forward. The console stays open ON PURPOSE in this arm: closing it
        // would be the zero-window moment N2 exists to prevent, with no
        // wizard to replace it.
        Err(e) => log.push_str(&format!(
            "\nthe wizard window could not be opened: {e}\nthis machine is reset; reopen the app to continue setup\n"
        )),
    }
    Ok(ActionResult {
        ok: true,
        stdout: log,
        stderr: String::new(),
    })
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
        if !r.ok() {
            // No tmux binary at all: the spawn never started (no exit code,
            // not a deadline). That is the same fact an absent directory
            // gives — nothing was ever listening — not a failure.
            if r.code.is_none() && !r.timed_out {
                log.push_str("tmux is not installed; no pane servers to close\n");
                return None;
            }
            let combined = format!("{}{}", r.stdout, r.stderr);
            if combined.contains("error connecting") {
                let _ = std::fs::remove_file(dir.join(&name));
                log.push_str(&format!("stale socket {name} removed\n"));
                continue;
            }
            return Some(format!("could not close the pane server {name}: {}", r.detail()));
        }
        log.push_str(&format!("closed pane server {name}\n"));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn screen_parses_closed_and_defaults_open() {
        // Absent and unknown both mean the plain console: a remote page
        // cannot name a screen this enum has not admitted.
        assert_eq!(parse_screen(None), Screen::Console);
        assert_eq!(parse_screen(Some("reset".into())), Screen::Reset);
        assert_eq!(parse_screen(Some("/etc".into())), Screen::Console);
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
    fn default_layout_passes_and_an_ancestor_of_the_binary_does_not() {
        // R13 from both sides + R3's single keep path: the default install's
        // data dir EQUALS the config dir that holds config.env, and that is
        // legal; a data dir that would take the binary with it is not.
        let home = Path::new("/home/u");
        assert!(delete_guard_ok(
            Path::new("/home/u/.config/subshell-server"),
            Path::new("/home/u/.local/bin/subshell-server")
        ));
        assert!(!delete_guard_ok(
            Path::new("/home/u/.local"),
            Path::new("/home/u/.local/bin/subshell-server")
        ));
        assert!(!delete_guard_ok(
            Path::new("/home/u"),
            Path::new("/home/u/.local/bin/subshell-server")
        ));
        assert!(path_rules_ok(Path::new("/data"), home));
        assert!(!path_rules_ok(Path::new("/"), home));
        assert!(!path_rules_ok(Path::new("/home/u"), home));
        assert!(!path_rules_ok(Path::new("relative/path"), home));
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
    fn socket_prefix_selects_only_this_products_servers() {
        // Mirrors tmuxSocketFor (`subshell-${hash}`) in pane-runtime; the
        // containment test below pins the pair like the installer table does.
        assert!(is_subshell_socket("subshell-0a1b2c3d4e5f"));
        assert!(!is_subshell_socket("0a1b2c3d4e5f"));
        assert!(!is_subshell_socket("mywork"));
        const RUNTIME: &str = include_str!("../../../../../packages/pane-runtime/src/tmux-runner.ts");
        assert!(
            RUNTIME.contains("`subshell-${hash}`"),
            "the prefix rule moved; update both sides"
        );
    }
}
