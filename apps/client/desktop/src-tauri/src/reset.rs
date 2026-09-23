//! Resetting this machine's node back to un-enrolled: the stashed consent and
//! the chain that honours it (spec 2026-09-11 § 5).
//!
//! Same shape as `apps/server/desktop`'s reset, and deliberately so: the page
//! supplies a hostname, never a path; the plan is read from the CLI's own
//! `status --json` at press time and stashed, because the chain uninstalls the
//! very agent whose report names those paths; and the guards are the shared
//! ones in `subshell_desktop_core::reset_guards`, so the two apps cannot drift
//! about what is safe to delete.
//!
//! What differs: three paths rather than five, and NO window dance. The server
//! app has one manage window and a zero-window moment quits it; this app's two
//! windows are a remote plane window and this page, and resetting the node
//! invalidates neither — the plane is still a plane, and this page's own
//! re-probe lands it on Enroll.
//!
//! Channel discipline is the crate's: `Err` only for refusals that fire BEFORE
//! the first mutation, and a half-run is `Ok(ActionResult { ok: false, stdout:
//! log, stderr })` with the plan still stashed so a Retry converges.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use subshell_desktop_core::proc::{run, ACTION_TIMEOUT};
use subshell_desktop_core::reset_guards::{
    consent_granted, delete_guard_ok, is_subshell_socket, machine_hostname, path_rules_ok,
};
use subshell_desktop_core::settings::SettingsState;
use subshell_desktop_core::sidecar;

use crate::control::{ActionResult, ServiceCommand};
use crate::node_bin::NODE_SIDECAR;

/// The three paths a confirmed reset deletes, read off a fresh `status --json`.
///
/// DATA, quoted from the agent's own report rather than re-derived from env:
/// a reset that deleted what THIS side guessed instead of what the CLI named
/// would be deleting one directory while promising another.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletePlan {
    /// `~/.config/subshell/config.json` — 0600, and the node key's only home.
    pub config_file: PathBuf,
    /// `daemon.lock`, the local-liveness file `status` reads.
    pub lock_file: PathBuf,
    /// The identity/state directory: the node keypair, the allowlist, pane
    /// logs and per-subshell MCP configs.
    pub data_dir: PathBuf,
}

/// All-or-nothing: every path present, non-empty and absolute, or there is no
/// plan. A partial block deleted and reported as a completed reset is the
/// failure this shape exists to refuse.
///
/// A status with no `paths` key at all is the NOT-ENROLLED case — the CLI
/// omits the block when no config loaded — and answers `None` for the same
/// reason: there is nothing to delete, so there is nothing to consent to.
///
/// **The block is read key by key, never swept**, which is what lets the CLI
/// report a path this app does not delete. Two do: `binary` (the installed
/// CLI, which the containment guard refuses to take) and, since 2026-09-18,
/// `agentLog` — the agent's own capped log, deliberately left behind. It is
/// the record of the reset itself, it holds no credential, and it is bounded
/// at 200 KB and replaced when full, so nothing about it grows. A key added
/// to that block later joins that list by default rather than becoming a
/// deletion target by accident.
pub fn parse_delete_plan(status: &Value) -> Option<DeletePlan> {
    let abs = |v: Option<&Value>| -> Option<PathBuf> {
        let s = v?.as_str()?;
        (!s.is_empty() && Path::new(s).is_absolute()).then(|| PathBuf::from(s))
    };
    let paths = status.get("paths")?;
    Some(DeletePlan {
        config_file: abs(paths.get("configFile"))?,
        lock_file: abs(paths.get("lockFile"))?,
        data_dir: abs(paths.get("dataDir"))?,
    })
}

/// The deletion order, as a value rather than a sequence of statements, so the
/// one property that matters is testable without running a wipe.
///
/// **config.json is LAST.** It is the file that makes this machine a node, so
/// while it survives the reset is resumable: a half-run that died after the
/// data dir still has the config the next attempt reads its plan from. Deleting
/// it first would strand every later step with nothing naming its paths.
pub fn deletion_order(plan: &DeletePlan) -> Vec<PathBuf> {
    vec![plan.data_dir.clone(), plan.lock_file.clone(), plan.config_file.clone()]
}

/// What a reset press leaves behind: the plan, until the consent is spent.
#[derive(Default)]
pub struct Stash {
    pub plan: Mutex<Option<DeletePlan>>,
}

/// Read the machine NOW and stash a validated delete plan.
///
/// The plan is taken at press time rather than inside [`node_reset`] because
/// the chain uninstalls the very agent whose `status --json` reports those
/// paths — re-reading afterwards would be asking a removed binary where its
/// own data lived. Answers whether a plan parsed; `false` means the screen
/// renders its own refusal (this machine is not enrolled), which is the useful
/// information.
#[tauri::command(async)]
pub fn node_arm_reset(app: AppHandle, settings: State<'_, SettingsState>) -> bool {
    let p = crate::control::probe_now(settings.get().binary_path.as_deref());
    let plan = p.status.as_ref().and_then(parse_delete_plan);
    let armed = plan.is_some();
    *app.state::<Stash>().plan.lock().unwrap() = plan;
    armed
}

/// Return this machine to un-enrolled, with the typed hostname as consent.
///
/// The order is the confirmation's: stop the service, close this node's pane
/// servers, uninstall the service, then delete the data dir, the lock file and
/// config.json — config last. Every guard that can refuse fires before the
/// first mutation; every failure after that is a half-run answered `ok: false`
/// with the verbatim log, plan still stashed so a Retry converges.
///
/// What it deliberately does NOT reach is worth stating because the screen
/// states it: the installed `~/.local/bin/subshell` stays (the containment
/// guard refuses any delete that would take it), and the control plane's own
/// node row stays, now permanently offline, for an admin to remove.
#[tauri::command(async)]
pub fn node_reset(app: AppHandle, settings: State<'_, SettingsState>, typed: String) -> Result<ActionResult, String> {
    // The typed string must equal the memo the screen was built from: two
    // reads of one OnceLock, never a re-spawn that could race a rename
    // mid-session into an instruction nobody typed. An EMPTY memo — hostname(1)
    // would not run — is refused by name, because the empty box it would
    // otherwise match is the one thing this gate may never accept.
    let memo = machine_hostname();
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
    // The one thing the confirmation promised to keep: this app's managed copy
    // of the node CLI, resolved exactly as the installer resolves it.
    let keep = sidecar::install_path(&NODE_SIDECAR)
        .ok_or_else(|| "cannot locate this app's managed node CLI copy to protect it".to_string())?;
    // Canonicalize so containment compares real locations rather than
    // spellings. An ABSENT binary keeps the uncanonicalized path and
    // containment still refuses a target that would contain it: that path is
    // where the binary would be reinstalled, so deleting its ancestor is what
    // should stop the chain even with no file standing there yet.
    let keep = match std::fs::canonicalize(&keep) {
        Ok(k) => k,
        Err(e) if e.kind() == ErrorKind::NotFound => keep,
        Err(e) => return Err(format!("cannot resolve the protected path {keep:?}: {e}")),
    };
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "HOME is unset; reset refuses to delete with no home to guard".to_string())?;

    for p in deletion_order(&plan) {
        if !path_rules_ok(&p, &home) {
            return Err(format!("refusing to delete {p:?}: fails the shape rules"));
        }
    }
    // Only the RECURSIVE delete gets the containment guard. The other two are
    // single files, so their parent directories are never removed and guarding
    // them could only refuse a reset that was never going to reach the binary.
    if plan.data_dir.exists() {
        let canonical = std::fs::canonicalize(&plan.data_dir).map_err(|e| {
            format!(
                "cannot resolve {:?} to guard it against the protected binary: {e}",
                plan.data_dir
            )
        })?;
        if !delete_guard_ok(&canonical, &keep) {
            return Err(format!(
                "refusing to delete {:?}: it contains the installed node binary this reset promises to keep",
                plan.data_dir
            ));
        }
    }

    let mut log = String::new();
    // 1. Stop. Tolerates the CLI's refusal for a machine with no service:
    // without it a Retry after any later failure dies here forever, because
    // the uninstall in a half-run already removed what this step refuses on.
    let stop = crate::control::service_now(&settings, ServiceCommand::Stop, false, true);
    if let Some(stderr) = push_step(&mut log, &stop, SERVICE_TOLERATED) {
        return Ok(ActionResult {
            ok: false,
            stdout: log,
            stderr,
        });
    }
    // 2. Close this node's panes (their per-subshell tmux servers). They are
    // children of the daemon and hold the data dir open.
    if let Some(detail) = close_subshell_tmux(&mut log) {
        return Ok(ActionResult {
            ok: false,
            stdout: log,
            stderr: detail,
        });
    }
    // 3. Uninstall the service, while the binary and the config it names still
    // exist — the CLI reads both to know what it is removing.
    let un = crate::control::service_now(&settings, ServiceCommand::Uninstall, false, true);
    if let Some(stderr) = push_step(&mut log, &un, SERVICE_TOLERATED) {
        return Ok(ActionResult {
            ok: false,
            stdout: log,
            stderr,
        });
    }
    // 3b. A daemon that outran both service steps — a hand-run `subshell run`
    // has no definition to stop — is refused BEFORE any delete. Deleting the
    // files under a dialing daemon makes this screen's success a lie: the
    // plane keeps seeing an online node until the process dies on its own,
    // and the lock file comes back under the deleted one. Same reading the
    // node CLI's own un-enroll refusal makes (`--yes` cannot buy that one
    // either). Plan stays stashed: stop the daemon, press Retry, converge.
    if let Some(pid) = live_daemon_pid(&plan.lock_file) {
        return Ok(ActionResult {
            ok: false,
            stdout: log,
            stderr: format!(
                "a node daemon is still running (pid {pid}); stop it (`subshell service stop`, or exit the terminal running `subshell run`) and press Retry"
            ),
        });
    }
    // 4. Delete, absence = done, config.json last. Every deletion's failure
    // ends the chain: a surviving node key announced as a completed reset is
    // worse than a refusal, because the hostname was typed against the promise
    // that THESE bytes are gone.
    for path in deletion_order(&plan) {
        let outcome = if path == plan.data_dir {
            delete_tree(&path, &mut log)
        } else {
            remove_if_exists(&path, &mut log)
        };
        if let Some(detail) = outcome {
            return Ok(ActionResult {
                ok: false,
                stdout: log,
                stderr: detail,
            });
        }
    }
    // Tidy the now-empty config home, after the last consented byte is gone.
    // Fire-and-forget: every file the human confirmed IS deleted at this point,
    // and a directory someone else still has something in changes no consent.
    if let Some(parent) = plan.config_file.parent() {
        let _ = std::fs::remove_dir(parent);
    }
    // 5. This app's own state, which since the plane list includes what
    // `configured()` reads. The saved control-plane LIST and the open-last
    // memory go with everything else (operator ruling, 2026-09-22, on the
    // live window: "the reset everything didn't seem to reset. the app
    // didn't restart to the FTE"): the list is this app's memory of the
    // planes it connects to, keeping it left `configured()` true and the
    // first run unreachable — an address kept past the reset was the whole
    // difference between "wiped" and "still set up". Cosmetic preferences
    // (text size, the tray habit, the update-check timestamps) stay; they
    // are not part of the setup this screen resets, and whoever reset the
    // node still likes their font.
    // A persist failure here must be SAID: the machine's consented bytes are
    // all gone (ok stays true — the reset of THE NODE is complete), but the
    // app's own memory only cleared in this process, and the next launch
    // would read the stale file and be "configured" again — the exact
    // "reset didn't seem to reset" this step exists to kill, resurrected
    // silently. The in-memory clear still stands (SettingsState edits before
    // saving), so THIS session routes to the walk; the sentence names what
    // the next launch will need.
    let settings_note = settings
        .update(|s| {
            s.binary_path = None;
            s.planes.clear();
            s.last_plane_open = None;
        })
        .err()
        .map(|e| format!("the node is reset, but this app could not write its own settings: {e}\n"))
        .unwrap_or_default();
    // The tray mirrors both the list and the node's binding, and both just
    // emptied; its Control Plane submenu rebuilds from the live reads and
    // lands on "No control planes yet".
    crate::tray::refresh(&app);
    *stash.plan.lock().unwrap() = None; // the consent has been spent
    Ok(ActionResult {
        ok: true,
        stdout: log,
        stderr: settings_note,
    })
}

/// The pid of a daemon the lock file says is STILL RUNNING, if any.
///
/// The same reading `subshell status` makes (lock pid + `kill -0`) and the
/// same honesty limit: a recycled pid answers alive. That error direction is
/// the safe one — a false "alive" refuses a reset and names the remedy,
/// while the opposite would delete files under a dialing daemon, which is
/// the half-truth the node CLI's own un-enroll refusal exists to reject.
/// No lock, no parse, or a dead pid is `None`: the absence answers are the
/// reset continuing, exactly as every later delete treats absence as done.
fn live_daemon_pid(lock_file: &Path) -> Option<u32> {
    let body = std::fs::read_to_string(lock_file).ok()?;
    let pid = serde_json::from_str::<Value>(&body).ok()?.get("pid")?.as_u64()?;
    let pid = u32::try_from(pid).ok()?;
    (pid > 0 && run(&["kill".to_string(), "-0".to_string(), pid.to_string()], ACTION_TIMEOUT).ok()).then_some(pid)
}

/// Phrases that mean a service step's GOAL is already true, in the words the
/// CLI answers with. "nothing installed" is the absent definition; "No such
/// process" is launchd's answer to booting out an already-unloaded job —
/// the ORDINARY outcome of an uninstall that follows a stop, since stop IS
/// a bootout on macOS. A released node CLI reports that second bootout as a
/// failure; until the CLI itself stopped doing so (2026-09-22), a chain that
/// refused the phrase stalled every macOS reset and un-enroll between stop
/// and delete — which is how "reset everything" left a configured machine
/// twice on the operator's own host. The job not being loaded IS both
/// steps' goal; systemd answers neither phrase. Both chains read this one
/// list (`node_unenroll` in `control.rs`).
pub(crate) const SERVICE_TOLERATED: &[&str] = &["nothing installed", "No such process"];

/// Append one verb's verbatim words; return `Some(stderr)` when it failed.
///
/// A tolerated phrase (the "already done" answers the chain treats as the step
/// succeeding) still goes into the log — the human reads what the CLI said —
/// but does not end the chain.
pub(crate) fn push_step(log: &mut String, r: &ActionResult, tolerated: &[&str]) -> Option<String> {
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

/// The one decision every deletion shares, kept pure so it is testable where
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

/// Kill the per-subshell tmux servers this product started on this machine.
fn close_subshell_tmux(log: &mut String) -> Option<String> {
    // "No tmux on this machine" is a fact about the machine, established ONCE
    // before the loop: drawing it from one failed kill instead would report
    // the step as succeeding while abandoning every remaining socket, on any
    // spawn failure at all.
    if subshell_desktop_core::shell_env::which("tmux").is_none() {
        log.push_str("tmux is not installed; no pane servers to close\n");
        return None;
    }
    let base_raw = std::env::var("TMUX_TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
    let base = std::fs::canonicalize(&base_raw).unwrap_or_else(|_| PathBuf::from(&base_raw));
    // A uid this side cannot read means a directory this side cannot name,
    // which means zero kills reported as success. So this failure ends the
    // chain, never a silent skip.
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
        // A socket whose server is already gone answers "no server running on
        // …" and is the step succeeding, not a refusal.
        if !r.ok() && !r.stderr.contains("no server running") {
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

    fn full() -> Value {
        json!({
            "nodeId": "n1",
            "paths": {
                "configFile": "/home/u/.config/subshell/config.json",
                "lockFile": "/home/u/.config/subshell/daemon.lock",
                "dataDir": "/home/u/.config/subshell/data",
            }
        })
    }

    // The CLI's block carries more than the three: `binary` (the installed
    // CLI) and `agentLog` (the agent's own capped log). Both are reported so a
    // caller can NAME them; neither is deleted. A reset that swept the block
    // would take out the log that records the reset, and on a machine where
    // the binary sat in the data dir, the agent itself.
    #[test]
    fn keys_beyond_the_three_are_reported_but_never_deleted() {
        let mut v = full();
        v["paths"]["binary"] = json!("/home/u/.local/bin/subshell");
        v["paths"]["agentLog"] = json!("/home/u/.config/subshell/logs/agent.log");
        let plan = parse_delete_plan(&v).expect("extra keys do not refuse the plan");
        assert_eq!(plan, parse_delete_plan(&full()).unwrap());
        let order = deletion_order(&plan);
        assert_eq!(order.len(), 3);
        for path in &order {
            assert!(!path.ends_with("logs/agent.log"), "the agent log is not deleted");
            assert!(!path.ends_with("bin/subshell"), "the installed CLI is not deleted");
        }
    }

    #[test]
    fn a_complete_block_parses() {
        let plan = parse_delete_plan(&full()).expect("a complete block is a plan");
        assert_eq!(plan.config_file, PathBuf::from("/home/u/.config/subshell/config.json"));
        assert_eq!(plan.data_dir, PathBuf::from("/home/u/.config/subshell/data"));
    }

    // All-or-nothing: a subset deleted and reported as a completed reset is
    // the failure this refusal exists for.
    #[test]
    fn each_missing_key_in_turn_refuses_the_whole_plan() {
        for key in ["configFile", "lockFile", "dataDir"] {
            let mut v = full();
            v["paths"].as_object_mut().unwrap().remove(key);
            assert!(parse_delete_plan(&v).is_none(), "{key} missing must refuse");
        }
    }

    #[test]
    fn an_empty_or_relative_path_refuses_the_whole_plan() {
        for key in ["configFile", "lockFile", "dataDir"] {
            let mut v = full();
            v["paths"][key] = json!("");
            assert!(parse_delete_plan(&v).is_none(), "{key} empty must refuse");
            let mut v = full();
            v["paths"][key] = json!("relative/path");
            assert!(parse_delete_plan(&v).is_none(), "{key} relative must refuse");
        }
    }

    // The not-enrolled case: the CLI omits the block entirely when no config
    // loaded, and there is nothing to consent to.
    #[test]
    fn a_status_with_no_paths_block_is_not_a_plan() {
        let v = json!({ "nodeId": null, "online": false, "reason": "no config" });
        assert!(parse_delete_plan(&v).is_none());
    }

    // While config.json survives the reset is resumable: it is what the next
    // attempt reads its plan from.
    #[test]
    fn config_json_is_deleted_last() {
        let plan = parse_delete_plan(&full()).unwrap();
        let order = deletion_order(&plan);
        assert_eq!(order.len(), 3);
        assert_eq!(order.last().unwrap(), &plan.config_file);
        assert_eq!(order.first().unwrap(), &plan.data_dir);
    }

    // The guard that keeps the promise the screen makes: the installed agent
    // stays. A data dir that contained it would take it with the tree.
    #[test]
    fn a_data_dir_containing_the_installed_node_is_refused() {
        let keep = Path::new("/home/u/.local/bin/subshell");
        assert!(!delete_guard_ok(Path::new("/home/u/.local/bin"), keep));
        assert!(!delete_guard_ok(Path::new("/home/u/.local/bin/subshell"), keep));
        assert!(delete_guard_ok(Path::new("/home/u/.config/subshell/data"), keep));
    }

    #[test]
    fn a_tolerated_phrase_logs_but_does_not_end_the_chain() {
        let mut log = String::new();
        let refused = ActionResult {
            ok: false,
            stdout: String::new(),
            stderr: "nothing installed: no service definition at /x\n".into(),
        };
        assert!(push_step(&mut log, &refused, &["nothing installed"]).is_none());
        assert!(log.contains("nothing installed"));
        assert!(push_step(&mut log, &refused, &[]).is_some());
    }

    #[test]
    fn absence_is_a_deletion_succeeding() {
        assert!(delete_outcome(Ok(()), Path::new("/x")).is_none());
        let missing = std::io::Error::new(ErrorKind::NotFound, "gone");
        assert!(delete_outcome(Err(missing), Path::new("/x")).is_none());
        let denied = std::io::Error::new(ErrorKind::PermissionDenied, "nope");
        assert!(delete_outcome(Err(denied), Path::new("/x")).is_some());
    }

    // The chain's tolerance list, pinned by name: launchd's answer to the
    // SECOND bootout (uninstall's, after stop already unloaded the job) must
    // read as the step's goal on both chains, or every macOS reset and
    // un-enroll against a released node CLI stalls between stop and delete
    // — the exact half-run measured twice on the operator's host.
    #[test]
    fn the_double_bootout_answer_is_tolerated_by_both_service_steps() {
        let mut log = String::new();
        let booted_out = ActionResult {
            ok: false,
            stdout: String::new(),
            stderr: "launchctl bootout reported (exit 3): Boot-out failed: 3: No such process; the plist was removed anyway\n".into(),
        };
        assert!(push_step(&mut log, &booted_out, SERVICE_TOLERATED).is_none());
        assert!(log.contains("No such process"));
        // The other phrase the list exists beside: an absent definition.
        let absent = ActionResult {
            ok: false,
            stdout: String::new(),
            stderr: "nothing installed: no launchd plist at /x\n".into(),
        };
        assert!(push_step(&mut log, &absent, SERVICE_TOLERATED).is_none());
    }

    // The guard's reading is `status`'s: a parseable lock naming a LIVE pid
    // answers Some (whatever process actually holds that pid — recycling is
    // the accepted over-refusal), and every absence answer is None so the
    // chain keeps treating absence as "nothing to stop", exactly as the
    // deletes treat absence as done.
    #[test]
    fn the_live_daemon_guard_reads_the_lock_like_status_does() {
        let dir = std::env::temp_dir().join(format!("subshell-reset-guard-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let lock = dir.join("daemon.lock");

        // No file at all, and a file that is not JSON, are both "no answer".
        assert_eq!(live_daemon_pid(&lock), None);
        std::fs::write(&lock, "not json").unwrap();
        assert_eq!(live_daemon_pid(&lock), None);

        // A pid this machine cannot hold alive: far above any pid_max.
        std::fs::write(&lock, r#"{"pid": 268435455, "nodeId": "n"}"#).unwrap();
        assert_eq!(live_daemon_pid(&lock), None);

        // This test process IS alive; its own pid is the cheapest live one.
        let mine = std::process::id();
        std::fs::write(&lock, format!(r#"{{"pid": {mine}, "nodeId": "n"}}"#)).unwrap();
        assert_eq!(live_daemon_pid(&lock), Some(mine));

        // A pid zero is not a process, whatever `kill -0` might answer.
        std::fs::write(&lock, r#"{"pid": 0}"#).unwrap();
        assert_eq!(live_daemon_pid(&lock), None);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
