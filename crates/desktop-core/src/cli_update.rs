//! Handing a bundled binary to the INSTALLED CLI's own `update --from`
//! (spec 2026-09-15 § 7.1).
//!
//! Both apps ship a CLI beside themselves and both used to install it the same
//! way: [`crate::sidecar::install_bundled`], a `rename(2)` over
//! `~/.local/bin/<name>`. That is still right for a FIRST install — there is no
//! installed CLI to ask. It is wrong for a REPLACE, and the reason has nothing
//! to do with copying: an update is a TRANSACTION now — a database backup, a
//! `pending.json` marker, `<binary>.previous`, and a boot that either completes
//! it or reverts it — and every one of those steps lives in the CLI. A desktop
//! app that copied the file itself would be the one update path on the machine
//! with no backup behind it and nothing to roll back to.
//!
//! So on the replace path the app runs
//! `<installed> update --from <sidecar> --yes --no-restart --json` and reports
//! what the CLI says. Three things about that argv are load-bearing, which is
//! why it is built here once rather than spelled out in two apps:
//!
//! - **`--from`**, so the CLI installs the file this app ships rather than
//!   going to the network. There is no digest to check because there is no
//!   release to check it against; the CLI probes the file's own `version`
//!   instead, and refuses a file that cannot answer.
//! - **`--yes`**, because the consent already happened — on the screen that
//!   named the versions, in the app.
//! - **`--no-restart`**, because the restart is the app's second step and only
//!   the app can take it: in the server app's own supervision mode there is no
//!   service manager to ask, and the node app deliberately does not restart at
//!   all (it says so on the screen instead).
//!
//! **One installed CLI cannot be asked: one that predates the verb.** Every
//! install in existence on 2026-09-15 does — `subshell-server` 0.6.0 and
//! `subshell` 0.8.0 were cut before `update` was written — so the app's offer
//! would fail on exactly the upgrade it exists for. [`lacks_update_verb`]
//! recognises that ONE case from the CLI's own words and the caller falls back
//! to [`crate::sidecar::install_bundled`], saying on the screen what the
//! fallback could not do. Every OTHER failure stays a failure: falling back on
//! a pane-safety refusal, an unwritable path or a version mismatch would skip
//! the backup while reporting success, which is the outcome this whole module
//! exists to prevent.
//!
//! This module is the PURE half — the argv, the report parse, the detection and
//! the sentences. Running anything, and deciding whether this machine is on the
//! replace path at all, stays in each app's `control.rs` with its own probe.

use std::path::Path;

use serde::Deserialize;

use crate::proc::Run;

/// The CLI's `--json` tail for a completed update.
///
/// Emitted by `apps/server/api/src/commands/update.ts` (and the node agent's
/// twin) as the LAST line of stdout, after the human-readable step lines. The
/// app reads it to say what actually changed rather than restating what it
/// asked for: the `from` is the version that WAS installed, which this side
/// only ever knew through a probe that may be seconds stale.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct UpdateReport {
    /// The version that was installed before the swap.
    pub from: String,
    /// The version now at the installed path.
    pub to: String,
    /// Where the database snapshot went, when one was taken.
    ///
    /// `None` covers two different facts that the screen does not need to
    /// distinguish and this type therefore does not: a server with no database
    /// yet, and the node agent, which has no database at all.
    #[serde(default)]
    pub backup: Option<String>,
}

/// The argv tail for a delegated update — everything after the binary itself.
///
/// One spelling, two callers. The flags are a CONTRACT with the CLI rather
/// than a preference (see the module docs), and a fifth flag appearing in one
/// app and not the other is the drift this exists to prevent.
pub fn update_args(sidecar: &Path) -> Vec<String> {
    vec![
        "update".into(),
        "--from".into(),
        sidecar.to_string_lossy().into_owned(),
        "--yes".into(),
        "--no-restart".into(),
        "--json".into(),
    ]
}

/// The `--json` tail out of a CLI run's stdout, or `None` when there is none.
///
/// Scans BACKWARDS for the first line that parses as a report, because the
/// human-readable step lines come first and one of them ("Backed up the
/// database to …") legitimately contains a path. Taking the last line blindly
/// would break the moment the CLI prints anything after its own JSON; parsing
/// every line and keeping the last match is the same cost and does not.
///
/// A `None` is not a failure: an update the CLI declined to perform (already
/// at this version) exits 0 and prints prose, and the screen shows that prose.
pub fn parse_update_report(stdout: &str) -> Option<UpdateReport> {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .filter(|line| line.starts_with('{'))
        .find_map(|line| serde_json::from_str::<UpdateReport>(line).ok())
}

/// The marker both CLIs print when handed a verb they do not have.
///
/// MEASURED against the released tags rather than the working tree, because
/// the binaries this has to recognise are the OLD ones:
///
/// | binary | what it prints | exit |
/// |---|---|---|
/// | `subshell-server` 0.6.0 | `subshell-server: unknown command 'update'` + the usage block, on stderr | 1 |
/// | `subshell` 0.8.0 | `unknown command 'update'`, on stderr | 2 |
///
/// The EXIT CODES DISAGREE (the agent routes usage errors through
/// `fail(2, UsageError)`), which is why this keys on the marker and asks only
/// that the run failed. Pinning 1 would have silently excluded every node
/// agent; pinning "1 or 2" would bind a number neither CLI promises.
const UNKNOWN_UPDATE_MARKER: &str = "unknown command 'update'";

/// Whether a finished run is the installed CLI saying it has no `update` verb.
///
/// The ONE failure the caller may answer by falling back to a plain copy, so
/// it is deliberately the narrowest test that can identify it:
///
/// - **The command must have RUN and failed.** `code: None` is a deadline or a
///   spawn error — a binary that never answered is not a binary without a
///   verb, and treating it as one would install over a machine whose state
///   nobody established.
/// - **The marker must be in its own output.** Only the CLIs' command
///   dispatcher can print it, and only for a word it does not know. Every real
///   refusal — the pane guard, an unwritable binary, a digest mismatch, a
///   version the downloaded file does not confirm — prints something else, so
///   none of them can reach the fallback.
///
/// Both streams are scanned because the two CLIs differ in where usage text
/// lands and neither promises to keep it there.
pub fn lacks_update_verb(run: &Run) -> bool {
    if run.code.is_none() || run.ok() {
        return false;
    }
    run.stderr.contains(UNKNOWN_UPDATE_MARKER) || run.stdout.contains(UNKNOWN_UPDATE_MARKER)
}

/// What a fallback install could NOT record, which differs by app.
///
/// The server's `update` takes a database snapshot and keeps `.previous`; the
/// agent has no database and keeps only `.previous`. Saying "no database
/// backup was taken" on the agent would name something its own `update` never
/// does either — alarming about the wrong thing, which is the defect the reset
/// label's history documents at length.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unrecorded {
    /// Subshell Server: the database snapshot, and with it the rollback.
    DatabaseBackup,
    /// Subshell Client: the rollback point alone.
    Rollback,
}

/// One sentence for an install that had to bypass the transaction.
///
/// Says what happened, then what it could not do and why — in that order,
/// because the install SUCCEEDED and a reader who stops after the first
/// sentence has not been misled. It names the missing backup explicitly rather
/// than staying silent: a person who later needs to undo this has to learn it
/// now, not when they go looking for a `.previous` that is not there.
///
/// @param from - the version being replaced, when the probe knew it
/// @param to - the version being installed, when this build knows it
/// @param what - `"server"` or `"agent"`
pub fn legacy_install_summary(from: Option<&str>, to: Option<&str>, what: &str, missing: Unrecorded) -> String {
    let installed = match (to, from) {
        (Some(to), Some(from)) => format!("Installed {to} over {from}."),
        (Some(to), None) => format!("Installed {to}."),
        // A version neither side can name is still an install that happened,
        // and the sentence after this one is the part that matters.
        (None, _) => format!("Installed the bundled {what}."),
    };
    let lost = match missing {
        Unrecorded::DatabaseBackup => "No database backup was taken",
        Unrecorded::Rollback => "No rollback point was recorded",
    };
    let undo = match missing {
        Unrecorded::DatabaseBackup => "rolled back",
        Unrecorded::Rollback => "undone",
    };
    format!(
        "{installed} {lost}: the previous {what} predates the update command, \
         so this install cannot be {undo} automatically."
    )
}

/// One sentence naming what the delegated update did.
///
/// Appended to the CLI's own output rather than replacing it: the CLI owns
/// every operator-facing message in both apps, and this adds the one fact the
/// steps state only in pieces — that this machine moved from one version to
/// another, and where the thing that makes it reversible went.
///
/// The backup half appears only when there IS one, which is what lets one
/// function serve both apps: the node agent has no database, so its report
/// never carries the field and the sentence never mentions it.
///
/// @param what - the noun for the binary that moved: `"server"` or `"agent"`
pub fn update_summary(report: &UpdateReport, what: &str) -> String {
    let head = format!("Updated the installed {what} from {} to {}.", report.from, report.to);
    match report.backup.as_deref() {
        Some(path) if !path.is_empty() => format!("{head} The database was backed up to {path}."),
        _ => head,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // The flags ARE the contract — see the module docs. A test on the exact
    // list is what makes a fifth flag a decision rather than an accident.
    #[test]
    fn the_argv_is_the_flag_contract() {
        let args = update_args(&PathBuf::from("/tmp/subshell-server-bundled"));
        assert_eq!(
            args,
            vec![
                "update".to_string(),
                "--from".into(),
                "/tmp/subshell-server-bundled".into(),
                "--yes".into(),
                "--no-restart".into(),
                "--json".into(),
            ]
        );
    }

    #[test]
    fn reads_the_json_tail_after_the_step_lines() {
        let stdout = concat!(
            "Backed up the database to /data/backups/subshell-v0.6.0-20260915-120000.db.\n",
            "Installed 0.7.0 at /home/x/.local/bin/subshell-server.\n",
            "Not restarting (--no-restart). The update completes at the next start.\n",
            r#"{"from":"0.6.0","to":"0.7.0","restarted":false,"backup":"/data/backups/subshell-v0.6.0-20260915-120000.db"}"#,
            "\n"
        );
        let report = parse_update_report(stdout).expect("a report");
        assert_eq!(report.from, "0.6.0");
        assert_eq!(report.to, "0.7.0");
        assert_eq!(
            report.backup.as_deref(),
            Some("/data/backups/subshell-v0.6.0-20260915-120000.db")
        );
    }

    // The node agent has no database, so its tail carries no `backup` at all.
    // An absent field is not a parse failure, or the client app would report
    // every successful update as one that said nothing.
    #[test]
    fn an_absent_backup_field_still_parses() {
        let report = parse_update_report(r#"{"from":"0.8.0","to":"0.9.0","restarted":false}"#).expect("a report");
        assert_eq!(report.backup, None);
        assert_eq!(
            update_summary(&report, "agent"),
            "Updated the installed agent from 0.8.0 to 0.9.0."
        );
    }

    // "Already at 0.7.0." exits 0 and prints no JSON. That is a legitimate
    // outcome the screen shows verbatim, not something to fail on.
    #[test]
    fn prose_with_no_json_is_no_report() {
        assert_eq!(parse_update_report("Already at 0.7.0.\n"), None);
        assert_eq!(parse_update_report(""), None);
    }

    // A step line that merely CONTAINS a brace must not be mistaken for the
    // tail, and a line after the tail must not hide it.
    #[test]
    fn finds_the_last_parsable_object_not_the_last_line() {
        let stdout = concat!(
            r#"{"from":"0.5.0","to":"0.6.0"}"#,
            "\n",
            r#"{"from":"0.6.0","to":"0.7.0"}"#,
            "\nDone.\n"
        );
        let report = parse_update_report(stdout).expect("a report");
        assert_eq!(report.to, "0.7.0");
    }

    fn run_of(code: Option<i32>, stdout: &str, stderr: &str) -> Run {
        Run {
            code,
            stdout: stdout.into(),
            stderr: stderr.into(),
            timed_out: false,
        }
    }

    /// The two lines these old binaries actually print, transcribed from the
    /// RELEASED tags rather than from the working tree — the binaries this has
    /// to recognise are the ones that predate the verb.
    ///
    /// `server-v0.6.0` `apps/server/api/src/cli.ts`:
    ///   `error(\`subshell-server: unknown command '${command}'\`)`, then
    ///   `error(USAGE)`, then `exit(1)`.
    /// `node-v0.8.0` `apps/node/agent/src/cli.ts`:
    ///   `return fail(2, new UsageError(\`unknown command '${parsed.command}'\`))`.
    const SERVER_0_6_0_STDERR: &str =
        "subshell-server: unknown command 'update'\nusage:\n  subshell-server init\n  subshell-server status\n";
    const NODE_0_8_0_STDERR: &str = "unknown command 'update'\n";

    // The whole point of the fallback: every install that exists today
    // predates the verb, so without this the desktop offer fails on exactly
    // the upgrade it is there for.
    #[test]
    fn a_cli_without_the_verb_is_recognised_on_both_apps_exit_codes() {
        // The two DISAGREE on the code — the server exits 1, the agent routes
        // usage errors through fail(2). Keying on either number would have
        // silently excluded one app.
        assert!(lacks_update_verb(&run_of(Some(1), "", SERVER_0_6_0_STDERR)));
        assert!(lacks_update_verb(&run_of(Some(2), "", NODE_0_8_0_STDERR)));
        // And on stdout, in case a future CLI moves its usage text there.
        assert!(lacks_update_verb(&run_of(Some(1), NODE_0_8_0_STDERR, "")));
    }

    // The refusals that must NEVER fall back. Each is a real answer about this
    // machine, and copying the binary anyway would skip the backup while
    // reporting success — the one outcome worse than a confusing error.
    #[test]
    fn a_real_refusal_never_looks_like_a_missing_verb() {
        for stderr in [
            "subshell-server: refusing to restart: this service definition would close every running subshell; --force",
            "subshell-server: cannot replace /usr/local/bin/subshell-server: not writable",
            "subshell-server: the downloaded binary reports 0.6.0, not 0.7.0",
            "subshell-server: an update is already in progress; `subshell-server update --rollback` if it is stuck",
            "subshell-server: could not back up the database: disk full",
            "subshell: not a compiled agent",
        ] {
            assert!(!lacks_update_verb(&run_of(Some(1), "", stderr)), "{stderr}");
        }
    }

    // A binary that never answered is not a binary without a verb. `code:
    // None` is a deadline or a spawn failure, and installing over a machine
    // whose state nobody established is the opposite of what this is for.
    #[test]
    fn a_run_that_never_finished_is_not_a_missing_verb() {
        assert!(!lacks_update_verb(&Run {
            code: None,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: true,
        }));
        // Nor is a spawn error, even one whose text mentions the command.
        assert!(!lacks_update_verb(&run_of(
            None,
            "",
            "spawn failed: No such file or directory"
        )));
    }

    // A SUCCESS is never a fallback, however odd its output: the CLI did the
    // work, and the report parse is what reads it.
    #[test]
    fn a_successful_run_is_never_a_missing_verb() {
        assert!(!lacks_update_verb(&run_of(Some(0), "", SERVER_0_6_0_STDERR)));
    }

    // The sentence has to NAME what it could not do. A fallback that reported
    // a bare "Installed 0.7.0." would leave someone looking for a `.previous`
    // that is not there, months later, with nothing to explain it.
    #[test]
    fn the_fallback_sentence_names_the_missing_backup() {
        let said = legacy_install_summary(Some("0.6.0"), Some("0.7.0"), "server", Unrecorded::DatabaseBackup);
        assert_eq!(
            said,
            "Installed 0.7.0 over 0.6.0. No database backup was taken: the previous server predates \
             the update command, so this install cannot be rolled back automatically."
        );
    }

    // The agent has no database, so claiming a missing DATABASE backup would
    // name something its own `update` never does either — alarming about the
    // wrong thing. What it really loses is the rollback point.
    #[test]
    fn the_nodes_sentence_claims_no_database() {
        let said = legacy_install_summary(Some("0.8.0"), Some("0.9.0"), "node CLI", Unrecorded::Rollback);
        assert!(!said.contains("database"), "{said}");
        assert_eq!(
            said,
            "Installed 0.9.0 over 0.8.0. No rollback point was recorded: the previous node CLI predates \
             the update command, so this install cannot be undone automatically."
        );
    }

    // A version neither side can name is still an install that happened, and
    // the warning after it is the part that matters — so it is never dropped.
    #[test]
    fn an_unknown_version_still_warns() {
        let neither = legacy_install_summary(None, None, "server", Unrecorded::DatabaseBackup);
        assert!(neither.starts_with("Installed the bundled server."), "{neither}");
        assert!(neither.contains("No database backup was taken"), "{neither}");
        let no_from = legacy_install_summary(None, Some("0.7.0"), "server", Unrecorded::DatabaseBackup);
        assert!(no_from.starts_with("Installed 0.7.0."), "{no_from}");
        assert!(no_from.contains("predates the update command"), "{no_from}");
    }

    #[test]
    fn the_backup_sentence_names_the_path() {
        let report = UpdateReport {
            from: "0.6.0".into(),
            to: "0.7.0".into(),
            backup: Some("/data/backups/x.db".into()),
        };
        assert_eq!(
            update_summary(&report, "server"),
            "Updated the installed server from 0.6.0 to 0.7.0. The database was backed up to /data/backups/x.db."
        );
    }

    // `backup: null` and `backup: ""` are both "there was nothing to back up";
    // a sentence naming an empty path is worse than no sentence.
    #[test]
    fn an_empty_backup_path_says_nothing_about_a_backup() {
        let report = UpdateReport {
            from: "0.6.0".into(),
            to: "0.7.0".into(),
            backup: Some(String::new()),
        };
        assert_eq!(
            update_summary(&report, "server"),
            "Updated the installed server from 0.6.0 to 0.7.0."
        );
    }
}
