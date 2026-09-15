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
//! This module is the PURE half — the argv and the report parse. Running it,
//! and deciding whether this machine is on the replace path at all, stays in
//! each app's `control.rs` with its own probe.

use std::path::Path;

use serde::Deserialize;

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
