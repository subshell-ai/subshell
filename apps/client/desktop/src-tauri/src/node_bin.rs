//! Finding a `subshell` node agent to drive.
//!
//! The app SHIPS one (`subshell_desktop_core::sidecar`, driven from here
//! through [`NODE_SIDECAR`]), but it must never assume the shipped copy is the
//! one in charge: the user may already have installed an agent with
//! `install.sh`, and the installed service definition is the authority on which
//! binary this machine actually runs. So resolution is a ladder, each rung
//! named the way `services/mcp-resolve.ts` names its own, and the answer
//! carries WHERE it came from so the UI can say so.
//!
//! Two traps live in here, both specific to the CLIENT and neither shared with
//! `apps/server/desktop`'s otherwise identical ladder:
//!
//! 1. `execLine()` in `apps/node/agent/src/service.ts` appends the VERB: a
//!    compiled install records `[binary, "run"]` and a dev-form install records
//!    `[interpreter, script, "run"]`. Both tokens of the dev form are needed
//!    (argv[0] alone is `bun`), and the trailing `run` must be dropped, or the
//!    first thing this app does with the resolved argv is `subshell run
//!    version` — which parses as a usage error at best and, if the verb were
//!    ever accepted, starts a second daemon competing with the service.
//! 2. The bundled sidecar is deliberately NOT a rung. See [`candidates`].

use serde::Serialize;
use std::path::Path;

use subshell_desktop_core::proc::{run, PROBE_TIMEOUT, QUERY_TIMEOUT};
use subshell_desktop_core::shell_env::{home_dir, login_path};
use subshell_desktop_core::sidecar::{self, SidecarSpec};
use subshell_desktop_core::version::version_lt;

/// What THIS app's shipped binary is called, and how it announces itself.
///
/// The install dance itself is generic (`subshell_desktop_core::sidecar`);
/// these three strings are the agent-specific half of it. The `version_prefix`
/// keeps its trailing space for a reason that is not formatting: the agent's
/// line is `subshell 1.9.0 (node protocol v1)` and the server app's is
/// `subshell-server 1.9.0`, so without the space this prefix matches the SERVER
/// too and reports its version as `-server`.
pub const NODE_SIDECAR: SidecarSpec = SidecarSpec {
    bundled_name: "subshell-node-bundled",
    installed_name: "subshell",
    version_prefix: "subshell ",
};

/// The desktop app's own override for the resolved agent. Unknown to the CLI —
/// it exists so a developer running `tauri dev` can point the app at a repo
/// build without installing anything.
const NODE_BIN_ENV: &str = "SUBSHELL_NODE_BIN";

/// The systemd user unit `apps/node/agent/src/service.ts` installs.
///
/// Pinned here rather than derived: it is the CLIENT's unit
/// (`subshell.service`), and reading `apps/server/desktop`'s
/// `subshell-server.service` by accident would resolve the wrong product's
/// binary and then drive it with node verbs it does not have.
const SYSTEMD_UNIT: &str = "subshell.service";
/// The launchd label `apps/node/agent/src/service.ts` installs under.
const LAUNCHD_LABEL: &str = "dev.subshell.client";

/// The verb `execLine()` appends to every service definition it writes.
const SERVICE_VERB: &str = "run";

/// Which rung of the ladder answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NodeSource {
    /// [`NODE_BIN_ENV`].
    Env,
    /// A path the user chose by hand.
    Configured,
    /// The installed unit/plist — the AUTHORITY on what this machine runs.
    Service,
    /// `~/.local/bin/subshell`, where this app installs the bundled one.
    LocalBin,
    /// Somewhere on the login PATH.
    Path,
    /// A conventional install directory.
    WellKnown,
}

/// A resolved agent, plus the rung it was found on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeBinary {
    /// The command PREFIX to invoke — one token for a compiled binary, two for
    /// a dev-form install. Never carries a verb: see [`command_prefix`].
    pub argv: Vec<String>,
    pub source: NodeSource,
    /// `<argv> version` output, when it ran and looked like a version.
    pub version: Option<String>,
}

/// The version out of a `subshell <version> (node protocol vN)` line.
pub fn parse_node_version(stdout: &str) -> Option<String> {
    sidecar::parse_version_line(stdout, NODE_SIDECAR.version_prefix)
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

/// Turn a service definition's argv into a command PREFIX this app can append
/// its own verb to.
///
/// `execLine()` writes `[binary, "run"]` or `[interpreter, script, "run"]`, so
/// exactly ONE trailing `run` is dropped. Only one: a hypothetical
/// `/opt/run/run run` must keep the token that is part of its own path, and a
/// definition that carries no verb at all (hand-written, or a future shape) is
/// left exactly as found rather than truncated on a guess.
pub fn command_prefix(argv: Vec<String>) -> Option<Vec<String>> {
    let mut argv = argv;
    if argv.len() > 1 && argv.last().map(String::as_str) == Some(SERVICE_VERB) {
        argv.pop();
    }
    if argv.is_empty() || argv[0].is_empty() {
        None
    } else {
        Some(argv)
    }
}

/// The `ExecStart=` argv of the installed systemd user unit, if there is one.
fn from_systemd_unit() -> Option<Vec<String>> {
    let home = home_dir()?;
    let path = format!("{home}/.config/systemd/user/{SYSTEMD_UNIT}");
    let text = std::fs::read_to_string(path).ok()?;
    // Last assignment wins, the same rule systemd applies.
    let line = text
        .lines()
        .filter_map(|l| l.trim().strip_prefix("ExecStart="))
        .next_back()?;
    command_prefix(parse_systemd_exec(line))
}

/// The `ProgramArguments` of the installed launchd agent, if there is one.
///
/// Read through `plutil` rather than an XML regex: the plist is ours today,
/// but a binary1 plist is equally valid and would defeat any text predicate.
fn from_launchd_plist() -> Option<Vec<String>> {
    let home = home_dir()?;
    // BOTH locations, because "starts at login" is now which directory the
    // plist is in (`apps/node/agent/src/service.ts`, `sessionPlistPath`). An
    // agent installed with `--no-autostart` — which the first run's start-up
    // screen offers — lives in the node's own config home, and checking only
    // `~/Library/LaunchAgents` would make this rung silently vanish for such a
    // machine: the rung documented below as the AUTHORITY on what is
    // installed, falling through to whatever `LocalBin` finds. Usually the
    // same file; when it is not, the app reports and version-compares a binary
    // the service does not run, which is the exact confusion this rung exists
    // to prevent. `apps/server/desktop`'s `server_bin.rs` reads its own pair
    // the same way, for the same reason.
    let path = [
        format!("{home}/Library/LaunchAgents/{LAUNCHD_LABEL}.plist"),
        format!("{home}/.config/subshell/{LAUNCHD_LABEL}.plist"),
    ]
    .into_iter()
    .find(|p| Path::new(p).exists())?;
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
        PROBE_TIMEOUT,
    );
    if !out.ok() {
        return None;
    }
    let argv: Vec<String> = serde_json::from_str(out.stdout.trim()).ok()?;
    command_prefix(argv)
}

/// Ask a candidate what it is. A candidate that cannot answer is not an agent.
pub fn probe_version(argv: &[String]) -> Option<String> {
    let mut cmd = argv.to_vec();
    cmd.push("version".into());
    let out = run(&cmd, QUERY_TIMEOUT);
    out.ok().then(|| parse_node_version(&out.stdout)).flatten()
}

fn exists(path: &str) -> bool {
    Path::new(path).is_file()
}

/// Where the sidecar install lands, and the first place to look for an agent
/// this app installed on an earlier run.
pub fn managed_install_path() -> Option<String> {
    sidecar::install_path(&NODE_SIDECAR).map(|p| p.to_string_lossy().into_owned())
}

/// What the shipped binary says it is, if this build carries one.
///
/// Not memoized here — [`crate::control`] holds the `OnceLock`, because it is
/// the caller that runs on every probe.
pub fn bundled_version() -> Option<String> {
    let path = sidecar::bundled_path(&NODE_SIDECAR)?;
    let out = run(&[path.to_string_lossy().into_owned(), "version".into()], QUERY_TIMEOUT);
    out.ok().then(|| parse_node_version(&out.stdout)).flatten()
}

/// Walk the ladder and return the first rung that yields a binary which can
/// state its own version.
///
/// `configured` is the path the user picked by hand, if any — it outranks
/// everything except an explicit environment override.
pub fn resolve(configured: Option<&str>) -> Option<NodeBinary> {
    resolve_with(&candidates(configured), probe_version, exists)
}

/// The ladder, in order, as (rung, argv) pairs. Pure apart from the
/// environment it reads, so its ORDER is testable without a filesystem.
///
/// **The bundled sidecar is not a rung, and that is deliberate.** Two things
/// break if it becomes one. `service install` bakes an ABSOLUTE `ExecStart=` /
/// `ProgramArguments` from whatever binary ran it, so installing from inside
/// the signature-sealed bundle produces a service that dies the moment the app
/// is moved, replaced or removed — the exact failure `sidecar.rs` exists to
/// avoid. And the probe's `no-agent` step, which is what OFFERS the install,
/// would then never fire on a machine that has no agent, so the shipped binary
/// could never be installed at all. It is reported separately as
/// `bundledVersion` and reached only through `node_install_cli`.
pub fn candidates(configured: Option<&str>) -> Vec<(NodeSource, Vec<String>)> {
    let mut out: Vec<(NodeSource, Vec<String>)> = Vec::new();
    if let Ok(explicit) = std::env::var(NODE_BIN_ENV) {
        if !explicit.is_empty() {
            out.push((NodeSource::Env, vec![explicit]));
        }
    }
    if let Some(path) = configured.filter(|p| !p.is_empty()) {
        out.push((NodeSource::Configured, vec![path.to_string()]));
    }
    // The service definition is the AUTHORITY on what is installed: whatever
    // the manager starts is the agent this machine actually runs, and it is
    // the argv every `service` verb here will act on. Ranking the copy in
    // ~/.local/bin above it would let the app report one binary's version
    // while systemd ran another's.
    if let Some(argv) = from_systemd_unit().or_else(from_launchd_plist) {
        out.push((NodeSource::Service, argv));
    }
    if let Some(managed) = managed_install_path() {
        out.push((NodeSource::LocalBin, vec![managed]));
    }
    // The LOGIN path, not the process's. A GUI app inherits
    // `/usr/bin:/bin:/usr/sbin:/sbin`, so searching that would miss exactly the
    // `~/.local/bin` install `install.sh` performs — while every spawn we make
    // already runs with the login PATH. Searching a narrower PATH than we
    // execute with is the inconsistency that makes "it works in my terminal" true.
    for dir in login_path().split(':').filter(|d| !d.is_empty()) {
        out.push((NodeSource::Path, vec![format!("{dir}/subshell")]));
    }
    for dir in ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"] {
        out.push((NodeSource::WellKnown, vec![format!("{dir}/subshell")]));
    }
    out
}

/// Walk `candidates` and return the first rung that yields a binary which can
/// state its own version. The two effects are injected so the ORDER and the
/// skip rules can be tested without executing anything.
pub fn resolve_with(
    candidates: &[(NodeSource, Vec<String>)],
    mut probe: impl FnMut(&[String]) -> Option<String>,
    file_exists: impl Fn(&str) -> bool,
) -> Option<NodeBinary> {
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
            return Some(NodeBinary {
                argv: argv.clone(),
                source: *source,
                version: Some(version),
            });
        }
    }
    None
}

/// What to do about the agent this app SHIPS versus the one already installed.
///
/// The asymmetry between the two directions is deliberate. A node agent talks
/// a versioned wire protocol to the control plane and owns on-disk state the
/// control plane pushes to it (`identity.json`, `allowed-dirs.json`), so
/// replacing a newer installed agent with an older bundled one silently trades
/// a working node for one that may not speak what the plane sends — and the
/// symptom is a node that enrolls, comes up ONLINE and then refuses launches.
/// So a newer bundled agent is OFFERED, and a newer installed agent is
/// ADOPTED: never overwritten, never even offered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NodeChoice {
    /// This build ships no agent; whatever is installed is all there is.
    NoBundled,
    /// Nothing installed — install the bundled one.
    InstallBundled,
    /// The installed agent already is the bundled version.
    UpToDate,
    /// The bundled agent is newer. Offer it; never apply it unasked.
    UpgradeAvailable,
    /// The installed agent is newer. Use it and say so once.
    AdoptInstalled,
}

/// Decide between the bundled and installed agents. Pure — the whole rule in
/// one place, testable without a filesystem.
pub fn decide_node(bundled: Option<&str>, installed: Option<&str>) -> NodeChoice {
    match (bundled, installed) {
        (None, _) => NodeChoice::NoBundled,
        // An installed agent that cannot state its version never resolves in
        // the first place, so "absent" and "unparseable" are already one case.
        (Some(_), None) => NodeChoice::InstallBundled,
        (Some(b), Some(i)) if version_lt(i, b) => NodeChoice::UpgradeAvailable,
        (Some(b), Some(i)) if version_lt(b, i) => NodeChoice::AdoptInstalled,
        _ => NodeChoice::UpToDate,
    }
}

#[cfg(test)]
mod exec_parse_tests {
    use super::*;

    #[test]
    fn a_compiled_binary_is_one_token() {
        assert_eq!(
            parse_systemd_exec("/home/u/.local/bin/subshell run"),
            ["/home/u/.local/bin/subshell", "run"]
        );
    }

    // The execLine() trap: a dev-form install records interpreter + script +
    // verb, and dropping the middle token would run bun with nothing to run.
    #[test]
    fn a_dev_form_install_keeps_both_tokens() {
        assert_eq!(
            parse_systemd_exec("/Users/x/.bun/bin/bun /repo/apps/node/agent/src/main.ts run"),
            ["/Users/x/.bun/bin/bun", "/repo/apps/node/agent/src/main.ts", "run"]
        );
    }

    // systemdQuote double-quotes any token with whitespace — a macOS
    // "Application Support" home is the everyday case.
    #[test]
    fn unpicks_systemd_quoting() {
        assert_eq!(
            parse_systemd_exec("\"/Users/x/Application Support/bin/subshell\" run"),
            ["/Users/x/Application Support/bin/subshell", "run"]
        );
    }

    #[test]
    fn unpicks_escaped_characters() {
        assert_eq!(
            parse_systemd_exec(r#""/opt/a\"b/subshell" run"#),
            ["/opt/a\"b/subshell", "run"]
        );
        assert_eq!(
            parse_systemd_exec(r#"/opt/a\ b/subshell run"#),
            ["/opt/a b/subshell", "run"]
        );
    }

    #[test]
    fn collapses_runs_of_whitespace() {
        assert_eq!(
            parse_systemd_exec("  /bin/bun   /repo/main.ts   run  "),
            ["/bin/bun", "/repo/main.ts", "run"]
        );
    }

    #[test]
    fn an_empty_line_yields_nothing() {
        assert!(parse_systemd_exec("   ").is_empty());
    }

    // An empty quoted token is a real (if odd) argument and must survive the
    // split; `command_prefix` is what refuses it.
    #[test]
    fn keeps_an_explicitly_empty_token() {
        assert_eq!(parse_systemd_exec(r#"/bin/x """#), ["/bin/x", ""]);
    }
}

#[cfg(test)]
mod command_prefix_tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    // The whole point: what the unit runs is `subshell run`, and appending our
    // own verb to that would spawn `subshell run version`.
    #[test]
    fn drops_the_verb_a_compiled_install_records() {
        assert_eq!(
            command_prefix(v(&["/home/u/.local/bin/subshell", "run"])),
            Some(v(&["/home/u/.local/bin/subshell"]))
        );
    }

    #[test]
    fn keeps_both_tokens_of_a_dev_form_install() {
        assert_eq!(
            command_prefix(v(&["/bin/bun", "/repo/main.ts", "run"])),
            Some(v(&["/bin/bun", "/repo/main.ts"]))
        );
    }

    // A definition with no verb is left alone rather than truncated: guessing
    // there would turn a one-token prefix into nothing.
    #[test]
    fn a_definition_without_a_verb_is_untouched() {
        assert_eq!(
            command_prefix(v(&["/usr/local/bin/subshell"])),
            Some(v(&["/usr/local/bin/subshell"]))
        );
    }

    // Exactly one `run` comes off, so a binary that lives at a path ending in
    // `run` keeps its own name.
    #[test]
    fn only_one_trailing_verb_is_dropped() {
        assert_eq!(command_prefix(v(&["/opt/run", "run"])), Some(v(&["/opt/run"])));
        assert_eq!(
            command_prefix(v(&["/bin/bun", "/repo/run", "run"])),
            Some(v(&["/bin/bun", "/repo/run"]))
        );
    }

    // A single token is never stripped, even when it IS the verb: a definition
    // reading `ExecStart=run` is corrupt, and answering `None` versus a
    // one-token prefix makes no difference — neither exists as a file, so the
    // rung is skipped either way. Refusing to strip keeps the rule to one
    // sentence.
    #[test]
    fn a_single_token_is_never_stripped() {
        assert_eq!(command_prefix(v(&["run"])), Some(v(&["run"])));
    }

    // Nothing to run is not a rung.
    #[test]
    fn an_empty_or_headless_definition_is_refused() {
        assert_eq!(command_prefix(Vec::new()), None);
        assert_eq!(command_prefix(v(&["", "run"])), None);
        assert_eq!(command_prefix(v(&[""])), None);
    }
}

#[cfg(test)]
mod ladder_tests {
    use super::*;

    fn rung(source: NodeSource, path: &str) -> (NodeSource, Vec<String>) {
        (source, vec![path.to_string()])
    }

    /// A probe that answers for a named set of paths and refuses everything else.
    fn probe_for(known: &'static [&'static str]) -> impl Fn(&[String]) -> Option<String> {
        move |argv| known.contains(&argv[0].as_str()).then(|| "1.9.0".to_string())
    }

    #[test]
    fn takes_the_first_rung_that_answers() {
        let c = vec![
            rung(NodeSource::Env, "/env/subshell"),
            rung(NodeSource::Service, "/svc/subshell"),
        ];
        let found = resolve_with(&c, probe_for(&["/env/subshell", "/svc/subshell"]), |_| true).unwrap();
        assert_eq!(found.source, NodeSource::Env);
    }

    // A file can exist and still not be an agent — a shim, a wrapper, an old
    // build, or `apps/server/desktop`'s `subshell-server` under a symlink.
    // Existence alone must never end the search.
    #[test]
    fn a_file_that_exists_but_is_not_a_node_is_skipped() {
        let c = vec![
            rung(NodeSource::Configured, "/not/an/agent"),
            rung(NodeSource::LocalBin, "/good/subshell"),
        ];
        let found = resolve_with(&c, probe_for(&["/good/subshell"]), |_| true).unwrap();
        assert_eq!(found.source, NodeSource::LocalBin);
        assert_eq!(found.version.as_deref(), Some("1.9.0"));
    }

    #[test]
    fn a_missing_file_is_never_probed() {
        let mut probed: Vec<String> = Vec::new();
        let c = vec![rung(NodeSource::Path, "/gone/subshell")];
        let found = resolve_with(
            &c,
            |argv| {
                probed.push(argv[0].clone());
                Some("1.9.0".into())
            },
            |_| false,
        );
        assert!(found.is_none());
        assert!(probed.is_empty(), "probed a file that does not exist: {probed:?}");
    }

    // The ladder repeats paths (`~/.local/bin` is both the managed rung and a
    // login-PATH entry), and each probe spawns a ~100 MB binary.
    #[test]
    fn a_repeated_path_is_probed_only_once() {
        let mut count = 0;
        let c = vec![
            rung(NodeSource::LocalBin, "/home/u/.local/bin/subshell"),
            rung(NodeSource::Path, "/home/u/.local/bin/subshell"),
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
        assert!(resolve_with(&[], |_| Some("1.9.0".into()), |_| true).is_none());
    }

    // The dev-form install records [interpreter, script]; only the first token
    // is a file to check, and BOTH must reach the probe.
    #[test]
    fn a_two_token_dev_form_entry_survives_intact() {
        let c = vec![(
            NodeSource::Service,
            vec!["/bin/bun".to_string(), "/repo/main.ts".to_string()],
        )];
        let found = resolve_with(
            &c,
            |argv| (argv.len() == 2).then(|| "1.9.0".to_string()),
            |p| p == "/bin/bun",
        )
        .unwrap();
        assert_eq!(found.argv, ["/bin/bun", "/repo/main.ts"]);
    }

    // Asserted as a SUBSEQUENCE, because which rungs exist depends on the
    // machine — a host with no installed unit contributes no `Service` rung at
    // all, and a positional comparison there silently inverts into a test that
    // passes for the wrong reason.
    #[test]
    fn the_real_ladder_keeps_its_documented_order() {
        const CANONICAL: [NodeSource; 6] = [
            NodeSource::Env,
            NodeSource::Configured,
            NodeSource::Service,
            NodeSource::LocalBin,
            NodeSource::Path,
            NodeSource::WellKnown,
        ];
        let mut seen: Vec<NodeSource> = candidates(Some("/chosen/subshell"))
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
        assert!(seen.contains(&NodeSource::Configured));
        assert!(seen.contains(&NodeSource::WellKnown));
    }

    // Every spawn already runs with the login PATH; searching a narrower one
    // would let the ladder fail to FIND an agent it could perfectly well run.
    #[test]
    fn the_path_rung_searches_the_login_path() {
        let paths: Vec<String> = candidates(None)
            .into_iter()
            .filter(|(s, _)| *s == NodeSource::Path)
            .map(|(_, a)| a[0].clone())
            .collect();
        for dir in login_path().split(':').filter(|d| !d.is_empty()) {
            assert!(
                paths.contains(&format!("{dir}/subshell")),
                "login PATH entry {dir} not searched"
            );
        }
    }

    // Every rung looks for the AGENT. A rung spelled `subshell-server` would
    // resolve the other desktop app's binary and then drive it with node verbs
    // it does not have.
    #[test]
    fn no_rung_looks_for_the_server_binary() {
        for (source, argv) in candidates(None) {
            for token in argv {
                assert!(
                    !token.ends_with("subshell-server"),
                    "{source:?} rung points at the server binary: {token}"
                );
            }
        }
    }

    // The bundled sidecar is reported, never resolved — see `candidates`.
    #[test]
    fn the_bundled_sidecar_is_not_a_rung() {
        for (source, argv) in candidates(None) {
            for token in argv {
                assert!(
                    !token.contains(NODE_SIDECAR.bundled_name),
                    "{source:?} rung would run the in-bundle sidecar: {token}"
                );
            }
        }
    }
}

#[cfg(test)]
mod version_parse_tests {
    use super::*;

    // The agent's line carries a parenthetical the server's does not.
    #[test]
    fn reads_the_version_off_the_first_line() {
        assert_eq!(
            parse_node_version("subshell 1.9.0 (node protocol v1)\n"),
            Some("1.9.0".into())
        );
        assert_eq!(parse_node_version("subshell 1.9.0"), Some("1.9.0".into()));
    }

    // The trailing space in the prefix is what keeps the two products apart.
    #[test]
    fn a_subshell_server_line_is_not_a_node() {
        assert_eq!(parse_node_version("subshell-server 1.9.0"), None);
    }

    #[test]
    fn refuses_anything_that_is_not_that_line() {
        assert_eq!(parse_node_version(""), None);
        assert_eq!(parse_node_version("subshell "), None);
        assert_eq!(parse_node_version("bash: command not found"), None);
    }
}

#[cfg(test)]
mod sidecar_spec_tests {
    use super::*;

    // The in-bundle name has NO triple suffix: tauri-build and tauri-bundler
    // both strip it on copy, so anything looking for the STAGED filename inside
    // a built app finds nothing. Pinned here rather than in the shared crate
    // because it is this app's shipped name, and it has to agree with
    // `NODE_SIDECAR_NAME` in `packages/subshell-protocol/src/paths.ts` and
    // with `externalBin` in `tauri.conf.json`.
    #[test]
    fn bundled_name_carries_no_target_triple() {
        assert_eq!(NODE_SIDECAR.bundled_name, "subshell-node-bundled");
        assert!(!NODE_SIDECAR.bundled_name.contains("apple-darwin"));
        assert!(!NODE_SIDECAR.bundled_name.contains("unknown-linux"));
    }

    // What `install.sh` and the CLI's own docs call the agent. Installing it
    // under any other name would leave the ladder's Path/WellKnown rungs
    // looking for a file this app never writes.
    #[test]
    fn the_installed_name_is_what_the_cli_is_called() {
        assert_eq!(NODE_SIDECAR.installed_name, "subshell");
        assert_eq!(NODE_SIDECAR.version_prefix, "subshell ");
    }

    // The ladder's `LocalBin` rung and the sidecar's install target are the
    // same file; two spellings of it would let the app install an agent it then
    // refuses to find.
    #[test]
    fn the_local_bin_rung_is_the_path_the_sidecar_installs_to() {
        let Some(managed) = managed_install_path() else { return };
        assert!(managed.ends_with("/.local/bin/subshell"), "{managed}");
        assert_eq!(
            Some(managed),
            sidecar::install_path(&NODE_SIDECAR).map(|p| p.to_string_lossy().into_owned())
        );
    }

    // The service definition this app reads is the CLIENT's, not the server
    // app's — `apps/node/agent/src/service.ts` SYSTEMD_UNIT_NAME / LAUNCHD_LABEL.
    #[test]
    fn the_service_definition_names_are_the_clients() {
        assert_eq!(SYSTEMD_UNIT, "subshell.service");
        assert_eq!(LAUNCHD_LABEL, "dev.subshell.client");
        assert_ne!(SYSTEMD_UNIT, "subshell-server.service");
        assert_ne!(LAUNCHD_LABEL, "dev.subshell.server");
    }
}

#[cfg(test)]
mod choice_tests {
    use super::*;

    #[test]
    fn no_bundled_node_leaves_the_installed_one_alone() {
        assert_eq!(decide_node(None, Some("1.9.0")), NodeChoice::NoBundled);
        assert_eq!(decide_node(None, None), NodeChoice::NoBundled);
    }

    #[test]
    fn nothing_installed_means_install_the_bundled_one() {
        assert_eq!(decide_node(Some("1.9.0"), None), NodeChoice::InstallBundled);
    }

    #[test]
    fn the_same_version_is_up_to_date() {
        assert_eq!(decide_node(Some("1.9.0"), Some("1.9.0")), NodeChoice::UpToDate);
    }

    #[test]
    fn a_newer_bundled_node_is_offered() {
        assert_eq!(decide_node(Some("2.0.0"), Some("1.9.0")), NodeChoice::UpgradeAvailable);
    }

    // Never a downgrade: an older agent against a control plane that has moved
    // on is a node that enrolls, reports ONLINE and then refuses launches.
    #[test]
    fn a_newer_installed_node_is_adopted_never_downgraded() {
        assert_eq!(decide_node(Some("1.9.0"), Some("2.0.0")), NodeChoice::AdoptInstalled);
        assert_eq!(decide_node(Some("1.9.0"), Some("1.10.0")), NodeChoice::AdoptInstalled);
    }

    #[test]
    fn comparison_is_numeric_not_lexical() {
        assert_eq!(decide_node(Some("1.10.0"), Some("1.9.0")), NodeChoice::UpgradeAvailable);
        assert_eq!(decide_node(Some("1.9.0"), Some("1.10.0")), NodeChoice::AdoptInstalled);
    }
}
