//! Finding a `subshell-server` to talk to.
//!
//! The app SHIPS one (see `sidecar.rs`), but it must never assume the shipped
//! copy is the one in charge: the user may already run a server this app knows
//! nothing about, and its service definition is the authority on which binary
//! is installed. So resolution is a ladder, each rung named the way
//! `services/mcp-resolve.ts` names its own, and the answer carries WHERE it
//! came from so the UI can say so.
//!
//! The trap worth knowing about is `execLine()` in `apps/server/src/service.ts`:
//! a compiled binary is recorded alone, but a dev-form install records
//! `[interpreter, script]` — `ExecStart=/path/to/bun /repo/apps/server/src/index.ts`.
//! Anything that reads a service definition has to carry BOTH tokens or it
//! will try to run bun with no script.

use serde::Serialize;
use std::path::Path;
use std::time::Duration;

use crate::proc::{run, QUERY_TIMEOUT};
use crate::shell_env::home_dir;

/// Which rung of the ladder answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ServerSource {
    /// `SUBSHELL_SERVER_BIN`.
    Env,
    /// A path the user chose by hand.
    Configured,
    /// The installed unit/plist — the AUTHORITY on what this machine runs.
    Service,
    /// `~/.local/bin/subshell-server`, where this app installs the bundled one.
    LocalBin,
    /// Somewhere on the login PATH.
    Path,
    /// A conventional install directory.
    WellKnown,
}

/// A resolved server, plus the rung it was found on.
#[derive(Debug, Clone, Serialize)]
pub struct ServerBinary {
    /// The command prefix to invoke — one token for a compiled binary, two for a dev-form install.
    pub argv: Vec<String>,
    pub source: ServerSource,
    /// `<argv> version` output, when it ran and looked like a version.
    pub version: Option<String>,
}

/// The version out of a `subshell-server version` line.
///
/// One parser, three callers (the ladder, the bundled probe, the
/// already-installed check). They were three subtly different string dances,
/// one of which was a `ends_with` that would accept `11.8.0` for `1.8.0`.
pub fn parse_server_version(stdout: &str) -> Option<String> {
    let line = stdout.lines().next()?.trim();
    let version = line.strip_prefix("subshell-server ")?.trim();
    (!version.is_empty()).then(|| version.to_string())
}

/// systemd word-splits `ExecStart=` itself (it is NOT run through a shell), so
/// unpick the double-quoting `systemdQuote` applies to any token containing
/// whitespace, `"` or `\`.
pub fn parse_systemd_exec(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut escaped = false;
    let mut started = false;
    for ch in line.chars() {
        if escaped {
            cur.push(ch);
            escaped = false;
            started = true;
            continue;
        }
        match ch {
            '\\' => {
                escaped = true;
                started = true;
            }
            '"' => {
                in_quotes = !in_quotes;
                started = true;
            }
            c if c.is_whitespace() && !in_quotes => {
                if started {
                    out.push(std::mem::take(&mut cur));
                    started = false;
                }
            }
            c => {
                cur.push(c);
                started = true;
            }
        }
    }
    if started {
        out.push(cur);
    }
    out
}

/// The `ExecStart=` argv of the installed systemd user unit, if there is one.
fn from_systemd_unit() -> Option<Vec<String>> {
    let home = home_dir()?;
    let path = format!("{home}/.config/systemd/user/subshell-server.service");
    let text = std::fs::read_to_string(path).ok()?;
    // Last assignment wins, the same rule systemd applies.
    let line = text
        .lines()
        .filter_map(|l| l.trim().strip_prefix("ExecStart="))
        .next_back()?;
    let argv = parse_systemd_exec(line);
    if argv.is_empty() {
        None
    } else {
        Some(argv)
    }
}

/// The `ProgramArguments` of the installed launchd agent, if there is one.
///
/// Read through `plutil` rather than an XML regex: the plist is ours today,
/// but a binary1 plist is equally valid and would defeat any text predicate.
fn from_launchd_plist() -> Option<Vec<String>> {
    let home = home_dir()?;
    let path = format!("{home}/Library/LaunchAgents/dev.subshell.server.plist");
    if !Path::new(&path).exists() {
        return None;
    }
    let out = run(
        &[
            "/usr/bin/plutil".into(),
            "-extract".into(),
            "ProgramArguments".into(),
            "json".into(),
            "-o".into(),
            "-".into(),
            path,
        ],
        Duration::from_secs(5),
    );
    if !out.ok() {
        return None;
    }
    let argv: Vec<String> = serde_json::from_str(out.stdout.trim()).ok()?;
    if argv.is_empty() {
        None
    } else {
        Some(argv)
    }
}

/// Ask a candidate what it is. A candidate that cannot answer is not a server.
pub fn probe_version(argv: &[String]) -> Option<String> {
    let mut cmd = argv.to_vec();
    cmd.push("version".into());
    let out = run(&cmd, QUERY_TIMEOUT);
    out.ok().then(|| parse_server_version(&out.stdout)).flatten()
}

fn exists(path: &str) -> bool {
    Path::new(path).is_file()
}

/// Where `sidecar.rs` installs the bundled server, and the first place to look
/// for one this app installed on an earlier run.
pub fn managed_install_path() -> Option<String> {
    home_dir().map(|h| format!("{h}/.local/bin/subshell-server"))
}

/// Walk the ladder and return the first rung that yields a binary which can
/// state its own version.
///
/// `configured` is the path the user picked by hand, if any — it outranks
/// everything except an explicit environment override.
pub fn resolve(configured: Option<&str>) -> Option<ServerBinary> {
    resolve_with(&candidates(configured), probe_version, exists)
}

/// The ladder, in order, as (rung, argv) pairs. Pure apart from the
/// environment it reads, so its ORDER is testable without a filesystem.
pub fn candidates(configured: Option<&str>) -> Vec<(ServerSource, Vec<String>)> {
    let mut out: Vec<(ServerSource, Vec<String>)> = Vec::new();
    if let Ok(explicit) = std::env::var("SUBSHELL_SERVER_BIN") {
        if !explicit.is_empty() {
            out.push((ServerSource::Env, vec![explicit]));
        }
    }
    if let Some(path) = configured.filter(|p| !p.is_empty()) {
        out.push((ServerSource::Configured, vec![path.to_string()]));
    }
    // The service definition is the AUTHORITY on what is installed: whatever
    // the manager starts is the server this machine actually runs.
    if let Some(argv) = from_systemd_unit().or_else(from_launchd_plist) {
        out.push((ServerSource::Service, argv));
    }
    if let Some(managed) = managed_install_path() {
        out.push((ServerSource::LocalBin, vec![managed]));
    }
    // The LOGIN path, not the process's. A GUI app inherits
    // `/usr/bin:/bin:/usr/sbin:/sbin`, so searching that would miss exactly the
    // Homebrew/asdf install the user has — while every spawn we make already
    // runs with the login PATH. Searching a narrower PATH than we execute with
    // is the inconsistency that makes "it works in my terminal" true.
    for dir in crate::shell_env::login_path().split(':').filter(|d| !d.is_empty()) {
        out.push((ServerSource::Path, vec![format!("{dir}/subshell-server")]));
    }
    for dir in ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"] {
        out.push((ServerSource::WellKnown, vec![format!("{dir}/subshell-server")]));
    }
    out
}

/// Walk `candidates` and return the first rung that yields a binary which can
/// state its own version. The two effects are injected so the ORDER and the
/// skip rules can be tested without executing anything.
pub fn resolve_with(
    candidates: &[(ServerSource, Vec<String>)],
    mut probe: impl FnMut(&[String]) -> Option<String>,
    file_exists: impl Fn(&str) -> bool,
) -> Option<ServerBinary> {
    let mut seen: Vec<&Vec<String>> = Vec::new();
    for (source, argv) in candidates {
        if argv.is_empty() || seen.contains(&argv) {
            continue;
        }
        seen.push(argv);
        // A two-token dev-form entry names an interpreter, so only the first
        // token is a file we can check cheaply.
        if !file_exists(&argv[0]) {
            continue;
        }
        if let Some(version) = probe(argv) {
            return Some(ServerBinary {
                argv: argv.clone(),
                source: *source,
                version: Some(version),
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_compiled_binary_is_one_token() {
        assert_eq!(
            parse_systemd_exec("/usr/local/bin/subshell-server"),
            vec!["/usr/local/bin/subshell-server"]
        );
    }

    // The execLine() trap: a dev-form install records interpreter + script, and
    // dropping the second token would run bun with nothing to run.
    #[test]
    fn a_dev_form_install_keeps_both_tokens() {
        assert_eq!(
            parse_systemd_exec("/Users/x/.bun/bin/bun /repo/apps/server/src/index.ts"),
            vec!["/Users/x/.bun/bin/bun", "/repo/apps/server/src/index.ts"]
        );
    }

    // systemdQuote double-quotes any token with whitespace — a macOS
    // "Application Support" home is the everyday case.
    #[test]
    fn unpicks_systemd_quoting() {
        assert_eq!(
            parse_systemd_exec("\"/Users/x/Application Support/bin/subshell-server\""),
            vec!["/Users/x/Application Support/bin/subshell-server"]
        );
    }

    #[test]
    fn unpicks_escaped_characters() {
        assert_eq!(
            parse_systemd_exec(r#""/opt/a\"b/subshell-server""#),
            vec!["/opt/a\"b/subshell-server"]
        );
        assert_eq!(
            parse_systemd_exec(r#"/opt/a\ b/subshell-server"#),
            vec!["/opt/a b/subshell-server"]
        );
    }

    #[test]
    fn collapses_runs_of_whitespace() {
        assert_eq!(
            parse_systemd_exec("  /bin/bun   /repo/index.ts  "),
            vec!["/bin/bun", "/repo/index.ts"]
        );
    }

    #[test]
    fn an_empty_line_yields_nothing() {
        assert!(parse_systemd_exec("   ").is_empty());
    }

    // An empty quoted token is a real (if odd) argument and must survive.
    #[test]
    fn keeps_an_explicitly_empty_token() {
        assert_eq!(parse_systemd_exec(r#"/bin/x """#), vec!["/bin/x", ""]);
    }
}

/// What to do about the server this app SHIPS versus the one already installed.
///
/// The asymmetry between the two directions is deliberate and is not a
/// preference: boot runs `migrator.migrateToLatest()`, which is FORWARD-ONLY.
/// Replacing a newer installed server with an older bundled one would point an
/// old binary at a migrated SQLite database, which is a data-loss path rather
/// than a choice worth presenting. So a newer bundled server is OFFERED, and a
/// newer installed server is ADOPTED — never overwritten, never even offered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ServerChoice {
    /// This build ships no server; whatever is installed is all there is.
    NoBundled,
    /// Nothing installed — install the bundled one.
    InstallBundled,
    /// The installed server already is the bundled version.
    UpToDate,
    /// The bundled server is newer. Offer it; never apply it unasked.
    UpgradeAvailable,
    /// The installed server is newer. Use it and say so once.
    AdoptInstalled,
}

/// Decide between the bundled and installed servers. Pure — the whole rule in
/// one place, testable without a filesystem.
pub fn decide_server(bundled: Option<&str>, installed: Option<&str>) -> ServerChoice {
    match (bundled, installed) {
        (None, _) => ServerChoice::NoBundled,
        // An installed server that cannot state its version never resolves in
        // the first place, so "absent" and "unparseable" are already one case.
        (Some(_), None) => ServerChoice::InstallBundled,
        (Some(b), Some(i)) if crate::version::version_lt(i, b) => ServerChoice::UpgradeAvailable,
        (Some(b), Some(i)) if crate::version::version_lt(b, i) => ServerChoice::AdoptInstalled,
        _ => ServerChoice::UpToDate,
    }
}

#[cfg(test)]
mod ladder_tests {
    use super::*;

    fn rung(source: ServerSource, path: &str) -> (ServerSource, Vec<String>) {
        (source, vec![path.to_string()])
    }

    /// A probe that answers for a named set of paths and refuses everything else.
    fn probe_for(known: &'static [&'static str]) -> impl Fn(&[String]) -> Option<String> {
        move |argv| known.contains(&argv[0].as_str()).then(|| "1.8.0".to_string())
    }

    #[test]
    fn takes_the_first_rung_that_answers() {
        let c = vec![
            rung(ServerSource::Env, "/env/subshell-server"),
            rung(ServerSource::Service, "/svc/subshell-server"),
        ];
        let found = resolve_with(&c, probe_for(&["/env/subshell-server", "/svc/subshell-server"]), |_| {
            true
        })
        .unwrap();
        assert_eq!(found.source, ServerSource::Env);
    }

    // A file can exist and still not be a server — a shim, a wrapper, an old
    // build. Existence alone must never end the search.
    #[test]
    fn a_file_that_exists_but_is_not_a_server_is_skipped() {
        let c = vec![
            rung(ServerSource::Configured, "/not/a/server"),
            rung(ServerSource::LocalBin, "/good/subshell-server"),
        ];
        let found = resolve_with(&c, probe_for(&["/good/subshell-server"]), |_| true).unwrap();
        assert_eq!(found.source, ServerSource::LocalBin);
        assert_eq!(found.version.as_deref(), Some("1.8.0"));
    }

    #[test]
    fn a_missing_file_is_never_probed() {
        let mut probed: Vec<String> = Vec::new();
        let c = vec![rung(ServerSource::Path, "/gone/subshell-server")];
        let found = resolve_with(
            &c,
            |argv| {
                probed.push(argv[0].clone());
                Some("1.8.0".into())
            },
            |_| false,
        );
        assert!(found.is_none());
        assert!(probed.is_empty(), "probed a file that does not exist: {probed:?}");
    }

    // The ladder repeats paths (a PATH entry can also be a well-known dir), and
    // each probe spawns a ~110 MB binary.
    #[test]
    fn a_repeated_path_is_probed_only_once() {
        let mut count = 0;
        let c = vec![
            rung(ServerSource::Path, "/usr/local/bin/subshell-server"),
            rung(ServerSource::WellKnown, "/usr/local/bin/subshell-server"),
        ];
        let found = resolve_with(
            &c,
            |_| {
                count += 1;
                None
            },
            |_| true,
        );
        assert!(found.is_none());
        assert_eq!(count, 1);
    }

    #[test]
    fn nothing_anywhere_is_none_not_a_panic() {
        assert!(resolve_with(&[], |_| Some("1.8.0".into()), |_| true).is_none());
    }

    // The dev-form install records [interpreter, script]; only the first token
    // is a file to check, and BOTH must reach the probe.
    #[test]
    fn a_two_token_dev_form_entry_survives_intact() {
        let c = vec![(
            ServerSource::Service,
            vec!["/bin/bun".to_string(), "/repo/index.ts".to_string()],
        )];
        let found = resolve_with(
            &c,
            |argv| (argv.len() == 2).then(|| "1.8.0".to_string()),
            |p| p == "/bin/bun",
        )
        .unwrap();
        assert_eq!(found.argv, vec!["/bin/bun", "/repo/index.ts"]);
    }

    // The service definition outranks the copy this app installs: whatever the
    // manager starts is what this machine actually runs.
    //
    // Asserted as a SUBSEQUENCE, because which rungs exist depends on the
    // machine — a host with no installed unit contributes no `Service` rung at
    // all, and a positional comparison there silently inverts (`None` sorts
    // below `Some`) into a test that passes for the wrong reason.
    #[test]
    fn the_real_ladder_keeps_its_documented_order() {
        const CANONICAL: [ServerSource; 6] = [
            ServerSource::Env,
            ServerSource::Configured,
            ServerSource::Service,
            ServerSource::LocalBin,
            ServerSource::Path,
            ServerSource::WellKnown,
        ];
        let mut seen: Vec<ServerSource> = candidates(Some("/chosen/subshell-server"))
            .into_iter()
            .map(|(s, _)| s)
            .collect();
        seen.dedup();
        let mut expected = CANONICAL.iter().copied().peekable();
        for source in &seen {
            while expected.peek().is_some_and(|c| c != source) {
                expected.next();
            }
            assert_eq!(
                expected.next().as_ref(),
                Some(source),
                "rung {source:?} is out of order in {seen:?}"
            );
        }
        // The one rung that is always present, and the configured path must
        // outrank it or a hand-picked binary would be ignored.
        assert!(seen.contains(&ServerSource::Configured));
        assert!(seen.contains(&ServerSource::WellKnown));
    }

    // Every spawn already runs with the login PATH; searching a narrower one
    // would let the ladder fail to FIND a server it could perfectly well run.
    #[test]
    fn the_path_rung_searches_the_login_path() {
        let paths: Vec<String> = candidates(None)
            .into_iter()
            .filter(|(s, _)| *s == ServerSource::Path)
            .map(|(_, a)| a[0].clone())
            .collect();
        for dir in crate::shell_env::login_path().split(':').filter(|d| !d.is_empty()) {
            assert!(
                paths.contains(&format!("{dir}/subshell-server")),
                "login PATH entry {dir} not searched"
            );
        }
    }
}

#[cfg(test)]
mod version_parse_tests {
    use super::*;

    #[test]
    fn reads_the_version_off_the_first_line() {
        assert_eq!(parse_server_version("subshell-server 1.8.0\n"), Some("1.8.0".into()));
        assert_eq!(parse_server_version("subshell-server 1.8.0"), Some("1.8.0".into()));
    }

    #[test]
    fn refuses_anything_that_is_not_that_line() {
        assert_eq!(parse_server_version(""), None);
        assert_eq!(parse_server_version("subshell 1.8.0"), None);
        assert_eq!(parse_server_version("subshell-server "), None);
        assert_eq!(parse_server_version("bash: command not found"), None);
    }
}

#[cfg(test)]
mod choice_tests {
    use super::*;

    #[test]
    fn no_bundled_server_leaves_the_installed_one_alone() {
        assert_eq!(decide_server(None, Some("1.8.0")), ServerChoice::NoBundled);
        assert_eq!(decide_server(None, None), ServerChoice::NoBundled);
    }

    #[test]
    fn nothing_installed_means_install_the_bundled_one() {
        assert_eq!(decide_server(Some("1.8.0"), None), ServerChoice::InstallBundled);
    }

    #[test]
    fn the_same_version_is_up_to_date() {
        assert_eq!(decide_server(Some("1.8.0"), Some("1.8.0")), ServerChoice::UpToDate);
    }

    #[test]
    fn a_newer_bundled_server_is_offered() {
        assert_eq!(
            decide_server(Some("1.9.0"), Some("1.8.0")),
            ServerChoice::UpgradeAvailable
        );
    }

    // Forward-only migrations: an older bundled binary against a migrated
    // database is data loss, so this must never even be presented as a choice.
    #[test]
    fn a_newer_installed_server_is_adopted_never_downgraded() {
        assert_eq!(
            decide_server(Some("1.8.0"), Some("1.9.0")),
            ServerChoice::AdoptInstalled
        );
        assert_eq!(
            decide_server(Some("1.8.0"), Some("2.0.0")),
            ServerChoice::AdoptInstalled
        );
    }

    #[test]
    fn comparison_is_numeric_not_lexical() {
        assert_eq!(
            decide_server(Some("1.10.0"), Some("1.9.0")),
            ServerChoice::UpgradeAvailable
        );
        assert_eq!(
            decide_server(Some("1.9.0"), Some("1.10.0")),
            ServerChoice::AdoptInstalled
        );
    }
}
