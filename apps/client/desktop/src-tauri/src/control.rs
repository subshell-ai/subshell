//! The commands the window calls.
//!
//! Every one is an argument-poor wrapper around the `subshell` CLI: the agent
//! owns each decision (what a valid setup key redeems to, whether a restart
//! would kill live panes, what to tell the operator), and this layer only
//! routes. Nothing here parses the CLI's prose and nothing here re-implements a
//! rule that has a home in `apps/node/agent` — which is why every action returns
//! the CLI's own `stdout`/`stderr` VERBATIM alongside an ok flag. Those strings
//! are pinned by the client's own tests; re-wording them here would drift, and
//! matching them with a regex would break on the next copy edit.
//!
//! **Every command is `async`.** They are not async internally — the CLI is
//! synchronous by contract — but a plain `#[tauri::command]` runs on the main
//! thread, and `ACTION_TIMEOUT` is 90 seconds. A blocking command there does
//! not merely delay the answer: it freezes the window, so the page cannot even
//! paint the "Working…" state it set before calling.
//!
//! Three invocations are absent BY CONSTRUCTION rather than by convention, and
//! [`NodeCommand`] is the closed set that keeps them absent:
//!
//! - `subshell status --probe` DIALS the control plane, and the node registry
//!   is newest-wins, so a probe supersede-kicks whatever agent is live —
//!   possibly one running on another machine for this same node (close 4409).
//!   It is never worth a status refresh.
//! - `subshell run` never resolves, and it competes with the installed service
//!   for one node: both restart on exit, so the pair flaps.
//! - `subshell mcp` is per-pane internal plumbing, configured entirely by a
//!   launch's `SUBSHELL_*` environment.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

use subshell_desktop_core::cli_update;
use subshell_desktop_core::legal;
use subshell_desktop_core::pending_install::{resume_decision, Resume};
use subshell_desktop_core::proc::{run, LineSink, Run, ACTION_TIMEOUT, QUERY_TIMEOUT};
use subshell_desktop_core::reset_guards::machine_hostname;
use subshell_desktop_core::settings::{PendingBundledInstall, Settings, SettingsState};
use subshell_desktop_core::shell_env::{home_dir, which};
use subshell_desktop_core::sidecar;
use subshell_desktop_core::tray::{effective_close_to_tray, tray_support};

use crate::node_bin::{self, decide_node, NodeBinary, NodeChoice, NODE_SIDECAR};

/// What the page is told when nothing on the ladder answered.
const NO_NODE: &str = "no subshell node CLI found; install the bundled one first";

/// The mint shape of a node setup key: `nsk_` plus 32 url-safe base64
/// characters (`randomBytes(24).toString("base64url")` in
/// `node-setup-keys.repository.ts`). The server checks the same shape in
/// `install-script.ts`, and checking it here means a typo costs a message
/// rather than a spawn.
const SETUP_KEY_BODY_LEN: usize = 32;
const SETUP_KEY_PREFIX: &str = "nsk_";

/// Mirrors the `name` maxLength of `EnrollBodySchema`
/// (`apps/server/api/src/api/nodes/enroll.route.ts`), which the CLI also
/// pre-checks — because learning about it from a 400 costs the setup key.
const MAX_NODE_NAME_LEN: usize = 64;

// ---------------------------------------------------------------------------
// The closed set of invocations
// ---------------------------------------------------------------------------

/// The `service` verbs the page may drive.
///
/// A deserialized enum rather than a hand-written allowlist: an unknown verb is
/// then refused by Tauri's own argument handling, before any code here runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceCommand {
    Install,
    Uninstall,
    Start,
    Stop,
    Restart,
    /// `service autostart on|off` — the day-2 login toggle (spec 2026-09-22
    /// rails addendum). Which way it turns is the command's `autostart`
    /// boolean, the same field `install` uses to arm the definition as it
    /// writes it.
    Autostart,
}

impl ServiceCommand {
    fn as_str(self) -> &'static str {
        match self {
            ServiceCommand::Install => "install",
            ServiceCommand::Uninstall => "uninstall",
            ServiceCommand::Start => "start",
            ServiceCommand::Stop => "stop",
            ServiceCommand::Restart => "restart",
            ServiceCommand::Autostart => "autostart",
        }
    }
}

/// Every `subshell` invocation this app is allowed to make.
///
/// The enum IS the allowlist. There is no variant for `run`, none for `mcp`,
/// and no variant that can emit `--probe` — so the three forbidden
/// invocations cannot be reached by adding an argument at a call site, only by
/// adding a variant here. (`version` is the one invocation outside this set:
/// [`node_bin::probe_version`] appends it while walking the ladder, before
/// there is an agent to build a command for.)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeCommand {
    /// `status --json` — LOCAL truth only, read from the daemon lock file.
    Status,
    /// `service status --json` — what the service manager reports.
    ServiceStatus,
    /// One `service` verb, with the two flags the CLI accepts and where.
    ///
    /// `force` is `restart` only. `autostart` has two jobs and no others: on
    /// `install` it decides what the definition is WRITTEN to do (`false`
    /// spells `--no-autostart` — run it now, do not arm it for login), and on
    /// the `autostart` verb its VALUE is the request itself, spelled as the
    /// CLI's `on`/`off` argument. Both are fields rather than variants
    /// because that is how `force` was already modelled, and one invocation
    /// shape with two qualifiers reads better than three variants of
    /// "install".
    ///
    /// `autostart: true` is the default everywhere except the first-run
    /// register chain, which asks the person on its start-up screen.
    Service {
        verb: ServiceCommand,
        force: bool,
        autostart: bool,
    },
    /// `enroll --json`. Destructive; guarded in [`node_enroll`].
    ///
    /// `name` is a `String` and always reaches the CLI as `--name`, because the
    /// CLI made it required (2026-09-17): `enroll` is the primitive that takes
    /// every fact as an argument and asks nothing of anyone, and the hostname
    /// default it used to fall back to is how a machine ended up named something
    /// nobody had chosen. The app asks, so this variant cannot represent a
    /// nameless enroll at all.
    Enroll { server: String, key: String, name: String },
    /// `unenroll --yes --json` — stop being a node, from the node side.
    ///
    /// The flags are baked into the variant, not offered to the page, for
    /// two separate reasons that both point one way: `--yes` because the
    /// press has ALREADY been confirmed on screen (and what it accepts is
    /// ORPHANING live panes, never killing them — nothing in this verb
    /// signals anything), and `--json` because the caller reads the result
    /// rather than screen-scraping the human line.
    Unenroll,
}

impl NodeCommand {
    /// The arguments to append to a resolved agent's command prefix.
    pub fn args(&self) -> Vec<String> {
        match self {
            NodeCommand::Status => vec!["status".into(), "--json".into()],
            NodeCommand::ServiceStatus => vec!["service".into(), "status".into(), "--json".into()],
            // The CLI refuses `--force` anywhere but `restart`, so passing it
            // elsewhere would turn a stop into a usage error.
            NodeCommand::Service { verb, force, .. } if *force && *verb == ServiceCommand::Restart => {
                vec!["service".into(), verb.as_str().into(), "--force".into()]
            }
            // The day-2 toggle spells its DIRECTION in the argument slot —
            // `service autostart on|off` is how the CLI parses it — and never
            // grows `--no-autostart`: that flag is install's alone.
            NodeCommand::Service {
                verb: ServiceCommand::Autostart,
                autostart,
                ..
            } => {
                let direction = if *autostart { "on" } else { "off" };
                vec!["service".into(), "autostart".into(), direction.into()]
            }
            // The CLI accepts `--no-autostart` on `install` alone (it is in
            // that subcommand's flag allowlist and nowhere else), so passing
            // it on a stop or a restart would turn the verb into a usage
            // error — the same rule `--force` follows one arm above.
            NodeCommand::Service { verb, autostart, .. } if *verb == ServiceCommand::Install && !*autostart => {
                vec!["service".into(), "install".into(), "--no-autostart".into()]
            }
            NodeCommand::Service { verb, .. } => vec!["service".into(), verb.as_str().into()],
            NodeCommand::Enroll { server, key, name } => {
                let mut args = vec![
                    "enroll".into(),
                    "--server".into(),
                    server.clone(),
                    "--key".into(),
                    key.clone(),
                    "--name".into(),
                    name.clone(),
                ];
                // `--json` so nothing here screen-scrapes the human line for
                // the node id; the body deliberately omits the node key.
                args.push("--json".into());
                args
            }
            NodeCommand::Unenroll => vec!["unenroll".into(), "--yes".into(), "--json".into()],
        }
    }

    /// The deadline for this invocation. Reads are quick; anything that drives
    /// the service manager or talks to the control plane is not.
    fn timeout(&self) -> Duration {
        match self {
            NodeCommand::Status | NodeCommand::ServiceStatus => QUERY_TIMEOUT,
            NodeCommand::Service { .. } | NodeCommand::Enroll { .. } | NodeCommand::Unenroll => ACTION_TIMEOUT,
        }
    }
}

/// `<agent> <args…>`, or `None` when nothing resolved.
fn node_cmd(node_binary: Option<&NodeBinary>, command: &NodeCommand) -> Option<Vec<String>> {
    let mut cmd = node_binary?.argv.clone();
    cmd.extend(command.args());
    Some(cmd)
}

fn run_node(node_binary: Option<&NodeBinary>, command: &NodeCommand) -> Option<Run> {
    node_cmd(node_binary, command).map(|cmd| run(&cmd, command.timeout()))
}

// ---------------------------------------------------------------------------
// Facts on disk
// ---------------------------------------------------------------------------

/// The three facts this app needs out of the agent's `config.json`.
///
/// Deliberately NOT `Serialize`, and deliberately missing a field for
/// `nodeKey`: that file is 0600 and the node's bearer secret is the reason,
/// and the CLI will not echo it even under `--json`. The parse below reads the
/// whole document and keeps only these three strings, so there is no struct in
/// this process that could carry the key into a response or a log line.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NodeConfigFacts {
    pub node_id: Option<String>,
    pub server_url: Option<String>,
    pub data_dir: Option<String>,
}

/// Pull the three non-secret facts out of a `config.json` body.
pub fn parse_node_config(text: &str) -> NodeConfigFacts {
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(text) else {
        return NodeConfigFacts::default();
    };
    let field = |key: &str| {
        map.get(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
    };
    NodeConfigFacts {
        node_id: field("nodeId"),
        server_url: field("serverUrl"),
        data_dir: field("dataDir"),
    }
}

/// The agent's config home.
///
/// `~/.config/subshell` unconditionally — the CLI's own default. This app
/// never honours `SUBSHELL_CONFIG_HOME`, and `crate::scrub_environment` strips
/// it from the process before any spawn: an agent enrolled under a custom
/// config home would still be started by a service definition that bakes only
/// PATH, so it would look in `~/.config/subshell`, find nothing, and
/// crash-loop with nothing to explain it.
pub fn config_dir() -> Option<PathBuf> {
    home_dir().map(|h| PathBuf::from(h).join(".config/subshell"))
}

fn config_file() -> Option<PathBuf> {
    config_dir().map(|d| d.join("config.json"))
}

/// Read the config facts, or an empty set when there is no config yet.
fn read_node_config() -> NodeConfigFacts {
    config_file()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|t| parse_node_config(&t))
        .unwrap_or_default()
}

/// What this machine already is, for the enrollment guard.
///
/// The FILE is the fact here, not `status --json`: a config that exists but
/// cannot be parsed still holds a node key, and a `status` that failed to run
/// would report "not enrolled" — which is precisely the answer that would wave
/// the destructive step through unasked.
fn existing_node() -> ExistingNode {
    let Some(path) = config_file() else {
        return ExistingNode::None;
    };
    if !path.exists() {
        return ExistingNode::None;
    }
    let facts = std::fs::read_to_string(&path)
        .map(|t| parse_node_config(&t))
        .unwrap_or_default();
    match facts.node_id {
        Some(node_id) => ExistingNode::Known {
            node_id,
            server_url: facts.server_url,
        },
        None => ExistingNode::Unreadable,
    }
}

/// Where this machine's agent writes its own log.
///
/// **The agent's OWN file comes first, on every platform**, which is the same
/// order `apps/server/desktop`'s `desktop_logs` reads the server's in and for
/// the same reason: since 2026-09-12 the agent writes one capped JSON-lines
/// file (`<config dir>/logs/agent.log`, 0600, 200 KB, replaced when full) and
/// that is the file the plane's node log view serves. A person revealing the
/// log here and a person reading it in a browser must not be looking at two
/// different documents.
///
/// **The service manager's redirect is the fallback**, and it is a genuinely
/// different artifact rather than a copy: launchd's `StandardOutPath`
/// (`~/Library/Logs/subshell.log`) holds the raw stdout of an agent that died
/// before it opened its own file, which is exactly the machine someone is
/// trying to repair. Linux has no such file at all — the systemd user unit
/// redirects nothing — so there the fallback is the journal, which is a
/// sentence rather than a path.
///
/// Exactly one of the two returns is ever `Some`.
fn node_log_paths() -> (Option<String>, Option<String>) {
    node_log_paths_from(config_dir(), home_dir().map(PathBuf::from), |p| {
        std::fs::metadata(p)
            .map(|m| m.is_file() && m.len() > 0)
            .unwrap_or(false)
    })
}

/// [`node_log_paths`]'s body over injected facts, so the ORDER is testable without
/// a machine in a particular state.
///
/// `has_content` rather than a bare existence check, for the reason the server
/// app's `server_log_tail` returns `None` on an empty file: the capped writer
/// truncates to zero and starts over, and a zero-byte own-log is an agent that
/// has said nothing — while the manager's copy may still hold the boot output
/// that explains why.
fn node_log_paths_from(
    config: Option<PathBuf>,
    home: Option<PathBuf>,
    has_content: impl Fn(&Path) -> bool,
) -> (Option<String>, Option<String>) {
    let own = config.map(|c| c.join("logs").join("agent.log"));
    // `filter` rather than an inner `if` on both rungs, so every branch stays
    // compiled on both platforms — which is what makes a clippy run on either
    // of them mean something.
    let managed = home
        .filter(|_| cfg!(target_os = "macos"))
        .map(|h| h.join("Library").join("Logs").join("subshell.log"));
    for candidate in [own, managed].into_iter().flatten() {
        if has_content(&candidate) {
            return (Some(candidate.to_string_lossy().into_owned()), None);
        }
    }
    (None, Some(NO_LOG_FILE.to_string()))
}

/// What to say when there is no log FILE to reveal.
///
/// Both platforms name the agent's own file first, because that is the one
/// that appears as soon as the agent logs anything anywhere. What differs is
/// the fallback each has: macOS keeps a second file the plist names, Linux has
/// the journal and will never grow a file at all.
const NO_LOG_FILE: &str = if cfg!(target_os = "macos") {
    "the node has not written a log yet: it appears at ~/.config/subshell/logs/agent.log once the node runs, and the service manager keeps its own copy at ~/Library/Logs/subshell.log"
} else {
    "the node has not written a log yet: it appears at ~/.config/subshell/logs/agent.log once the node runs; the service manager's own copy is the journal (`journalctl --user -u subshell.service -f`)"
};

/// The paths the window may name, and the ones it may ask to reveal.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodePaths {
    /// `~/.config/subshell`.
    pub config_dir: Option<String>,
    /// `~/.config/subshell/config.json` — 0600, and the node key's only home.
    pub config_file: Option<String>,
    /// The identity/state directory, as the config records it; the CLI's
    /// default (`<config dir>/data`) when nothing is enrolled yet.
    pub data_dir: Option<String>,
    /// The agent's log FILE: its own capped one when it has written anything,
    /// else the service manager's redirect where the platform keeps one.
    pub node_log: Option<String>,
    /// What to do instead, when neither has content yet.
    pub node_log_hint: Option<String>,
}

fn node_paths(config: &NodeConfigFacts) -> NodePaths {
    let dir = config_dir();
    let (node_log, node_log_hint) = node_log_paths();
    NodePaths {
        config_dir: dir.as_ref().map(|p| p.to_string_lossy().into_owned()),
        config_file: config_file().map(|p| p.to_string_lossy().into_owned()),
        data_dir: config
            .data_dir
            .clone()
            .or_else(|| dir.map(|p| p.join("data").to_string_lossy().into_owned())),
        node_log,
        node_log_hint,
    }
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/// The single next thing that has to be true, from the app's point of view.
///
/// An enum rather than a string so a step the page does not handle is a
/// compile-time question on this side and an explicit fallback on the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProbeStep {
    /// Nothing on the ladder answered — install the bundled agent.
    NoNode,
    /// An agent, but no `config.json`: this machine is not a node yet.
    NotEnrolled,
    /// Enrolled, but nothing keeps the daemon running across a reboot.
    NoService,
    /// A service definition exists and the manager is not running it.
    Stopped,
    /// The manager runs it, but no live local daemon holds the lock.
    Offline,
    /// A live local daemon is heartbeating.
    Online,
}

/// Everything the window needs to decide what to offer, in one round trip.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    /// The agent this app ships, if this build carries one.
    pub bundled_version: Option<String>,
    /// The agent that would actually run, and which rung found it.
    pub node_binary: Option<NodeBinary>,
    /// Whether that agent is the copy THIS APP installed and can replace.
    pub managed: bool,
    /// `status --json`, verbatim. `null` when it did not answer at all.
    pub status: Option<serde_json::Value>,
    /// `service status --json`, verbatim. `null` when it did not answer.
    pub service: Option<serde_json::Value>,
    /// What to do about the shipped agent versus the installed one.
    pub node_choice: NodeChoice,
    /// The single next step, recomputed from facts on every probe.
    pub step: ProbeStep,
    /// The CLI's own words when a step failed rather than merely being pending.
    pub error: Option<String>,
    /// tmux's path on the LOGIN path, or `null`.
    ///
    /// Resolved here rather than read off `status`, because it has to be
    /// answerable before this machine is a node: `enroll` preflights tmux
    /// BEFORE its network call precisely so an unenrollable box does not burn
    /// a one-time setup key, and a refusal is the worst place to learn about it.
    pub tmux: Option<String>,
    /// Whether `brew` resolves on the LOGIN path.
    ///
    /// Beside `tmux` because it answers that screen's second question: what to
    /// OFFER when tmux is missing. Homebrew is the only macOS installer this
    /// app can drive (`desktop_core::tmux::install_argv` answers `None`
    /// without it), so on a brew-less Mac the Install button can only ever
    /// produce the `NO_MANAGER` refusal — and a button whose one outcome is a
    /// refusal is the dead end that screen exists to close. The page reads
    /// this to print the two manual routes instead. Linux never consults it:
    /// `pkexec apt-get` is runnable on every machine this app ships a `.deb`
    /// to.
    pub has_brew: bool,
    /// The closed set of paths the window may name.
    pub paths: NodePaths,
    /// This machine's name, as `hostname(1)` reports it — memoized.
    ///
    /// Here so the reset screen can SHOW the word it is asking to be typed:
    /// the gate is deliberate consent, not a memory test, and a box demanding
    /// a string the page cannot display would be both. The page renders this
    /// and `node_reset` compares against the same memo, so the two cannot be
    /// different readings of a machine renamed mid-session. Empty means it
    /// could not be read, and the reset refuses on that by name.
    pub hostname: String,
    /// Whether rewriting the service definition takes the RUNNING agent down
    /// on the way.
    ///
    /// `service install` is the remedy the CLI itself suggests for a definition
    /// that would kill live panes, and on Linux it is free: the unit is
    /// rewritten, `daemon-reload` re-reads it for the running unit, and `enable
    /// --now` leaves an already-active one alone. launchd has no reload —
    /// `installService` boots the old job OUT and bootstraps the new plist —
    /// and booting out a job whose loaded definition predates
    /// `AbandonProcessGroup` takes its whole process group with it, which is
    /// every pane on this machine. So the platform where the remedy is free
    /// and the platform where it costs exactly what it is repairing are
    /// opposite, and the page cannot know which it is on.
    pub rewrite_tears_down: bool,
    /// The second half of an app update that has not been finished yet.
    ///
    /// Filled by [`node_probe`] alone — [`probe_now`] is also what
    /// [`install_node_now`] reads the machine with, and a marker on that
    /// answer would be a fact nobody asked for. See [`resume_view`] for why
    /// this rides the probe rather than `node_settings`.
    pub pending_install: Option<PendingInstall>,
}

/// What a page is told about an unfinished update (spec 2026-09-18 § 5).
///
/// The ANSWER, never the inputs: `desktop_core::pending_install::resume_decision`
/// has already weighed the marker against this machine by the time this is
/// built, so a marker whose work turned out to be done never reaches the page
/// at all. `forced` is deliberately absent — it carries a pane-safety consent
/// for a service RESTART, and this app's phase 2 restarts nothing (spec § 7.1).
///
/// **The name and every field name are Subshell Server's**, deliberately: the
/// two apps run the same act over different second halves, and one is read
/// beside the other whenever either is changed. This app carried
/// `PendingUpdateView`/`pendingUpdate`/`exhausted` until 2026-09-18, which
/// made a straight diff of the two screens read as a difference in design
/// where there was only a difference in spelling. `attempts` is the one field
/// this app had first (it counts at the FIRE — see [`node_install_cli`] —
/// which is the rule both apps now follow).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingInstall {
    /// The app version that was running when the person pressed.
    pub from_app_version: String,
    /// How many attempts have already been made and failed.
    pub attempts: u32,
    /// Whether it has failed often enough to stop firing on its own.
    pub halted: bool,
}

impl Default for Probe {
    fn default() -> Self {
        Probe {
            bundled_version: None,
            node_binary: None,
            managed: false,
            status: None,
            service: None,
            node_choice: NodeChoice::NoBundled,
            step: ProbeStep::NoNode,
            error: None,
            tmux: None,
            has_brew: false,
            paths: NodePaths::default(),
            // Empty by default, not read: `Default` is a shape for tests and
            // for `probe_now` to fill, and `machine_hostname` spawns.
            hostname: String::new(),
            rewrite_tears_down: cfg!(target_os = "macos"),
            pending_install: None,
        }
    }
}

/// Read a top-level field out of a `--json` payload.
fn field<'a>(v: &'a Option<serde_json::Value>, key: &str) -> Option<&'a serde_json::Value> {
    v.as_ref()?.get(key)
}

fn is_true(v: &Option<serde_json::Value>, key: &str) -> bool {
    field(v, key) == Some(&serde_json::Value::Bool(true))
}

fn str_field<'a>(v: &'a Option<serde_json::Value>, key: &str) -> Option<&'a str> {
    field(v, key)?.as_str()
}

impl Probe {
    /// Whether `status --json` reported an enrolled node.
    ///
    /// `nodeId` is `null` in exactly one case — `loadConfig()` threw, i.e. the
    /// config is absent or corrupt — and a string in every other, so this is
    /// the CLI's own answer rather than a guess about the filesystem.
    fn enrolled(&self) -> bool {
        str_field(&self.status, "nodeId").is_some()
    }

    /// The single next step, derived from facts rather than remembered.
    ///
    /// Recomputed on every probe on purpose: the user may have enrolled from a
    /// terminal, stopped the service or deleted the config while this window
    /// was open, and a remembered step would be wrong.
    /// The installed agent version to COMPARE the bundle against — which is
    /// not always the installed version.
    ///
    /// A newer INSTALLED agent is adopted, so the upgrade offer only makes
    /// sense against the copy this app owns. Offering it for an agent the user
    /// installed elsewhere would write `~/.local/bin`, change nothing about
    /// what the service runs, and offer again forever — so an unmanaged
    /// machine answers the BUNDLE's own version, i.e. "nothing to offer".
    ///
    /// **Shared with the resume path deliberately** (spec 2026-09-18 § 6).
    /// `resume_decision` was fed the raw installed version, so a machine whose
    /// service names a binary elsewhere was refused the CLI half in phase 1 —
    /// the screen said the agent is left alone — and then had it installed
    /// anyway at the next boot. One rule, asked in both places, is what makes
    /// the refusal hold across the relaunch. (Found in review; the server app
    /// carries the identical fix and the identical comment.)
    fn comparable_node_version(&self) -> Option<&str> {
        if self.managed || self.node_binary.is_none() {
            self.node_binary.as_ref().and_then(|a| a.version.as_deref())
        } else {
            self.bundled_version.as_deref()
        }
    }

    fn decide(&mut self) {
        self.node_choice = decide_node(self.bundled_version.as_deref(), self.comparable_node_version());

        self.step = if self.node_binary.is_none() {
            ProbeStep::NoNode
        } else if self.status.is_none() {
            // The binary answered `version` but not `status --json`. Reading
            // that as "not enrolled" would offer ENROLL, which overwrites
            // config.json, mints a second node row on the control plane and
            // discards the node key whose only home was that file — a
            // transient failure must never route to the destructive step. The
            // honest remedy for a binary that cannot state its own status is a
            // different binary, so it lands here, with `error` saying why.
            ProbeStep::NoNode
        } else if !self.enrolled() {
            ProbeStep::NotEnrolled
        } else if !is_true(&self.service, "installed") {
            ProbeStep::NoService
        } else if str_field(&self.service, "state") != Some("running") {
            // `stopping` and `unknown` land here too: neither is a running
            // daemon, and Start is the correct offer for both.
            ProbeStep::Stopped
        } else if !is_true(&self.status, "online") {
            // The manager says it started something; the daemon lock says
            // nothing is heartbeating. A crash-looping agent inside its
            // RestartSec window looks exactly like this.
            ProbeStep::Offline
        } else {
            ProbeStep::Online
        };
    }
}

/// Parse a `--json` body out of stdout, **exit code ignored**.
///
/// `subshell status` exits 1 whenever the node is offline, and offline is a
/// correct answer rather than a failure — so the exit code is a hint and the
/// body is the answer. Gating on `ok()` here would report every stopped node as
/// unreachable and offer to reinstall a perfectly good agent.
fn json_of(out: &Run) -> Option<serde_json::Value> {
    serde_json::from_str(out.stdout.trim()).ok()
}

static BUNDLED_VERSION: OnceLock<Option<String>> = OnceLock::new();

/// What the shipped binary says it is. Memoized — it cannot change under a
/// running app, and probing it spawns a ~100 MB binary.
fn bundled_version() -> Option<String> {
    BUNDLED_VERSION.get_or_init(node_bin::bundled_version).clone()
}

/// Look at the machine and report what it would take to get this node running.
#[tauri::command(async)]
pub fn node_probe(settings: State<'_, SettingsState>) -> Probe {
    let mut probe = probe_now(settings.get().binary_path.as_deref());
    probe.pending_install = resume_view(&settings, &probe);
    probe
}

/// Weigh an update marker against this machine, and say what is left of it.
///
/// **The decision is `desktop-core`'s and is shared with Subshell Server**
/// (spec 2026-09-18 § 5): both apps ask the same question — is there still
/// something to install, and has it failed too often to keep trying — and
/// differ only in what they DO with the answer. The server app installs its
/// bundled server and restarts the service; this one installs the bundled
/// agent and deliberately does not restart the daemon (§ 7.1).
///
/// It rides the PROBE rather than `node_settings` for two reasons, and both
/// are about not inventing anything: the probe is the command that already
/// computes the bundled version against the installed one, which is exactly
/// the pair `resume_decision` weighs; and putting the answer on a read the
/// page already makes every few seconds is what let the whole two-phase act
/// ship without a new Tauri command — the window that finishes an update is a
/// process that did not exist when the person pressed, and it must not need a
/// wider IPC surface to find that out.
///
/// A marker whose work is DONE is cleared here, on the read that noticed. That
/// is the one write this function makes, and it is idempotent: the next probe
/// finds no marker and decides nothing. **This is where this app differs from
/// Subshell Server's twin**, which is read-only and leaves the clearing to its
/// boot path: nothing here runs at boot, because the process that finishes the
/// act learns about it from the poll the page already makes.
///
/// A marker with an EMPTY `from_app_version` is no marker, and
/// `resume_decision` says so for BOTH apps: `PendingBundledInstall` derives
/// `Default` under `#[serde(default)]`, so a truncated or hand-edited
/// `{"pendingBundledInstall":{}}` deserializes into a marker that names no
/// act — and what a marker IS is the record of one app version having handed
/// off to the next. The crate answers `Resume::Clear` for it, which reaches
/// the `view.is_none()` branch below and DROPS it.
///
/// This function had its own early return for that case, which returned
/// before the clear and so hid such a marker permanently instead of dropping
/// it — the opposite of what its comment claimed (review N4). The guard lives
/// in `desktop-core` beside the field it guards; there is nothing to repeat
/// here.
fn resume_view(settings: &SettingsState, probe: &Probe) -> Option<PendingInstall> {
    let current = settings.get();
    let marker = current.pending_bundled_install.as_ref()?;
    let decision = resume_decision(
        Some(marker),
        probe.bundled_version.as_deref(),
        // The managed-aware version, the same one `decide()` compares — see
        // `comparable_node_version`. The raw installed version here let an
        // unmanaged machine resume an install phase 1 had refused.
        probe.comparable_node_version(),
    )?;
    let view = view_of(marker, &decision);
    if view.is_none() {
        // Nothing left to install — someone ran `subshell update` by hand in
        // between, say. Drop the marker rather than keep an opinion the
        // machine disagrees with.
        let _ = settings.update(|s| s.pending_bundled_install = None);
    }
    view
}

/// What a decided marker looks like to the page, or `None` where it is spent.
///
/// Split from [`resume_view`] so the mapping is testable without a settings
/// file: everything above it is I/O, and everything below it is already
/// covered by `desktop-core`'s own tests.
fn view_of(marker: &PendingBundledInstall, decision: &Resume) -> Option<PendingInstall> {
    let halted = match decision {
        Resume::Clear => return None,
        // `forced` is ignored on purpose: it consents to a service RESTART,
        // and this app's phase 2 offers that rather than performing it
        // (spec 2026-09-18 § 7.1).
        Resume::Install { .. } => false,
        Resume::Halt => true,
    };
    Some(PendingInstall {
        from_app_version: marker.from_app_version.clone(),
        attempts: marker.attempts,
        halted,
    })
}

pub(crate) fn probe_now(configured: Option<&str>) -> Probe {
    let node_binary = node_bin::resolve(configured);
    let managed = match (&node_binary, sidecar::install_path(&NODE_SIDECAR)) {
        (Some(a), Some(managed_path)) => a.argv.first().map(String::as_str) == managed_path.to_str(),
        _ => false,
    };
    let mut p = Probe {
        bundled_version: bundled_version(),
        node_binary,
        managed,
        tmux: which("tmux"),
        has_brew: which("brew").is_some(),
        paths: node_paths(&read_node_config()),
        hostname: machine_hostname(),
        ..Default::default()
    };

    if let Some(out) = run_node(p.node_binary.as_ref(), &NodeCommand::Status) {
        p.status = json_of(&out);
        if p.status.is_none() {
            p.error = Some(format!("`status --json` failed: {}", out.detail()));
        }
    }
    if let Some(out) = run_node(p.node_binary.as_ref(), &NodeCommand::ServiceStatus) {
        p.service = json_of(&out);
        if p.service.is_none() && p.error.is_none() {
            p.error = Some(format!("`service status --json` failed: {}", out.detail()));
        }
    }
    p.decide();
    p
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/// Result of anything that changes the machine — the CLI's own words, verbatim.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

impl ActionResult {
    fn refused(reason: impl Into<String>) -> Self {
        ActionResult {
            ok: false,
            stdout: String::new(),
            stderr: reason.into(),
        }
    }

    fn said(message: impl Into<String>) -> Self {
        ActionResult {
            ok: true,
            stdout: message.into(),
            stderr: String::new(),
        }
    }
}

impl From<Run> for ActionResult {
    fn from(r: Run) -> Self {
        // A failure with nothing on stderr is the one that reads as success in
        // a UI — a spawn error or a deadline leaves both streams empty, so fall
        // back to whatever the run can say about itself.
        let stderr = if r.ok() || !r.stderr.trim().is_empty() {
            r.stderr.clone()
        } else {
            r.detail()
        };
        ActionResult {
            ok: r.ok(),
            stdout: r.stdout,
            stderr,
        }
    }
}

/// Why an install must not proceed, or `None` when it may.
///
/// The one refusal is the DOWNGRADE, and it is stated here because nothing
/// downstream states it: [`decide_node`]'s rule is that a newer bundled agent
/// is OFFERED and a newer installed one is ADOPTED — never overwritten, never
/// even offered — but `sidecar::already_installed` compares size and version
/// for EQUALITY, not order, so an older bundled binary would cheerfully
/// overwrite a newer installed one. A node agent speaks a versioned wire
/// protocol to the control plane and owns state the plane pushes to it, so that
/// trade buys a node which enrolls, comes up ONLINE and then refuses every
/// launch.
///
/// The page does not offer the install in this case either, but the page's
/// probe is a snapshot: an agent installed from a terminal a moment ago is
/// newer than anything the open window knows about. This runs BEFORE the
/// service is stopped or a byte is copied.
///
/// Decided against the RESOLVED agent rather than read off `Probe::node_choice`
/// — that field is deliberately narrowed to the copy this app manages, because
/// an upgrade OFFER for an agent the service does not run would change nothing
/// and repeat forever. The guard has to be wider than the offer: `~/.local/bin`
/// outranks the login PATH and the well-known directories, so writing an older
/// binary there is a downgrade of what this app drives even when it never
/// installed the newer one.
pub fn install_refusal(bundled: Option<&str>, installed: Option<&str>) -> Option<String> {
    // Both versions are readable by construction: an agent that cannot state
    // one never resolves, and `decide_node` reaches AdoptInstalled only when
    // it has two to compare.
    if decide_node(bundled, installed) != NodeChoice::AdoptInstalled {
        return None;
    }
    let (bundled, installed) = (bundled?, installed?);
    Some(format!(
        "the agent already installed on this machine ({installed}) is newer than the one this app ships \
         ({bundled}), so installing would downgrade it: an agent older than the control plane expects enrolls, \
         comes up online and then refuses every launch. Nothing was changed, and the installed agent is the one \
         this app drives."
    ))
}

/// Two blocks of CLI output in the order they happened.
fn joined(first: &str, second: &str) -> String {
    let (a, b) = (first.trim(), second.trim());
    match (a.is_empty(), b.is_empty()) {
        (true, _) => b.to_string(),
        (_, true) => a.to_string(),
        _ => format!("{a}\n\n{b}"),
    }
}

/// How long a delegated `update --from` may take.
///
/// Longer than [`ACTION_TIMEOUT`] because this one call copies ~110 MB and
/// then probes the copy's `version`. The plain copy it replaces had no
/// deadline at all (it was `fs::copy`), so a 90-second budget would be a new
/// way for a slow disk to fail.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(300);

/// Materialise the bundled agent at `~/.local/bin/subshell`.
///
/// **Two paths, decided by whether there is an installed CLI to ask** (spec
/// 2026-09-15 § 7.1):
///
/// - **A REPLACE of the managed copy** — `probe.managed`, i.e. the binary this
///   machine actually runs IS `~/.local/bin/subshell` — goes through that
///   binary's own `update --from`. The agent has no database, so what the verb
///   buys here is narrower than on the server: `<binary>.previous`, the
///   `update-pending.json` marker, and the version probe that refuses a file
///   which cannot say what it is. It is still the same code on every path,
///   which is the point.
/// - **A first install** keeps [`sidecar::install_bundled`]: there is no
///   installed CLI to run, and writing a file where none was is not a
///   transaction.
///
/// **The service is no longer stopped on the replace path, and nothing is
/// started.** The CLI's swap is a `rename(2)` a running daemon does not
/// notice, so the stop that `install_bundled` needed (and the pane warning it
/// carried) has nothing left to protect. `--no-restart` keeps the deliberate
/// no-restart this command has always had, and since spec 2026-09-18 § 7.1 the
/// screen OFFERS that restart rather than telling anyone to start something.
/// Nothing here was ever stopped: the daemon is running, on the previous
/// binary's inode, which is exactly the fact the offer exists to state.
fn install_node_now(settings: &SettingsState) -> Result<ActionResult, String> {
    let configured = settings.get().binary_path;
    let version = bundled_version();
    let probe = probe_now(configured.as_deref());
    if let Some(reason) = install_refusal(
        version.as_deref(),
        probe.node_binary.as_ref().and_then(|a| a.version.as_deref()),
    ) {
        return Ok(ActionResult::refused(reason));
    }
    if probe.managed {
        let Some(staged) = sidecar::bundled_path(&NODE_SIDECAR) else {
            return Err("this build ships no subshell node CLI".into());
        };
        let installed = probe.node_binary.as_ref().and_then(|a| a.version.clone());
        return delegate_update(
            probe.node_binary.as_ref(),
            &staged,
            version.as_deref(),
            installed.as_deref(),
        );
    }
    match sidecar::install_bundled(&NODE_SIDECAR, version.as_deref(), || {})? {
        sidecar::InstallOutcome::NoSidecar => Err("this build ships no subshell node CLI".into()),
        sidecar::InstallOutcome::UpToDate => Ok(ActionResult::said("The bundled node CLI is already installed.")),
        sidecar::InstallOutcome::Installed => {
            let where_ = sidecar::install_path(&NODE_SIDECAR)
                .map(|p| p.display().to_string())
                .unwrap_or_default();
            Ok(ActionResult::said(format!("Installed subshell to {where_}.")))
        }
    }
}

/// The delegated update's whole command line: the resolved agent, then the
/// flags [`cli_update::update_args`] owns.
///
/// Split out so the argv is testable without running anything — the flags are
/// a contract with the CLI (see `desktop-core`'s `cli_update`), and this app
/// must never spell one of them itself.
fn update_argv(node_binary: Option<&NodeBinary>, staged: &Path) -> Option<Vec<String>> {
    let mut argv = node_binary?.argv.clone();
    argv.extend(cli_update::update_args(staged));
    Some(argv)
}

/// Run the installed agent's own `update --from <staged sidecar>`.
///
/// The CLI's words reach the screen verbatim — this adds exactly one sentence
/// built from the `--json` tail, naming what moved
/// (`cli_update::update_summary`). A run with no JSON tail is not a failure:
/// "Already at 0.9.0." exits 0 and prints prose, and the screen shows it.
///
/// **One failure is answered rather than reported: an agent that predates the
/// `update` verb.** Every install that existed on 2026-09-15 does — 0.8.0 was
/// cut before the verb was written — so without this the app's offer would
/// fail on exactly the upgrade it is there for, with a usage dump. The
/// fallback is [`sidecar::install_bundled`], the same `rename(2)` swap this
/// path used before, and the screen SAYS what it could not do. Every other
/// failure of `update` is still a failure: see
/// [`cli_update::lacks_update_verb`] for why the test is as narrow as it is.
fn delegate_update(
    node_binary: Option<&NodeBinary>,
    staged: &Path,
    bundled: Option<&str>,
    installed: Option<&str>,
) -> Result<ActionResult, String> {
    let Some(argv) = update_argv(node_binary, staged) else {
        return Ok(ActionResult::refused("no installed subshell node CLI to update"));
    };
    match classify_update(run(&argv, UPDATE_TIMEOUT)) {
        AfterUpdate::Legacy => install_over_legacy(bundled, installed),
        AfterUpdate::Reported(result) => Ok(result),
    }
}

/// What a finished `update` run calls for.
///
/// Pure, and split out from [`delegate_update`] for one reason: the branch it
/// decides is "copy the binary instead", and a test of that decision must not
/// be able to reach [`sidecar::install_bundled`] — which would write into the
/// tester's own `~/.local/bin`. So the decision is testable and the action is
/// not, which is the right way round.
#[derive(Debug)]
enum AfterUpdate {
    /// The CLI did the work; this is its report, with the summary appended.
    Reported(ActionResult),
    /// The CLI has no `update` verb. Copy the file, and say what that costs.
    Legacy,
}

fn classify_update(run: Run) -> AfterUpdate {
    if cli_update::lacks_update_verb(&run) {
        return AfterUpdate::Legacy;
    }
    let result = ActionResult::from(run);
    let Some(report) = cli_update::parse_update_report(&result.stdout) else {
        return AfterUpdate::Reported(result);
    };
    let summary = cli_update::update_summary(&report, "node CLI");
    AfterUpdate::Reported(ActionResult {
        stdout: joined(&result.stdout, &summary),
        ..result
    })
}

/// Replace an agent too old to update itself, and say so.
///
/// The plain copy the replace path used before the transaction existed. It is
/// correct here for the same reason it was correct then — a temp file in the
/// same directory and a `rename(2)`, which a running daemon does not notice —
/// and it is NOT correct anywhere else, because it leaves no `.previous`.
///
/// The agent has no database, so the sentence claims no missing BACKUP: what
/// it loses is the rollback point, and naming a database here would alarm
/// about something this CLI's own `update` never does either.
///
/// No `stop_first` and no restart: both are exactly as they are on the
/// `update` path, which passes `--no-restart` and leaves the RESTART to the
/// screen — nothing was stopped, so the daemon is up on the previous binary's
/// inode until someone restarts it (spec § 7.1/§ 7.2; review N2, the second
/// site of the wrong verb I9 fixed one function up).
fn install_over_legacy(bundled: Option<&str>, installed: Option<&str>) -> Result<ActionResult, String> {
    match sidecar::install_bundled(&NODE_SIDECAR, bundled, || {})? {
        sidecar::InstallOutcome::NoSidecar => Err("this build ships no subshell node CLI".into()),
        // `update` refused the verb, so the installed copy is NOT this one —
        // a size-and-version match here would mean the probe and the binary
        // disagree, which is worth saying rather than smoothing over.
        sidecar::InstallOutcome::UpToDate => Ok(ActionResult::said("The bundled node CLI is already installed.")),
        sidecar::InstallOutcome::Installed => Ok(ActionResult::said(cli_update::legacy_install_summary(
            installed,
            bundled,
            "node CLI",
            cli_update::Unrecorded::Rollback,
        ))),
    }
}

/// Install the bundled agent, and settle any update marker the install belongs
/// to.
///
/// **The attempt is counted BEFORE the install and the marker is dropped after
/// a successful one**, which is what bounds the second phase (spec
/// 2026-09-18 § 5). Counting here rather than at boot is deliberate: an
/// attempt is an attempt whoever asked for it, and this is the one place every
/// route into the agent half passes through — the resumed act, the Retry the
/// screen offers once it has halted, and the status screen's own door.
///
/// A successful install by ANY of those routes finishes the act, because what
/// the marker records is that the bundled agent had not been installed yet.
#[tauri::command(async)]
pub fn node_install_cli(settings: State<'_, SettingsState>) -> Result<ActionResult, String> {
    let resuming = settings.get().pending_bundled_install.is_some();
    if resuming {
        let _ = settings.update(|s| {
            if let Some(marker) = s.pending_bundled_install.as_mut() {
                marker.attempts = marker.attempts.saturating_add(1);
            }
        });
    }
    let outcome = install_node_now(&settings);
    // Only a run that actually replaced the file clears it. A rejection or a
    // refusal leaves the marker for the Retry the screen offers, which is the
    // whole reason the marker outlives a failure.
    if resuming && matches!(&outcome, Ok(result) if result.ok) {
        let _ = settings.update(|s| s.pending_bundled_install = None);
    }
    outcome
}

/// The event each output line is emitted on while tmux installs.
///
/// Named here rather than inline because the page listens for this exact
/// string and nothing else connects the two — `wire-names.test.ts` reads both
/// files and holds them equal.
pub const INSTALL_LINE_EVENT: &str = "node-install-line";

/// Install tmux with this machine's own package manager.
///
/// tmux is the one prerequisite an enrolled node cannot do without: the agent
/// opens every pane through it, so a machine missing it comes up online and
/// 409s every launch. Subshell Server has offered this since its own setup
/// assistant existed; the table it drives is
/// `desktop_core::tmux`, shared so the two apps cannot come to disagree about
/// what may be run with a person's own privileges.
///
/// The client's [`Probe`] carries `tmux` — the path, or nothing — and, since
/// the brew-less Mac dead end, `has_brew`; it carries no platform, which the
/// page reads off its own user agent. Both are re-read HERE regardless, and
/// that is not a duplicate: what the page may SHOW and what this command may
/// RUN are two decisions taken at two moments, and a probe read seconds ago is
/// not the machine at the instant of the spawn.
///
/// `Err` — not an `ActionResult` — on a platform that offers nothing this app
/// may drive (macOS without Homebrew; anything that is neither macOS nor
/// Linux). That is the distinction the screen renders: "here is the command to
/// type" rather than "the install failed".
#[tauri::command(async)]
pub fn node_install_tmux(app: AppHandle) -> Result<ActionResult, String> {
    let brew = which("brew").is_some();
    // `install` is STREAMED — a cold `brew install` runs for minutes and the
    // manager's own output is the only honest progress signal, since no
    // percentage can be derived from Fetching → Pouring → Summary — so it
    // takes a per-line sink. The lines were DROPPED until the tmux screen grew
    // a progress pane to put them in: an event emitted for no listener is a
    // name with nothing on the other end, which the sibling app says at its
    // own emit. There is a listener now.
    //
    // `emit_to` the node window, where that app broadcasts. Not caution about
    // a listener count — this app's OTHER window is a control plane's own
    // page, remote content this app tells nothing, and a package manager's
    // output is this window's business.
    let handle = app.clone();
    let sink: LineSink = Arc::new(move |line: &str| {
        // Best-effort by design: a failed emit means nothing is listening (the
        // window closed mid-install), and the install carries on and still
        // reports through its return value.
        let _ = handle.emit_to(crate::windows::NODE_LABEL, INSTALL_LINE_EVENT, line.to_string());
    });
    Ok(subshell_desktop_core::tmux::install(std::env::consts::OS, brew, sink)?.into())
}

/// One `service` verb, straight through. The agent decides whether to refuse —
/// including the pane guard, which refuses a `restart` whose installed
/// definition would SIGKILL every live subshell on this machine.
#[tauri::command(async)]
pub fn node_service(
    settings: State<'_, SettingsState>,
    verb: ServiceCommand,
    force: bool,
    autostart: Option<bool>,
) -> ActionResult {
    // Absent means armed: every caller that predates the start-up screen —
    // and every verb but `install` and `autostart`, for which the flag is
    // meaningless — must keep installing a service that comes back at login.
    // On `autostart` the value is the request itself (on/off), so the page
    // always sends it for that verb; the default is the belt.
    service_now(&settings, verb, force, autostart.unwrap_or(true))
}

/// The body of [`node_service`], callable from inside another chain.
///
/// Extracted so the reset runs the SAME stop and uninstall the page's own
/// buttons run, rather than a second spelling of them — a reset whose teardown
/// diverged from the one the user can press by hand is a reset that leaves a
/// different machine behind.
pub(crate) fn service_now(
    settings: &SettingsState,
    verb: ServiceCommand,
    force: bool,
    autostart: bool,
) -> ActionResult {
    let node_binary = node_bin::resolve(settings.get().binary_path.as_deref());
    match run_node(node_binary.as_ref(), &NodeCommand::Service { verb, force, autostart }) {
        Some(out) => out.into(),
        None => ActionResult::refused(NO_NODE),
    }
}

/// Stop being a node: stop, uninstall the definition, then delete the config.
///
/// The narrow sibling of [`crate::reset::node_reset`]. That one is the broad
/// teardown — it closes every pane server, wipes the data directory and takes
/// the config with it; this one leaves the work, the data and the installed
/// binary exactly where they are and spends only the identity. The chain
/// deliberately carries the reset's proven first two steps and none of its
/// tmux half: a running subshell outliving its node is this product's design
/// (the client's confirm says so, in words the CLI itself keeps), so
/// un-enroll orphans panes rather than killing them.
///
/// Stop and uninstall run FIRST and tolerate "nothing installed", for the
/// reset's own reason: a kept definition respawns a daemon against a deleted
/// config, and a Retry after any later failure must not die on a step whose
/// subject an earlier half-run already removed. Then the CLI's verb deletes
/// `daemon.lock` before `config.json` (config LAST, the resumability rule it
/// shares with the reset); the CLI's own refusal words — a live unsupervised
/// daemon, running panes — reach the screen verbatim, `--yes` notwithstanding
/// for the panes only.
#[tauri::command(async)]
pub fn node_unenroll(settings: State<'_, SettingsState>) -> ActionResult {
    let mut log = String::new();
    let stop = service_now(&settings, ServiceCommand::Stop, false, true);
    if let Some(stderr) = crate::reset::push_step(&mut log, &stop, &["nothing installed"]) {
        return ActionResult {
            ok: false,
            stdout: log,
            stderr,
        };
    }
    let un = service_now(&settings, ServiceCommand::Uninstall, false, true);
    if let Some(stderr) = crate::reset::push_step(&mut log, &un, &["nothing installed"]) {
        return ActionResult {
            ok: false,
            stdout: log,
            stderr,
        };
    }
    let node_binary = node_bin::resolve(settings.get().binary_path.as_deref());
    let Some(out) = run_node(node_binary.as_ref(), &NodeCommand::Unenroll) else {
        return ActionResult::refused(NO_NODE);
    };
    let out = ActionResult::from(out);
    ActionResult {
        ok: out.ok,
        stdout: format!("{log}{}", out.stdout),
        stderr: out.stderr,
    }
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

/// Why the app is asking before it spends a setup key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConfirmKind {
    /// A `config.json` already exists on this machine.
    AlreadyEnrolled,
    /// The control-plane URL points at this machine's own loopback address.
    LoopbackServer,
}

/// One thing the user has to acknowledge before [`node_enroll`] runs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Confirmation {
    pub kind: ConfirmKind,
    pub message: String,
}

/// What one enrollment attempt produced.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollOutcome {
    pub ok: bool,
    /// The CLI's stdout, verbatim.
    pub stdout: String,
    /// The CLI's stderr, verbatim — or this app's own refusal.
    pub stderr: String,
    /// The parsed `enroll --json` body on success:
    /// `{nodeId, serverUrl, name, dataDir, configPath}`. Never the node key —
    /// the CLI does not print it and the 0600 config file is its only home.
    pub node: Option<serde_json::Value>,
    /// True when nothing was run and the caller must ask, then call again with
    /// `confirm: true`.
    pub requires_confirmation: bool,
    pub confirmations: Vec<Confirmation>,
}

impl EnrollOutcome {
    fn refused(reason: impl Into<String>) -> Self {
        EnrollOutcome {
            ok: false,
            stdout: String::new(),
            stderr: reason.into(),
            node: None,
            requires_confirmation: false,
            confirmations: Vec::new(),
        }
    }

    fn ask(confirmations: Vec<Confirmation>) -> Self {
        EnrollOutcome {
            ok: false,
            stdout: String::new(),
            stderr: String::new(),
            node: None,
            requires_confirmation: true,
            confirmations,
        }
    }
}

/// Validate and normalize a control-plane URL exactly as the CLI does.
///
/// Parses for validity but returns the TRIMMED ORIGINAL with trailing slashes
/// removed, rather than the parser's normalized spelling — `normalizeServer`
/// in `apps/node/agent/src/enroll.ts` does the same, and the string this returns is
/// the one that gets persisted into `config.json` and dialed forever after.
pub fn validate_server_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("enter the control plane's URL, e.g. https://subshell.example.com".into());
    }
    let url: tauri::Url = trimmed
        .parse()
        .map_err(|_| format!("'{trimmed}' is not a full URL. Include the scheme, e.g. https://subshell.example.com"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("the server URL must be http or https, not '{}'", url.scheme()));
    }
    if url.host_str().filter(|h| !h.is_empty()).is_none() {
        return Err(format!("'{trimmed}' names no host"));
    }
    // Rebuilt from the PARSED scheme and authority, which `tauri::Url` has
    // already lower-cased, rather than returned raw.
    //
    // The raw form preserved a mixed-case scheme, and this string is what the
    // page shows, what the saved plane list holds, and what is handed to
    // `subshell configure --server`. The agent's `wsUrlFor` derives its dial
    // URL by string-replacing the scheme, so `HTTP://host` became
    // `HTTP://host/ws/node` — not a WebSocket URL, and nothing said why. The
    // agent normalizes on write too (`normalizeServer`); this keeps the two
    // spellings of "one normalization" in agreement.
    //
    // The path is kept (minus trailing slashes) because a control plane behind
    // a reverse-proxy subpath is a real deployment and a path is
    // case-sensitive.
    let path = url.path().trim_end_matches('/');
    let query = url.query().map(|q| format!("?{q}")).unwrap_or_default();
    let host = url.host_str().unwrap_or_default();
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    Ok(format!("{}://{host}{port}{path}{query}", url.scheme()))
}

/// Whether a control-plane URL points at this machine.
///
/// Not an error — running the control plane and a node on one box is a
/// legitimate setup, and the desktop pair exists partly for it. But a URL
/// copied from a browser on ANOTHER machine is the enrollment trap the Nodes
/// page warns about: the node dutifully dials its own loopback, enrolls
/// against nothing, and the setup key is spent.
pub fn is_loopback_server(url: &str) -> bool {
    let Ok(parsed) = url.trim().parse::<tauri::Url>() else {
        return false;
    };
    let Some(host) = parsed.host_str() else { return false };
    host == "localhost"
        || host.ends_with(".localhost")
        || host.starts_with("127.")
        || host == "::1"
        || host == "0.0.0.0"
        || host == "[::1]"
}

/// Validate a `nsk_…` setup key's shape.
///
/// The value is never echoed back, in this message or any other: it is a
/// one-time credential, and an error string is the easiest place for one to end
/// up on a screenshot.
pub fn validate_setup_key(raw: &str) -> Result<String, String> {
    const SHAPE: &str = "a setup key looks like `nsk_` followed by 32 letters, digits, `-` or `_`; copy it from Settings → Node setup keys";
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("paste the setup key minted on the Nodes page".into());
    }
    let Some(body) = trimmed.strip_prefix(SETUP_KEY_PREFIX) else {
        return Err(format!("that does not look like a setup key: {SHAPE}"));
    };
    if body.chars().count() != SETUP_KEY_BODY_LEN
        || !body.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("that setup key is malformed: {SHAPE}"));
    }
    Ok(trimmed.to_string())
}

/// The node's display name, REQUIRED, trimmed.
///
/// The three rules of this form are shared with the bundled page
/// (`ui/src/lib/enroll-validation.ts`) and with the CLI, which refuses a
/// nameless `enroll` outright. Trimming happens HERE so a stray space is not
/// visible in the argv the CLI then re-normalizes; the cap is checked on the
/// trimmed value because the control plane counts characters and a 400 from it
/// costs the single-use setup key.
pub fn validate_node_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("Name this machine: the Nodes page lists it by this name".into());
    }
    let len = name.chars().count();
    if len > MAX_NODE_NAME_LEN {
        return Err(format!(
            "That name is {len} characters; the control plane accepts at most {MAX_NODE_NAME_LEN}"
        ));
    }
    Ok(name.to_string())
}

/// What this machine already is, as far as `config.json` can say.
///
/// Three states rather than an `Option`, because "there is a config here but
/// it cannot be read" is a real one and is the case where a plain `Option`
/// silently becomes "not enrolled" — which is the one answer that would wave
/// the destructive step through. A corrupt config still holds a node key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExistingNode {
    /// No `config.json`. Enrolling is the ordinary first step.
    None,
    /// A `config.json` exists but its `nodeId` could not be read.
    Unreadable,
    /// A `config.json` naming this node, and the control plane it answers to.
    Known {
        node_id: String,
        server_url: Option<String>,
    },
}

/// The sentence every AlreadyEnrolled confirmation ends with.
const REENROLL_COST: &str = "Enrolling again overwrites that configuration, registers a SECOND node on the control \
                             plane, and discards the current node key, whose only copy is that file. The old node \
                             row stays behind and has to be deleted by hand.";

/// What the user must acknowledge before a setup key is spent.
pub fn confirmations_for(server: &str, existing: &ExistingNode) -> Vec<Confirmation> {
    let mut out = Vec::new();
    let already = match existing {
        ExistingNode::None => None,
        ExistingNode::Unreadable => {
            Some("This machine already has a node configuration, though its node id could not be read.".to_string())
        }
        // Naming the SERVER too, because re-enrolling against a different
        // control plane is the case where "already enrolled" is not obviously
        // a mistake — and the case where losing the old node key matters most.
        ExistingNode::Known { node_id, server_url } => Some(match server_url {
            Some(url) => format!("This machine is already enrolled as node {node_id} on {url}."),
            None => format!("This machine is already enrolled as node {node_id}."),
        }),
    };
    if let Some(lead) = already {
        out.push(Confirmation {
            kind: ConfirmKind::AlreadyEnrolled,
            message: format!("{lead} {REENROLL_COST}"),
        });
    }
    if is_loopback_server(server) {
        out.push(Confirmation {
            kind: ConfirmKind::LoopbackServer,
            message: format!(
                "{server} is a loopback address, so this node will look for a control plane on THIS machine. \
                 That is right if you run the server here, and wrong if you copied the URL out of a browser on \
                 another machine; a setup key is single-use, so a wrong URL spends it."
            ),
        });
    }
    out
}

/// Register this machine as a node.
///
/// Guarded rather than gated: the CLI has no already-enrolled check, so
/// `enroll` overwrites `config.json` unconditionally. Every reason to hesitate
/// is collected FIRST and returned with nothing spawned, because a setup key is
/// single-use and 24-hour — and every failure after the control plane consumes
/// it spends it permanently. When the CLI does fail, its message is the answer:
/// "mint a new key", never "retry".
#[tauri::command(async)]
pub fn node_enroll(
    settings: State<'_, SettingsState>,
    server: String,
    key: String,
    name: String,
    confirm: bool,
) -> EnrollOutcome {
    let server = match validate_server_url(&server) {
        Ok(s) => s,
        Err(e) => return EnrollOutcome::refused(e),
    };
    let key = match validate_setup_key(&key) {
        Ok(k) => k,
        Err(e) => return EnrollOutcome::refused(e),
    };
    let name = match validate_node_name(&name) {
        Ok(n) => n,
        Err(e) => return EnrollOutcome::refused(e),
    };

    // Resolved BEFORE the confirmation, so a machine with no agent is told so
    // instead of being asked to confirm something that then cannot happen.
    let node_binary = node_bin::resolve(settings.get().binary_path.as_deref());
    if node_binary.is_none() {
        return EnrollOutcome::refused(NO_NODE);
    }

    if !confirm {
        let confirmations = confirmations_for(&server, &existing_node());
        if !confirmations.is_empty() {
            return EnrollOutcome::ask(confirmations);
        }
    }

    let Some(out) = run_node(node_binary.as_ref(), &NodeCommand::Enroll { server, key, name }) else {
        return EnrollOutcome::refused(NO_NODE);
    };
    let node = out.ok().then(|| json_of(&out)).flatten();
    let stderr = if out.ok() || !out.stderr.trim().is_empty() {
        out.stderr.clone()
    } else {
        out.detail()
    };
    EnrollOutcome {
        ok: out.ok(),
        stdout: out.stdout,
        stderr,
        node,
        requires_confirmation: false,
        confirmations: Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// Preferences and paths
// ---------------------------------------------------------------------------

/// The stored close-to-tray preference against a FRESH tray probe. The one
/// thing `lib.rs`'s window and exit handlers ask.
///
/// Deliberately re-probed rather than read off the last answer: the setting
/// may have been made on a desktop that had a tray, and this is the moment the
/// window would disappear. A StatusNotifier host that has gone away since —
/// an extension disabled, a different session type logged into — means the
/// window closes normally instead of vanishing into an icon nothing draws.
/// `subshell_desktop_core::tray` holds no state, so every call is that probe.
pub fn close_to_tray_now(settings: &SettingsState) -> bool {
    effective_close_to_tray(settings.get().close_to_tray, tray_support())
}

/// The app's own preferences, for the window to render.
///
/// TWO fields, since spec 2026-09-12 § 6.4. The tray preference used to be
/// here as a trio — the value, whether the switch was live, and why it was not
/// — because the node page drew a switch for it. It is a check item in the
/// tray menu now, which is where a preference about the tray belongs, and the
/// three fields left with the switch rather than moving to another screen. The
/// clamp they existed to express still runs, in `close_to_tray_now`, which is
/// what both the tray item and the window-close handler read.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSettings {
    /// The agent binary the user picked by hand, if any.
    pub node_bin_path: Option<String>,
    /// The saved control-plane addresses, as stored (canonical spellings —
    /// every entry went through [`validate_server_url`] on the way in).
    ///
    /// Raw, with no ladder: the address the NODE reports to is a probe fact
    /// and the page renders it as its own pinned row, so folding it in here
    /// would be two sources for one truth.
    pub planes: Vec<String>,
}

/// Build the payload from the stored settings.
fn settings_view(current: Settings) -> NodeSettings {
    NodeSettings {
        node_bin_path: current.binary_path,
        planes: current.planes,
    }
}

/// Read the app's own preferences.
#[tauri::command(async)]
pub fn node_settings(settings: State<'_, SettingsState>) -> NodeSettings {
    settings_view(settings.get())
}

// ---------------------------------------------------------------------------
// The control plane
// ---------------------------------------------------------------------------

/// Add one address to the saved plane list — pure, so the rules are unit-
/// tested without a settings file: canonicalized by the same
/// [`validate_server_url`] every opener uses; equal to an entry already
/// stored (canonically, so a trailing slash or a shouty host is not a second
/// plane) is not added twice; and EQUAL TO THE NODE'S OWN ADDRESS is refused
/// outright — that one always renders as the pinned row, and two rows for one
/// plane is exactly what the pinned row exists to prevent. Unparseable
/// stored entries survive untouched: they are nobody's match, and dropping
/// them here would let an `add` rewrite history it was not asked about.
fn plane_list_add(list: &[String], raw: &str, own: Option<&str>) -> Result<Vec<String>, String> {
    let canonical = validate_server_url(raw)?;
    if own == Some(canonical.as_str()) {
        return Err(format!(
            "this machine's node already reports to {canonical}; it is always in the list"
        ));
    }
    let mut next = list.to_vec();
    if !next
        .iter()
        .any(|s| validate_server_url(s).as_deref() == Ok(canonical.as_str()))
    {
        next.push(canonical);
    }
    Ok(next)
}

/// Remove one address, matched canonically. Absent is an ERROR, not a silent
/// success: the page can only name a row it is rendering, so a miss means the
/// list moved underneath it, and pretending otherwise would let a stale row
/// report itself removed while it still renders.
fn plane_list_remove(list: &[String], raw: &str) -> Result<Vec<String>, String> {
    let canonical = validate_server_url(raw)?;
    let next: Vec<String> = list
        .iter()
        .filter(|s| validate_server_url(s).as_deref() != Ok(canonical.as_str()))
        .cloned()
        .collect();
    if next.len() == list.len() {
        return Err(format!("no saved control plane at {canonical}"));
    }
    Ok(next)
}

/// Add a control plane to the saved list. Saves ONLY — the plane list ruling
/// (operator, 2026-09-22) keeps storing and opening separate: first run names
/// an address and then has more to do (enrol, install, start), and opening
/// mid-walk threw the dashboard over the question still being asked.
///
/// Returns the whole resulting list, canonically spelled, so the page's
/// refetched settings ARE the dedupe/validation feedback.
#[tauri::command(async)]
pub fn node_plane_add(settings: State<'_, SettingsState>, url: String) -> Result<Vec<String>, String> {
    let own = read_node_config().server_url.and_then(|u| validate_server_url(&u).ok());
    let next = plane_list_add(&settings.get().planes, &url, own.as_deref())?;
    settings.update(|s| s.planes = next.clone())?;
    Ok(next)
}

/// Forget a saved control plane. Opens nothing and touches no plane — this
/// list is the app's own bookmarks, and detaching the MACHINE from a plane is
/// the node's acts (Service's un-enroll and the lifecycle verbs), never an
/// edit of this list.
#[tauri::command(async)]
pub fn node_plane_remove(settings: State<'_, SettingsState>, url: String) -> Result<Vec<String>, String> {
    let next = plane_list_remove(&settings.get().planes, &url)?;
    settings.update(|s| s.planes = next.clone())?;
    Ok(next)
}

/// Show a control plane's own UI, at the address the page names.
///
/// Opens are ONE-OFF since the plane list ruling (operator, 2026-09-22):
/// this stores nothing — the saved list is written by `node_plane_add` and
/// by nothing else — so pressing a row navigates the plane window without
/// rewriting anybody's bookmarks. `PlanePin` follows each deliberate open,
/// which is what keeps `desktop_open_in_browser` aimed at the plane the row
/// named rather than at whatever the page last was.
///
/// The window this opens is granted exactly ONE command — see
/// `windows::open_plane` — so this is nearly the whole of the plane's reach
/// into the app: a webview, an origin pin, and `desktop_open_in_browser`,
/// which takes a path and joins it onto that same pin. Nothing that drives the
/// CLI is reachable from it.
#[tauri::command(async)]
pub fn node_open_plane(app: AppHandle, url: String) -> Result<String, String> {
    let resolved = validate_server_url(&url)?;
    crate::windows::open_plane(&app, &resolved)?;
    Ok(resolved)
}

/// Open one control plane's address in the SYSTEM browser.
///
/// The in-app plane window stays the primary route; this is for taking a row
/// somewhere a shell cannot — a different browser, a share, a profile with
/// passkeys the webview has no. Since the plane list ruling (operator,
/// 2026-09-22) the page names the ADDRESS: the only window holding this
/// command is the BUNDLED node page, every address it can name is one the
/// person stored or the probe read from this machine's own config, and the
/// value is http(s)-validated HERE by the same rule the window opener uses.
/// The REMOTE plane window remains granted nothing but
/// `desktop_open_in_browser`, which still takes a path and names no host.
#[tauri::command(async)]
pub fn node_open_plane_url(app: AppHandle, url: String) -> Result<(), String> {
    let resolved = validate_server_url(&url)?;
    app.opener()
        .open_url(&resolved, None::<&str>)
        .map_err(|e| format!("could not open {resolved}: {e}"))
}

/// The MENU BAR's "Open in Browser" id.
///
/// It lives here rather than in `menu.rs` because that module is macOS-only
/// and `tray.rs` — which is not — has to assert the two ids DIFFER: a Tauri
/// menu event is global, so one id handled in both menus fires twice per
/// click, which for this item is two browser tabs. A constant behind a
/// `#[cfg]` cannot be named from a test that compiles on Linux.
///
/// Which leaves it with NO non-test user on Linux — `menu.rs` is the only one
/// and that module is macOS-only — and `mod control` is private, so a `pub`
/// item in it is not externally reachable and `dead-code` fires. Measured on
/// this crate by rewriting every `target_os = "macos"` predicate to one that
/// is false here: `cargo clippy --all-targets -- -D warnings` (CI's exact
/// command) then fails the LIB target with "constant `MENU_BROWSER_ID` is
/// never used". The `#[cfg(test)]` use in `tray.rs` does not rescue it —
/// `--all-targets` still builds the lib target without `cfg(test)`. Hence the
/// allow, scoped to the platforms where the item really is unused.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const MENU_BROWSER_ID: &str = "menu:browser";

/// Open one page of the control plane this window is on, in the system browser.
///
/// **The only command granted to the plane's window**, and the only one that
/// ever will be without the argument in `docs/security.md` being rewritten. It
/// is safe for a window whose origin this app cannot enumerate because it names
/// no origin: the page supplies a PATH,
/// `subshell_desktop_core::browser::browser_url` refuses anything that could be
/// a host, and the origin comes from [`crate::windows::PlanePin`] — the origin
/// this window was OPENED with.
///
/// **The pin is no longer what the navigation handler enforces** (2026-09-18):
/// the window follows any http(s) URL, so a plane behind an OAuth proxy can
/// complete its sign-in. That is precisely why this command reads the pin
/// rather than the page. A redirect chain does not move the pin; only a
/// deliberate plane switch does. So the honest bound is **any http(s) page this
/// window reaches can open an arbitrary PATH of the PINNED plane** in the
/// person's browser — a page of a control plane the person chose, in a browser
/// where they are signed out. `docs/security.md` § 11.11 words the same
/// residual.
///
/// The pin rather than `resolve_plane_url`, because a second ladder could
/// answer differently. But it names the plane this window is being pointed AT,
/// which during a switch is the NEW one: `open_plane` sets the pin before
/// calling `navigate`, so between those two lines the still-rendered page of
/// plane A can have a path of its choosing joined onto plane B's origin.
///
/// Accepted, and worth stating rather than implying. The window is one
/// `navigate` call wide, the person just chose plane B themselves, and the
/// worst case is a browser GET to a page of B with a path A picked — no
/// credential of B's is involved, since the browser carries no cookie from this
/// webview at all. Narrowing it would mean either a second origin ladder to
/// disagree with the guard, or holding a lock across a webview navigation.
///
/// The person signs in again over there — a browser carries no cookie from
/// this webview — and that is not a bug this command should paper over.
#[tauri::command(async)]
pub fn desktop_open_in_browser(app: AppHandle, path: String) -> Result<(), String> {
    let origin = app
        .state::<crate::windows::PlanePin>()
        .get()
        .ok_or_else(|| "no control plane is open yet".to_string())?;
    let url = subshell_desktop_core::browser::browser_url(&origin, &path)?;
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| format!("could not open {url}: {e}"))
}

/// Open whatever the plane window is showing, in the system browser.
///
/// The tray's and the menu bar's entry point, and Rust-side on purpose: this
/// app tells the plane's page nothing (no `eval` bridge, no `DesktopAction`),
/// so a menu item that needed the page to act could not exist here at all.
///
/// The CURRENT route when the window can report one, `/` otherwise — the plane
/// is still a sensible page to offer, and a menu item disabled until a window
/// exists would be a dead end on the one desktop where the tray is the only
/// route to anything.
///
/// Failure goes to stderr and nowhere else: a menu item has no place to render
/// an error, and the one way this fails (no plane opened yet) is a state the
/// person can see.
pub fn open_current_in_browser(app: &AppHandle) {
    let path = app
        .get_webview_window(crate::windows::PLANE_LABEL)
        .and_then(|w| w.url().ok())
        .map(|url| match url.query() {
            Some(query) => format!("{}?{}", url.path(), query),
            None => url.path().to_string(),
        })
        .unwrap_or_else(|| "/".to_string());
    if let Err(err) = desktop_open_in_browser(app.clone(), path) {
        eprintln!("subshell-client: could not open this page in a browser: {err}");
    }
}

/// The directories and files the window may ask to reveal.
///
/// A closed enum, not a path: the page names a member and this side decides
/// what that member is, so there is no argument through which a reveal could
/// be pointed anywhere else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OpenTarget {
    /// `~/.config/subshell`.
    ConfigDir,
    /// The identity/state directory this node was enrolled with.
    DataDir,
    /// The agent's own log file, where the platform has one.
    NodeLog,
}

/// Resolve one target to a path, or explain why there is none.
pub fn resolve_open_target(target: OpenTarget, paths: &NodePaths) -> Result<String, String> {
    match target {
        OpenTarget::ConfigDir => paths
            .config_dir
            .clone()
            .ok_or_else(|| "this account has no home directory".to_string()),
        OpenTarget::DataDir => paths
            .data_dir
            .clone()
            .ok_or_else(|| "this machine has no data directory yet; it is created when the node enrolls".to_string()),
        OpenTarget::NodeLog => paths
            .node_log
            .clone()
            .ok_or_else(|| paths.node_log_hint.clone().unwrap_or_else(|| NO_LOG_FILE.to_string())),
    }
}

/// Who made this, under what terms, and where to read more.
///
/// The same payload Subshell Server's console reads, from the same shared
/// constants (`desktop_core::legal`), because the two apps must not disagree
/// about who owns the product. macOS already has an About box in the app menu
/// (`menu.rs`), built from those constants too — this is the surface Linux has
/// no menu bar for, and the one a person finds without knowing the platform's
/// conventions.
///
/// The version is this APP's own, from its bundle. The agent CLI's version is
/// a different program's and comes from the probe.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct About {
    /// The product family, e.g. `Subshell`.
    pub product_name: String,
    /// THIS app as a person installed it, e.g. `Subshell Client`.
    pub app_name: String,
    /// This desktop app's version, from `tauri.conf.json`.
    pub app_version: String,
    /// `Copyright <year> <holder>`, rendered.
    pub copyright: String,
    /// The entity that owns the copyright — the registered name, not the DBA.
    pub company: String,
    /// Which half is under which licence, in one line.
    pub license_summary: String,
    /// The three addresses, for DISPLAY only — opening one goes through
    /// [`node_open_web`], which holds its own copies.
    pub website_url: String,
    pub license_url: String,
    pub company_url: String,
}

#[tauri::command(async)]
pub fn node_about(app: AppHandle) -> About {
    About {
        product_name: legal::PRODUCT_NAME.to_string(),
        // The bundle's productName, not `package_info().name` — that is the
        // CRATE (`subshell-desktop-client`), while this is the label on the
        // window, the menu bar and the installed app.
        app_name: app
            .config()
            .product_name
            .clone()
            .unwrap_or_else(|| legal::PRODUCT_NAME.to_string()),
        app_version: app.package_info().version.to_string(),
        copyright: legal::COPYRIGHT_LINE.to_string(),
        company: legal::COPYRIGHT_HOLDER.to_string(),
        license_summary: legal::LICENSE_SUMMARY.to_string(),
        website_url: legal::PRODUCT_URL.to_string(),
        license_url: legal::LICENSE_URL.to_string(),
        company_url: legal::COMPANY_URL.to_string(),
    }
}

/// The pages the About footer may open in the system browser.
///
/// A closed enum for the same reason [`OpenTarget`] is one: the page names a
/// member and this side decides what that member IS, so no URL crosses the
/// boundary. That the same strings are also SENT to the page for display does
/// not weaken it — display and navigation are different capabilities.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WebTarget {
    /// The product's own site.
    Website,
    /// The repository's LICENSE, i.e. the full terms.
    License,
    /// The copyright holder's site.
    Company,
    /// Homebrew, offered on the tmux screen when this Mac has no package manager.
    Homebrew,
    /// MacPorts, the other way out of that same screen.
    ///
    /// Renamed explicitly: `rename_all = "kebab-case"` would put `mac-ports`
    /// on the wire, which is not how the project spells itself and is not what
    /// the page sends. The sibling app shipped exactly that — the page sent
    /// `macports`, the command answered with a serde error, and no type check
    /// could see it (measured 2026-09-14). `wire-names.test.ts` is what holds
    /// it shut here.
    #[serde(rename = "macports")]
    MacPorts,
}

/// Where the tmux screen sends someone whose Mac has no package manager at
/// all. Constants here rather than arguments from the page, for the same
/// reason every other member of this set is one. The same two addresses
/// `apps/server/desktop` carries; neither app ever shows the line that
/// installs the manager itself.
const HOMEBREW_URL: &str = "https://brew.sh";
const MACPORTS_URL: &str = "https://www.macports.org/install.php";

/// Open one of a fixed set of pages in the system browser: the three About
/// links, and the two package managers the tmux screen names.
///
/// The bundle's CSP makes an ordinary `<a href>` open inside the webview,
/// which is the wrong window for a website — and this app's other window is a
/// control plane's UI, which must never be navigated somewhere else.
#[tauri::command(async)]
pub fn node_open_web(app: AppHandle, target: WebTarget) -> Result<(), String> {
    let url = match target {
        WebTarget::Website => legal::PRODUCT_URL,
        WebTarget::License => legal::LICENSE_URL,
        WebTarget::Company => legal::COMPANY_URL,
        WebTarget::Homebrew => HOMEBREW_URL,
        WebTarget::MacPorts => MACPORTS_URL,
    };
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("could not open {url}: {e}"))
}

/// The screen this window was opened for, taken exactly once.
///
/// A PULL, for the reason `apps/server/desktop`'s twin documents: a push
/// emitted while the window is still loading reaches a page whose `listen()`
/// has not registered yet, and Tauri queues nothing. Asking cannot race —
/// whenever the page is ready to act on an answer, it asks for one.
#[tauri::command(async)]
pub fn node_pending_screen(app: AppHandle) -> Option<String> {
    // Asking is the proof. Until a page has done it once, `show_node_screen`
    // has no evidence that an emit would reach anything, so this call is what
    // arms the live-window path for every later request.
    crate::windows::mark_page_listening(&app);
    crate::windows::take_pending_screen(&app)
}

/// Ask the release source whether a newer **Subshell Client app** exists.
///
/// Read-only and node-window-only. Read-only because it fetches one JSON list
/// and asks the updater plugin to verify one manifest; node-window-only for
/// the same reason every other `node_*` command is — the plane's window is a
/// control plane's own page, and it holds one command that opens a browser.
#[tauri::command(async)]
pub async fn node_check_app_update(app: AppHandle) -> Result<crate::app_update::AppUpdateCheck, String> {
    crate::app_update::check_app_update(&app).await
}

/// Download, verify, install and relaunch into the newest app.
///
/// **Takes ONE bool and names no location.** The version to install is
/// re-resolved here rather than carried back from the page — the same shape
/// every other command in this file keeps: the page names an intent, never a
/// path, a URL or a host. `install_node` is the § 13 selection, and it is a
/// bool for exactly the reason the whole argument list is pinned by test: a
/// `String` here would be the parameter that pin exists to catch.
///
/// It carries the agent row's checkbox across the relaunch by deciding whether
/// a marker is written AT ALL — the same mechanism Subshell Server uses, added
/// here in review (2026-09-18) because this app's screen had no way to decline
/// the agent half while the app half ran, and recorded that as a structural
/// fact rather than as this command taking no argument.
///
/// It does not return on success: `app.restart()` is `-> !`.
#[tauri::command(async)]
pub async fn node_install_app_update(app: AppHandle, install_node: bool) -> Result<(), String> {
    crate::app_update::install_app_update(&app, install_node).await
}

/// Reveal one of a fixed set of the app's own directories or files.
#[tauri::command(async)]
pub fn node_open_path(app: AppHandle, target: OpenTarget) -> Result<(), String> {
    let paths = node_paths(&read_node_config());
    let path = resolve_open_target(target, &paths)?;
    if !Path::new(&path).exists() {
        return Err(format!("{path} does not exist yet"));
    }
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| format!("could not reveal {path}: {e}"))
}

/// Longest log tail the assistant renders. The server console's number, kept
/// identical so the two panes describe a log the same size: enough to cover a
/// boot and a restart, small enough that the pane stays a pane rather than a
/// transcript.
const LOG_TAIL_LINES: usize = 200;

/// A tail of the node's own log, for the Status section's log pane.
///
/// The server app's `LogTail`, same shape same meaning: an empty tail with a
/// note is the ordinary state of a machine whose node has never run, not an
/// error, and the pane renders it as its own caption.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogTail {
    /// The lines, oldest first, ready to render.
    pub text: String,
    /// Where these came from, in words, for the pane to caption itself.
    pub source: String,
    /// Why the tail is empty, when it is. `None` when there is text.
    pub note: Option<String>,
}

/// The last [`LOG_TAIL_LINES`] lines of the node's own capped log file.
///
/// **Takes no argument**, deliberately, exactly as `desktop_logs` and
/// `node_open_path` do: a path parameter would be an arbitrary-file-read
/// reachable from the page. This side decides what "the node's log" is — the
/// same ladder `probe.paths` reports (`node_log_paths`: the agent's own
/// bounded JSON-lines file first, on every platform), re-read from disk at
/// call time so the pane follows the file the facts row names.
///
/// Never an `Err`: every outcome is a caption the pane can render, because a
/// log that does not exist yet during a first run is normal, and an error
/// banner for it would train the user to ignore the pane. The `journalctl`
/// sentence the CLI owns (`node_log_hint`) is the note when there is no file
/// to read at all.
#[tauri::command(async)]
pub fn node_logs() -> LogTail {
    let paths = node_paths(&read_node_config());
    let Some(path) = paths.node_log else {
        return LogTail {
            text: String::new(),
            source: "the node's log".into(),
            note: Some(paths.node_log_hint.unwrap_or_else(|| NO_LOG_FILE.to_string())),
        };
    };
    match std::fs::read_to_string(&path) {
        Ok(body) => log_tail_from(&body, path),
        Err(e) => LogTail {
            text: String::new(),
            source: path,
            note: Some(format!("could not be read: {e}")),
        },
    }
}

/// The last lines of a log body, each JSON-lines entry rendered for the pane.
///
/// Split from [`node_logs`] so the interesting half — the cap, the blank-line
/// skip, the render — is tested without a filesystem in a particular state.
fn log_tail_from(body: &str, source: String) -> LogTail {
    let lines: Vec<&str> = body.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        return LogTail {
            text: String::new(),
            source,
            note: Some("nothing has been written yet".into()),
        };
    }
    LogTail {
        text: lines[lines.len().saturating_sub(LOG_TAIL_LINES)..]
            .iter()
            .map(|line| render_log_line(line))
            .collect::<Vec<_>>()
            .join("\n"),
        source,
        note: None,
    }
}

/// One JSON-lines entry as `HH:MM:SS level message`.
///
/// The server console's `render_log_line`, copied because the two CLIs' capped
/// writers emit the same shape (`timestamp`/`level`/`message` —
/// `apps/node/agent/src/log-file.ts` is itself the documented copy). A line
/// that will not parse is returned VERBATIM: the file is capped and replaced
/// when full, so the first line after a replacement can be a partial write,
/// and a half-written line is still the most recent thing the node said.
fn render_log_line(line: &str) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return line.to_string();
    };
    let str_of = |key: &str| value.get(key).and_then(|v| v.as_str()).unwrap_or_default();
    let time = str_of("timestamp")
        .split_once('T')
        .map(|(_, t)| t.get(..8).unwrap_or(t).to_string())
        .unwrap_or_default();
    let level = str_of("level");
    let message = str_of("message");
    [time.as_str(), level, message]
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod command_set_tests {
    use super::*;

    fn every_command() -> Vec<NodeCommand> {
        let mut out = vec![NodeCommand::Status, NodeCommand::ServiceStatus];
        for verb in [
            ServiceCommand::Install,
            ServiceCommand::Uninstall,
            ServiceCommand::Start,
            ServiceCommand::Stop,
            ServiceCommand::Restart,
            ServiceCommand::Autostart,
        ] {
            for force in [false, true] {
                out.push(NodeCommand::Service {
                    verb,
                    force,
                    autostart: true,
                });
            }
        }
        out.push(NodeCommand::Enroll {
            server: "https://subshell.example.com".into(),
            key: "nsk_0123456789012345678901234567890a".into(),
            name: "workstation".into(),
        });
        out
    }

    // Hazard, measured: the control plane's node registry is newest-wins, so a
    // probe supersede-kicks whatever agent holds the socket — including one on
    // another machine for the same node. Not on a timer, not behind a button.
    #[test]
    fn nothing_this_app_runs_can_pass_probe() {
        for command in every_command() {
            assert!(
                !command.args().iter().any(|a| a == "--probe"),
                "{command:?} would dial the control plane"
            );
        }
    }

    // `run` never resolves and competes with the installed service for one
    // node (both restart on exit, so the pair flaps); `mcp` is per-pane
    // plumbing that only a launch's environment can configure.
    #[test]
    fn the_verb_slot_is_a_closed_set() {
        const ALLOWED: [&str; 4] = ["status", "service", "enroll", "version"];
        for command in every_command() {
            let args = command.args();
            assert!(
                ALLOWED.contains(&args[0].as_str()),
                "{command:?} invokes an unlisted subcommand: {}",
                args[0]
            );
        }
    }

    #[test]
    fn reads_ask_for_json() {
        assert_eq!(NodeCommand::Status.args(), ["status", "--json"]);
        assert_eq!(NodeCommand::ServiceStatus.args(), ["service", "status", "--json"]);
    }

    // The CLI refuses `--force` anywhere but `restart`, so a stop that carried
    // it would die as a usage error instead of stopping anything.
    #[test]
    fn force_only_reaches_restart() {
        for verb in [
            ServiceCommand::Install,
            ServiceCommand::Uninstall,
            ServiceCommand::Start,
            ServiceCommand::Stop,
        ] {
            let args = NodeCommand::Service {
                verb,
                force: true,
                autostart: true,
            }
            .args();
            assert!(!args.iter().any(|a| a == "--force"), "{verb:?} kept --force: {args:?}");
        }
        assert_eq!(
            NodeCommand::Service {
                verb: ServiceCommand::Restart,
                force: true,
                autostart: true
            }
            .args(),
            ["service", "restart", "--force"]
        );
        assert_eq!(
            NodeCommand::Service {
                verb: ServiceCommand::Restart,
                force: false,
                autostart: true
            }
            .args(),
            ["service", "restart"]
        );
    }

    // `--no-autostart` is in the CLI's flag allowlist for `install` and nothing
    // else, so any other verb carrying it would die as a usage error — the
    // same failure `--force` has on the arm above, and the reason both are
    // qualifiers on one variant rather than free-floating flags. The
    // `autostart` VERB is the field's other home, and it spells its request
    // in the argument slot, never in a flag.
    #[test]
    fn no_autostart_only_reaches_install() {
        for verb in [
            ServiceCommand::Uninstall,
            ServiceCommand::Start,
            ServiceCommand::Stop,
            ServiceCommand::Restart,
        ] {
            let args = NodeCommand::Service {
                verb,
                force: false,
                autostart: false,
            }
            .args();
            assert!(
                !args.iter().any(|a| a == "--no-autostart"),
                "{verb:?} kept --no-autostart: {args:?}"
            );
        }
        assert_eq!(
            NodeCommand::Service {
                verb: ServiceCommand::Install,
                force: false,
                autostart: false
            }
            .args(),
            ["service", "install", "--no-autostart"]
        );
        // The default is armed: an install that says nothing about login start
        // must keep coming back at login, which is what every caller before
        // the start-up screen expected.
        assert_eq!(
            NodeCommand::Service {
                verb: ServiceCommand::Install,
                force: false,
                autostart: true
            }
            .args(),
            ["service", "install"]
        );
    }

    // The day-2 toggle is a two-word verb whose DIRECTION is its argument,
    // because that is how the CLI parses it (`service autostart on|off`). The
    // page's boolean and argv's word are one fact with two spellings; even a
    // stray `force` never rides along — it is restart's.
    #[test]
    fn autostart_verb_spells_its_direction_in_the_argument() {
        assert_eq!(
            NodeCommand::Service {
                verb: ServiceCommand::Autostart,
                force: false,
                autostart: true
            }
            .args(),
            ["service", "autostart", "on"]
        );
        assert_eq!(
            NodeCommand::Service {
                verb: ServiceCommand::Autostart,
                force: false,
                autostart: false
            }
            .args(),
            ["service", "autostart", "off"]
        );
        assert_eq!(
            NodeCommand::Service {
                verb: ServiceCommand::Autostart,
                force: true,
                autostart: true
            }
            .args(),
            ["service", "autostart", "on"]
        );
        // The wire word is the verb's lowercase spelling, same as its siblings.
        assert_eq!(
            serde_json::from_str::<ServiceCommand>("\"autostart\"").unwrap(),
            ServiceCommand::Autostart
        );
    }

    // The log pane's whole contract is a bounded, rendered tail over a file
    // this app re-locates itself; the pure half is testable without one.
    #[test]
    fn the_tail_caps_at_the_console_number_and_skips_blanks() {
        let body = (0..(LOG_TAIL_LINES + 50))
            .map(|i| format!("  \nline {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let tail = log_tail_from(&body, "/tmp/agent.log".into());
        let shown: Vec<&str> = tail.text.lines().collect();
        assert_eq!(shown.len(), LOG_TAIL_LINES);
        assert_eq!(shown[0], "line 50");
        assert_eq!(shown[shown.len() - 1], format!("line {}", LOG_TAIL_LINES + 49));
        assert_eq!(tail.source, "/tmp/agent.log");
        assert_eq!(tail.note, None);
    }

    #[test]
    fn an_empty_log_is_a_note_not_an_error() {
        let tail = log_tail_from("\n  \n\n", "/tmp/agent.log".into());
        assert_eq!(tail.text, "");
        assert_eq!(tail.note.as_deref(), Some("nothing has been written yet"));
    }

    #[test]
    fn json_lines_render_short_and_partial_lines_survive() {
        assert_eq!(
            render_log_line(r#"{"timestamp":"2026-09-22T10:11:12.345Z","level":"info","message":"node up"}"#),
            "10:11:12 info node up"
        );
        // The capped writer replaces the file when full, so a half-written
        // first line is data, not a parse failure to hide.
        assert_eq!(render_log_line(r#"{"timestamp":"2026-"#), r#"{"timestamp":"2026-"#);
    }

    #[test]
    fn enroll_always_carries_the_name() {
        // There is no nameless spelling to test: the variant cannot hold one, and
        // the CLI would refuse it as a usage error. This pins the argv a nameless
        // spawn used to produce — `enroll` without `--name` — is impossible.
        let args = NodeCommand::Enroll {
            server: "https://x.example".into(),
            key: "nsk_k".into(),
            name: "box".into(),
        }
        .args();
        assert_eq!(
            args,
            [
                "enroll",
                "--server",
                "https://x.example",
                "--key",
                "nsk_k",
                "--name",
                "box",
                "--json"
            ]
        );
    }

    // A read must never wait 90 seconds, and an enroll must never be killed at
    // 15 — the CLI's own network deadline is 30.
    #[test]
    fn deadlines_match_what_each_invocation_does() {
        assert_eq!(NodeCommand::Status.timeout(), QUERY_TIMEOUT);
        assert_eq!(NodeCommand::ServiceStatus.timeout(), QUERY_TIMEOUT);
        assert_eq!(
            NodeCommand::Enroll {
                server: "https://x.example".into(),
                key: "nsk_k".into(),
                name: "box".into(),
            }
            .timeout(),
            ACTION_TIMEOUT
        );
        assert!(ACTION_TIMEOUT > Duration::from_secs(30));
    }

    #[test]
    fn unenroll_spells_its_flags_and_takes_the_action_deadline() {
        // The page cannot soften either refusal: `--yes` (accept orphaning,
        // never kill) and `--json` are in the variant, not arguments.
        assert_eq!(NodeCommand::Unenroll.args(), ["unenroll", "--yes", "--json"]);
        assert_eq!(NodeCommand::Unenroll.timeout(), ACTION_TIMEOUT);
    }

    #[test]
    fn the_node_prefix_comes_first() {
        let node_binary = NodeBinary {
            argv: vec!["/bin/bun".into(), "/repo/main.ts".into()],
            source: crate::node_bin::NodeSource::Service,
            version: Some("1.9.0".into()),
        };
        assert_eq!(
            node_cmd(Some(&node_binary), &NodeCommand::Status).unwrap(),
            ["/bin/bun", "/repo/main.ts", "status", "--json"]
        );
        assert!(node_cmd(None, &NodeCommand::Status).is_none());
    }
}

/// The marker's own half of the probe (spec 2026-09-18 § 5).
///
/// `desktop_core::pending_install` owns and tests the DECISION; what belongs
/// here is the mapping onto what the page is told, because the two halves
/// this app leaves out of it are decisions in their own right: `forced` never
/// crosses, since phase 2 restarts nothing here, and a spent marker is
/// reported as `halted` rather than withheld, so the screen can still
/// offer Retry.
#[cfg(test)]
mod resume_tests {
    use super::*;
    // Production code no longer names this: the guard lives inside
    // `resume_decision` (review M17/N4). The tests still assert it directly,
    // because "a nameless marker is not an act" is the rule they pin.
    use subshell_desktop_core::pending_install::names_an_act;

    fn marker(attempts: u32) -> PendingBundledInstall {
        PendingBundledInstall {
            from_app_version: "0.6.0".into(),
            started_at: "2026-09-18T12:00:00Z".into(),
            attempts,
            forced: true,
        }
    }

    /// The refusal phase 1 renders must survive the relaunch (spec
    /// 2026-09-18 § 6; found in review, and fixed identically in the server
    /// app).
    ///
    /// `resume_decision` was fed the RAW installed version while `decide()`
    /// fed it a managed-aware one, so a machine whose service names an agent
    /// outside `~/.local/bin` was told the agent is left alone and then had it
    /// installed anyway at the next boot.
    #[test]
    fn an_unmanaged_machine_has_no_second_half_to_resume() {
        let p = Probe {
            bundled_version: Some("1.10.0".into()),
            node_binary: Some(NodeBinary {
                argv: vec!["/usr/local/bin/subshell".into()],
                source: node_bin::NodeSource::Service,
                version: Some("1.8.0".into()),
            }),
            managed: false,
            ..Default::default()
        };
        // The bundle really IS newer; the raw comparison would say "work".
        assert_eq!(p.comparable_node_version(), Some("1.10.0"));
        assert_eq!(
            resume_decision(
                Some(&marker(0)),
                p.bundled_version.as_deref(),
                p.comparable_node_version()
            ),
            Some(Resume::Clear)
        );
    }

    /// And the managed machine still resumes.
    #[test]
    fn a_managed_machine_still_has_its_second_half() {
        let p = Probe {
            bundled_version: Some("1.10.0".into()),
            node_binary: Some(NodeBinary {
                argv: vec!["/home/u/.local/bin/subshell".into()],
                source: node_bin::NodeSource::LocalBin,
                version: Some("1.8.0".into()),
            }),
            managed: true,
            ..Default::default()
        };
        assert_eq!(p.comparable_node_version(), Some("1.8.0"));
        assert_eq!(
            resume_decision(
                Some(&marker(0)),
                p.bundled_version.as_deref(),
                p.comparable_node_version()
            ),
            Some(Resume::Install { forced: true })
        );
    }

    #[test]
    fn an_install_reaches_the_page_as_work_still_to_do() {
        let m = marker(0);
        let view = view_of(&m, &Resume::Install { forced: true }).expect("a view");
        assert_eq!(view.from_app_version, "0.6.0");
        assert_eq!(view.attempts, 0);
        assert!(!view.halted);
    }

    /// Halting must still REPORT: the marker stays so the screen can name the
    /// update and offer Retry, and only the automatic firing stops.
    #[test]
    fn halting_is_reported_rather_than_hidden() {
        let m = marker(2);
        let view = view_of(&m, &Resume::Halt).expect("a view");
        assert_eq!(view.attempts, 2);
        assert!(view.halted);
    }

    /// A marker that names no app version is a corrupt file, not an act — and
    /// it reaches this app as a `Clear`, which is what DROPS it.
    ///
    /// Asserted through `resume_decision` rather than `names_an_act` alone,
    /// because the guard moved into the crate and the thing worth pinning here
    /// is the answer this app acts on. The local early return that used to sit
    /// in `resume_view` returned before the clear, so a nameless marker was
    /// hidden forever rather than dropped (review N4).
    #[test]
    fn a_marker_naming_no_version_is_cleared_rather_than_hidden() {
        assert!(names_an_act(&marker(0)));
        let mut blank = marker(0);
        blank.from_app_version = String::new();
        assert!(!names_an_act(&blank));
        assert_eq!(
            resume_decision(Some(&blank), Some("1.10.0"), Some("1.8.0")),
            Some(Resume::Clear)
        );
        assert_eq!(view_of(&blank, &Resume::Clear), None);
        // Whitespace too: `serde(default)` is one way to get here and a hand
        // edit is the other, and a space is what a hand edit leaves.
        blank.from_app_version = "  ".into();
        assert!(!names_an_act(&blank));
    }

    #[test]
    fn a_spent_marker_tells_the_page_nothing() {
        assert_eq!(view_of(&marker(0), &Resume::Clear), None);
    }

    /// The pane-safety consent is the server app's field, and carrying it
    /// here would be consent to a restart this app never performs.
    #[test]
    fn the_phase_one_force_does_not_cross_into_this_app() {
        let m = marker(0);
        let json = serde_json::to_string(&view_of(&m, &Resume::Install { forced: true }).unwrap()).unwrap();
        assert!(!json.contains("forced"), "{json}");
    }
}

#[cfg(test)]
mod probe_tests {
    use super::*;
    use serde_json::json;

    fn node_binary() -> NodeBinary {
        NodeBinary {
            argv: vec!["/home/u/.local/bin/subshell".into()],
            source: crate::node_bin::NodeSource::LocalBin,
            version: Some("1.9.0".into()),
        }
    }

    fn probe_with(status: Option<serde_json::Value>, service: Option<serde_json::Value>, has_node: bool) -> Probe {
        let mut p = Probe {
            bundled_version: Some("1.9.0".into()),
            node_binary: has_node.then(node_binary),
            managed: true,
            status,
            service,
            ..Default::default()
        };
        p.decide();
        p
    }

    fn enrolled(online: bool) -> serde_json::Value {
        json!({"nodeId": "11111111-2222-3333-4444-555555555555", "serverUrl": "https://x.example", "online": online, "agentVersion": "1.9.0"})
    }

    fn unenrolled() -> serde_json::Value {
        json!({"nodeId": null, "serverUrl": null, "online": false, "agentVersion": "1.9.0", "reason": "no config at /home/u/.config/subshell/config.json"})
    }

    fn service(installed: bool, state: &str) -> serde_json::Value {
        json!({"installed": installed, "definitionPath": "/home/u/.config/systemd/user/subshell.service", "state": state, "pid": 42, "enabled": true, "paneSafety": "keeps", "detail": ""})
    }

    #[test]
    fn with_no_node_the_first_step_is_getting_one() {
        assert_eq!(probe_with(None, None, false).step, ProbeStep::NoNode);
    }

    // The dangerous one: `enroll` overwrites config.json, mints a second node
    // row and throws away the node key. A binary that ran `version` but whose
    // `status` failed must never route there.
    #[test]
    fn a_node_that_did_not_answer_is_never_the_enroll_step() {
        let p = probe_with(None, Some(service(true, "running")), true);
        assert_eq!(p.step, ProbeStep::NoNode);
        assert_ne!(p.step, ProbeStep::NotEnrolled);
    }

    #[test]
    fn a_machine_with_no_config_needs_enrolling() {
        assert_eq!(
            probe_with(Some(unenrolled()), Some(service(false, "not-installed")), true).step,
            ProbeStep::NotEnrolled
        );
    }

    #[test]
    fn an_enrolled_machine_with_no_service_offers_the_install() {
        assert_eq!(
            probe_with(Some(enrolled(false)), Some(service(false, "not-installed")), true).step,
            ProbeStep::NoService
        );
    }

    // `service status --json` always exits 0, so a null body means the binary
    // itself misbehaved — offer the install rather than claiming a state.
    #[test]
    fn a_service_status_that_did_not_answer_is_not_installed() {
        assert_eq!(probe_with(Some(enrolled(false)), None, true).step, ProbeStep::NoService);
    }

    #[test]
    fn an_installed_but_stopped_service_offers_start() {
        assert_eq!(
            probe_with(Some(enrolled(false)), Some(service(true, "stopped")), true).step,
            ProbeStep::Stopped
        );
    }

    // Mid-teardown and unknown are both "not running", and Start is the right
    // offer for both.
    #[test]
    fn stopping_and_unknown_are_not_running() {
        for state in ["stopping", "unknown", "not-installed"] {
            assert_eq!(
                probe_with(Some(enrolled(true)), Some(service(true, state)), true).step,
                ProbeStep::Stopped,
                "{state}"
            );
        }
    }

    // The manager saying it started something only means a process was
    // launched. A crash-looping agent inside RestartSec is `running` with no
    // daemon lock, and calling that Online would be a green light over a
    // machine that runs nothing.
    #[test]
    fn a_running_unit_with_no_heartbeat_is_offline() {
        assert_eq!(
            probe_with(Some(enrolled(false)), Some(service(true, "running")), true).step,
            ProbeStep::Offline
        );
    }

    #[test]
    fn a_running_unit_with_a_live_daemon_is_online() {
        assert_eq!(
            probe_with(Some(enrolled(true)), Some(service(true, "running")), true).step,
            ProbeStep::Online
        );
    }

    // Installing to ~/.local/bin cannot change what a service pointing
    // somewhere else runs, so offering the upgrade would repeat forever.
    #[test]
    fn no_upgrade_is_offered_for_a_node_this_app_does_not_manage() {
        let mut p = Probe {
            bundled_version: Some("2.0.0".into()),
            node_binary: Some(NodeBinary {
                argv: vec!["/usr/local/bin/subshell".into()],
                source: crate::node_bin::NodeSource::Service,
                version: Some("1.9.0".into()),
            }),
            managed: false,
            ..Default::default()
        };
        p.decide();
        assert_eq!(p.node_choice, NodeChoice::UpToDate);
    }

    #[test]
    fn an_upgrade_is_offered_for_the_managed_copy() {
        let mut p = Probe {
            bundled_version: Some("2.0.0".into()),
            node_binary: Some(node_binary()),
            managed: true,
            ..Default::default()
        };
        p.decide();
        assert_eq!(p.node_choice, NodeChoice::UpgradeAvailable);
    }

    #[test]
    fn nothing_installed_and_something_bundled_is_an_install() {
        let mut p = Probe {
            bundled_version: Some("1.9.0".into()),
            ..Default::default()
        };
        p.decide();
        assert_eq!(p.node_choice, NodeChoice::InstallBundled);
        assert_eq!(p.step, ProbeStep::NoNode);
    }

    // Hazard, measured: `subshell status` exits 1 whenever the node is
    // offline, and offline is an ANSWER. Gating the parse on the exit code
    // would report every stopped node as having a broken binary.
    #[test]
    fn a_nonzero_exit_with_a_body_is_still_an_answer() {
        let out = Run {
            code: Some(1),
            stdout: serde_json::to_string(&unenrolled()).unwrap(),
            stderr: String::new(),
            timed_out: false,
        };
        assert!(json_of(&out).is_some());
    }

    #[test]
    fn a_body_that_is_not_json_is_no_answer() {
        let out = Run {
            code: Some(1),
            stdout: "subshell: no config at /home/u/.config/subshell/config.json".into(),
            stderr: String::new(),
            timed_out: false,
        };
        assert!(json_of(&out).is_none());
    }

    #[test]
    fn steps_serialize_as_kebab_case_for_the_page() {
        assert_eq!(serde_json::to_string(&ProbeStep::NoNode).unwrap(), "\"no-node\"");
        assert_eq!(
            serde_json::to_string(&ProbeStep::NotEnrolled).unwrap(),
            "\"not-enrolled\""
        );
        assert_eq!(serde_json::to_string(&ProbeStep::NoService).unwrap(), "\"no-service\"");
        assert_eq!(serde_json::to_string(&ProbeStep::Stopped).unwrap(), "\"stopped\"");
        assert_eq!(serde_json::to_string(&ProbeStep::Offline).unwrap(), "\"offline\"");
        assert_eq!(serde_json::to_string(&ProbeStep::Online).unwrap(), "\"online\"");
    }

    #[test]
    fn the_probe_serializes_the_names_the_page_reads() {
        let p = probe_with(Some(enrolled(true)), Some(service(true, "running")), true);
        let v = serde_json::to_value(&p).unwrap();
        for key in [
            "bundledVersion",
            "nodeBinary",
            "managed",
            "status",
            "service",
            "nodeChoice",
            "step",
            "error",
            "tmux",
            "hasBrew",
            "paths",
            "rewriteTearsDown",
        ] {
            assert!(v.get(key).is_some(), "missing {key} in {v}");
        }
    }
}

#[cfg(test)]
mod install_policy_tests {
    use super::*;

    // The replace path hands the STAGED sidecar to the INSTALLED agent, and
    // the flags come from the shared contract rather than from here. A flag
    // spelled locally is how the two apps come to ask their CLIs for different
    // things — and `--no-restart` going missing is the one that would start
    // restarting a daemon this command has deliberately never restarted.
    #[test]
    fn the_delegated_argv_is_the_installed_binary_plus_the_shared_flags() {
        let node_binary = NodeBinary {
            argv: vec!["/home/u/.local/bin/subshell".into()],
            source: crate::node_bin::NodeSource::LocalBin,
            version: Some("0.8.0".into()),
        };
        let staged = PathBuf::from("/Applications/Subshell Client.app/Contents/MacOS/subshell-node-bundled");
        let argv = update_argv(Some(&node_binary), &staged).expect("an argv");
        assert_eq!(argv.first().map(String::as_str), Some("/home/u/.local/bin/subshell"));
        assert_eq!(&argv[1..], &cli_update::update_args(&staged)[..]);
        assert!(argv.contains(&"--no-restart".to_string()));
        assert!(argv.contains(&"--yes".to_string()));
        assert!(argv.contains(&"--json".to_string()));
    }

    // Nothing resolved means nothing to run `update` — the caller answers with
    // a refusal rather than spawning `update` as a bare word on the PATH.
    #[test]
    fn nothing_resolved_builds_no_command() {
        assert!(update_argv(None, &PathBuf::from("/x")).is_none());
    }

    fn run_of(code: Option<i32>, stdout: &str, stderr: &str) -> Run {
        Run {
            code,
            stdout: stdout.into(),
            stderr: stderr.into(),
            timed_out: false,
        }
    }

    // Every `subshell` agent that existed on 2026-09-15 predates the `update`
    // verb (0.8.0 was cut before it was written), so WITHOUT this branch the
    // app's offer fails on exactly the upgrade it is there for. Transcribed
    // from `node-v0.8.0`'s own cli.ts, which routes usage errors through
    // `fail(2, UsageError)` — note the exit code is 2 here and 1 in the server
    // app, which is why the detection keys on the MARKER and not on a number.
    #[test]
    fn a_node_predating_the_verb_falls_back_to_the_plain_copy() {
        assert!(matches!(
            classify_update(run_of(Some(2), "", "unknown command 'update'\n")),
            AfterUpdate::Legacy
        ));
    }

    // The refusals that must NEVER fall back. Each is an answer ABOUT this
    // machine; copying the binary anyway would leave no `.previous` and report
    // success, which is the one outcome worse than a confusing error.
    #[test]
    fn a_real_refusal_is_reported_and_never_falls_back() {
        let refusal = "subshell: refusing to restart: this service definition would close every running subshell";
        let AfterUpdate::Reported(result) = classify_update(run_of(Some(1), "", refusal)) else {
            panic!("a pane-safety refusal must never reach the fallback");
        };
        assert!(!result.ok);
        // The CLI's own words survive verbatim — this layer re-words no
        // refusal, which is rule 1 of `use-node-commands.ts` read from the
        // other end.
        assert!(result.stderr.contains("refusing to restart"), "{}", result.stderr);

        for stderr in [
            "subshell: not a compiled agent",
            "subshell: installed binary reports 0.8.0, not 0.9.0",
        ] {
            assert!(
                matches!(classify_update(run_of(Some(1), "", stderr)), AfterUpdate::Reported(_)),
                "{stderr}"
            );
        }
    }

    // The sentence the fallback screen shows. It claims NO database — the
    // agent has none, and its own `update` takes no backup either, so naming
    // one would alarm about something that was never going to happen.
    #[test]
    fn the_fallback_says_no_rollback_and_never_mentions_a_database() {
        let said = cli_update::legacy_install_summary(
            Some("0.8.0"),
            Some("0.9.0"),
            "node CLI",
            cli_update::Unrecorded::Rollback,
        );
        assert!(said.contains("Installed 0.9.0 over 0.8.0."), "{said}");
        assert!(said.contains("No rollback point was recorded"), "{said}");
        assert!(said.contains("predates the update command"), "{said}");
        assert!(!said.contains("database"), "{said}");
    }

    // The invariant `node_bin` states in its own words: a newer installed
    // agent is ADOPTED, never overwritten. Nothing downstream enforces it —
    // `already_installed` compares versions for equality, not order — so an
    // older bundled binary would otherwise overwrite a newer installed one and
    // buy a node that enrolls, reports online and refuses every launch.
    #[test]
    fn a_newer_installed_node_is_never_overwritten() {
        let refusal = install_refusal(Some("1.9.0"), Some("2.0.0")).expect("a downgrade must be refused");
        assert!(refusal.contains("2.0.0"), "{refusal}");
        assert!(refusal.contains("1.9.0"), "{refusal}");
        assert!(refusal.contains("downgrade"), "{refusal}");
        // Numeric, not lexical — the comparison `decide_node` already owns.
        assert!(install_refusal(Some("1.9.0"), Some("1.10.0")).is_some());
    }

    // …and every other case installs. In particular "nothing installed", which
    // is the whole point of the button on a machine with no agent.
    #[test]
    fn every_other_case_may_install() {
        for (bundled, installed) in [
            (Some("2.0.0"), Some("1.9.0")), // an upgrade
            (Some("1.9.0"), Some("1.9.0")), // already the same
            (Some("1.9.0"), None),          // nothing installed
            (None, Some("2.0.0")),          // nothing to install
            (None, None),
        ] {
            assert_eq!(
                install_refusal(bundled, installed),
                None,
                "refused bundled={bundled:?} installed={installed:?}"
            );
        }
    }

    // The guard is deliberately WIDER than the upgrade offer. `node_choice`
    // is narrowed to the copy this app manages — an offer for an agent the
    // service does not run would change nothing and repeat forever — but
    // `~/.local/bin` outranks the login PATH and the well-known directories,
    // so writing an older binary there downgrades what this app drives even
    // when it never installed the newer one.
    #[test]
    fn a_node_this_app_does_not_manage_is_not_downgraded_either() {
        let mut p = Probe {
            bundled_version: Some("1.9.0".into()),
            node_binary: Some(NodeBinary {
                argv: vec!["/usr/local/bin/subshell".into()],
                source: crate::node_bin::NodeSource::WellKnown,
                version: Some("2.0.0".into()),
            }),
            managed: false,
            ..Default::default()
        };
        p.decide();
        // Nothing is OFFERED here…
        assert_eq!(p.node_choice, NodeChoice::UpToDate);
        // …and if the command is reached anyway, it still refuses.
        assert!(install_refusal(
            p.bundled_version.as_deref(),
            p.node_binary.as_ref().and_then(|a| a.version.as_deref())
        )
        .is_some());
    }

    #[test]
    fn output_blocks_never_run_together_or_leave_a_blank_gap() {
        assert_eq!(joined("a", "b"), "a\n\nb");
        assert_eq!(joined("", "b"), "b");
        assert_eq!(joined("a", ""), "a");
        assert_eq!(joined("  ", "\n"), "");
    }

    // The page decides whether to confirm the rewrite from this fact, and it
    // is a platform fact: launchd has no reload, so `service install` boots the
    // stale job out — which is what kills the panes the rewrite exists to
    // protect. systemd re-reads the unit under a running daemon.
    #[test]
    fn only_launchd_pays_for_rewriting_the_definition() {
        assert_eq!(Probe::default().rewrite_tears_down, cfg!(target_os = "macos"));
    }
}

#[cfg(test)]
mod action_result_tests {
    use super::*;

    // A failure with two empty streams is the one that reads as success in a
    // UI: a spawn error or a deadline leaves nothing to show.
    #[test]
    fn a_silent_failure_still_says_something() {
        let r = ActionResult::from(Run {
            code: None,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: true,
        });
        assert!(!r.ok);
        assert_eq!(r.stderr, "timed out");
    }

    #[test]
    fn the_clis_own_words_are_passed_through_untouched() {
        let stderr = "subshell: this setup key has already been used — each key enrolls one node; create a new setup key on the Nodes page\n";
        let r = ActionResult::from(Run {
            code: Some(1),
            stdout: String::new(),
            stderr: stderr.into(),
            timed_out: false,
        });
        assert!(!r.ok);
        assert_eq!(r.stderr, stderr);
    }

    #[test]
    fn a_zero_exit_is_ok() {
        let r = ActionResult::from(Run {
            code: Some(0),
            stdout: "subshell started.\n".into(),
            stderr: String::new(),
            timed_out: false,
        });
        assert!(r.ok);
        assert_eq!(r.stdout, "subshell started.\n");
    }
}

#[cfg(test)]
mod validation_tests {
    use super::*;

    #[test]
    fn a_full_url_survives_with_its_trailing_slashes_removed() {
        assert_eq!(
            validate_server_url("https://subshell.example.com").unwrap(),
            "https://subshell.example.com"
        );
        assert_eq!(
            validate_server_url("https://subshell.example.com/").unwrap(),
            "https://subshell.example.com"
        );
        assert_eq!(
            validate_server_url("  http://box.local:3080///  ").unwrap(),
            "http://box.local:3080"
        );
        assert_eq!(
            validate_server_url("https://x.example/subshell/").unwrap(),
            "https://x.example/subshell"
        );
    }

    /// The scheme is lower-cased, matching `normalizeServer` in
    /// `apps/node/agent/src/enroll.ts`.
    ///
    /// This value is what the page shows, what the saved plane list holds,
    /// and what is handed to `subshell configure --server`. The agent's
    /// `wsUrlFor` builds its dial URL by string-replacing the scheme, so a
    /// mixed-case one produced `HTTP://host/ws/node` — not a WebSocket URL.
    /// The agent now normalizes on write regardless, so this is the two
    /// spellings of "one normalization" agreeing rather than the only guard.
    #[test]
    fn a_mixed_case_scheme_is_lowercased_like_the_node_does() {
        assert_eq!(
            validate_server_url("HTTP://Box.Local:3080").unwrap(),
            "http://box.local:3080"
        );
        assert_eq!(
            validate_server_url("HTTPS://Subshell.Example").unwrap(),
            "https://subshell.example"
        );
    }

    /// The parser's normalized spelling IS what comes back — and this test
    /// used to assert the opposite.
    ///
    /// Its original reason was sound: "the CLI persists the string it was
    /// handed, so the two must agree". That premise inverted when
    /// `normalizeServer` (`apps/node/agent/src/enroll.ts`) started
    /// canonicalizing on write — it had to, because it returned a mixed-case
    /// scheme verbatim and the agent's `wsUrlFor` replaces the scheme with a
    /// case-sensitive match, so `HTTP://host` was dialed as
    /// `HTTP://host/ws/node`, which is not a WebSocket URL. With the CLI
    /// canonicalizing, AGREEMENT now requires canonicalizing here too:
    /// returning the raw spelling would make this app display and persist an
    /// address the CLI does not store.
    #[test]
    fn the_parsers_spelling_is_what_comes_back_because_the_cli_stores_that() {
        assert_eq!(
            validate_server_url("http://Box.Local:3080").unwrap(),
            "http://box.local:3080"
        );
    }

    #[test]
    fn a_bare_host_is_not_a_url() {
        assert!(validate_server_url("subshell.example.com").is_err());
        assert!(validate_server_url("").is_err());
        assert!(validate_server_url("   ").is_err());
        assert!(validate_server_url("not a url").is_err());
    }

    #[test]
    fn only_http_and_https_are_accepted() {
        assert!(validate_server_url("ftp://x.example").is_err());
        assert!(validate_server_url("ws://x.example").is_err());
        assert!(validate_server_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn a_well_formed_key_is_accepted_and_trimmed() {
        let key = "nsk_abcdefghijklmnopqrstuvwxyz012345";
        assert_eq!(key.len(), SETUP_KEY_PREFIX.len() + SETUP_KEY_BODY_LEN);
        assert_eq!(validate_setup_key(&format!("  {key}\n")).unwrap(), key);
        // base64url's whole alphabet, `-` and `_` included: rejecting either
        // would refuse roughly half of all real keys, at random.
        let url_safe = format!("{SETUP_KEY_PREFIX}{}", "-_".repeat(SETUP_KEY_BODY_LEN / 2));
        assert_eq!(validate_setup_key(&url_safe).unwrap(), url_safe);
    }

    #[test]
    fn a_malformed_key_is_refused_before_anything_is_spawned() {
        for bad in [
            "",
            "   ",
            "abc",
            "nsk_",
            "nsk_tooshort",
            "nsk_abcdefghijklmnopqrstuvwxyz0123456", // 33
            "nsk_abcdefghijklmnopqrstuvwxyz01234",   // 31
            "nsk_abcdefghijklmnopqrstuvwxyz01234!",  // bad char
            "NSK_abcdefghijklmnopqrstuvwxyz012345",  // wrong case prefix
            "subshell_abcdefghijklmnopqrstuvwxyz01",
        ] {
            assert!(validate_setup_key(bad).is_err(), "accepted {bad:?}");
        }
    }

    // A one-time credential must not end up in an error string, which is the
    // easiest thing in a UI to screenshot into an issue.
    #[test]
    fn a_refusal_never_echoes_the_key() {
        let key = "nsk_abcdefghijklmnopqrstuvwxyz01234!";
        let err = validate_setup_key(key).unwrap_err();
        assert!(!err.contains("abcdefghij"), "{err}");
        assert!(!err.contains(key), "{err}");
    }

    #[test]
    fn a_blank_name_is_refused_rather_than_defaulted() {
        // It used to answer `None`, which meant "spawn enroll with no --name and
        // let the CLI use the hostname". Both halves of that are gone: the CLI
        // requires the flag, and the app asks the person at the machine.
        assert!(validate_node_name("").is_err());
        assert!(validate_node_name("   ").is_err());
        assert!(validate_node_name("\t\n").is_err());
        assert_eq!(validate_node_name("  workstation  ").unwrap(), "workstation");
    }

    // The control plane's cap, pre-checked here because learning it from a 400
    // costs the setup key.
    #[test]
    fn a_name_longer_than_the_control_plane_accepts_is_refused() {
        assert!(validate_node_name(&"x".repeat(MAX_NODE_NAME_LEN)).is_ok());
        assert!(validate_node_name(&"x".repeat(MAX_NODE_NAME_LEN + 1)).is_err());
    }

    #[test]
    fn loopback_is_recognised_in_every_spelling_a_browser_produces() {
        for url in [
            "http://localhost:3080",
            "https://localhost",
            "http://127.0.0.1:3080",
            "http://127.1.2.3",
            "http://[::1]:3080",
            "http://0.0.0.0:3080",
        ] {
            assert!(is_loopback_server(url), "{url}");
        }
        for url in [
            "https://subshell.example.com",
            "http://box.local:3080",
            "http://10.0.0.4",
        ] {
            assert!(!is_loopback_server(url), "{url}");
        }
    }
}

#[cfg(test)]
mod confirmation_tests {
    use super::*;

    fn known(node_id: &str, server_url: Option<&str>) -> ExistingNode {
        ExistingNode::Known {
            node_id: node_id.into(),
            server_url: server_url.map(str::to_string),
        }
    }

    #[test]
    fn a_fresh_machine_pointed_at_a_real_server_asks_nothing() {
        assert!(confirmations_for("https://subshell.example.com", &ExistingNode::None).is_empty());
    }

    // Hazard: enroll has no already-enrolled guard. It overwrites config.json,
    // mints a SECOND node row, and discards the node key whose only home was
    // that file — so the confirmation has to NAME what is being replaced.
    #[test]
    fn an_enrolled_machine_is_named_in_the_confirmation() {
        let c = confirmations_for(
            "https://subshell.example.com",
            &known("node-abc", Some("https://old.example.com")),
        );
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].kind, ConfirmKind::AlreadyEnrolled);
        assert!(c[0].message.contains("node-abc"), "{}", c[0].message);
        // Re-enrolling against a DIFFERENT control plane is the case where
        // "already enrolled" is not obviously a mistake, so the old server is
        // named too.
        assert!(c[0].message.contains("https://old.example.com"), "{}", c[0].message);
        assert!(c[0].message.contains("SECOND node"), "{}", c[0].message);
    }

    // A config that will not parse still holds a node key, and reading it as
    // "not enrolled" is the one answer that waves the destructive step through.
    #[test]
    fn an_unreadable_config_still_stops_the_enroll() {
        let c = confirmations_for("https://subshell.example.com", &ExistingNode::Unreadable);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].kind, ConfirmKind::AlreadyEnrolled);
        assert!(c[0].message.contains("could not be read"), "{}", c[0].message);
    }

    // A config with no serverUrl reads as one sentence, not a dangling "on".
    #[test]
    fn a_config_without_a_server_still_reads_as_a_sentence() {
        let c = confirmations_for("https://subshell.example.com", &known("node-abc", None));
        assert!(c[0]
            .message
            .starts_with("This machine is already enrolled as node node-abc."));
    }

    #[test]
    fn a_loopback_server_is_flagged_on_its_own() {
        let c = confirmations_for("http://localhost:3080", &ExistingNode::None);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].kind, ConfirmKind::LoopbackServer);
        assert!(c[0].message.contains("http://localhost:3080"), "{}", c[0].message);
    }

    #[test]
    fn both_reasons_can_arrive_together() {
        let c = confirmations_for("http://127.0.0.1:3080", &known("node-abc", None));
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].kind, ConfirmKind::AlreadyEnrolled);
        assert_eq!(c[1].kind, ConfirmKind::LoopbackServer);
    }

    #[test]
    fn confirm_kinds_serialize_as_kebab_case() {
        assert_eq!(
            serde_json::to_string(&ConfirmKind::AlreadyEnrolled).unwrap(),
            "\"already-enrolled\""
        );
        assert_eq!(
            serde_json::to_string(&ConfirmKind::LoopbackServer).unwrap(),
            "\"loopback-server\""
        );
    }
}

#[cfg(test)]
mod config_facts_tests {
    use super::*;

    const KEY: &str = "sk_live_this_is_the_node_bearer_secret";

    fn config_text() -> String {
        serde_json::json!({
            "serverUrl": "https://subshell.example.com",
            "nodeId": "11111111-2222-3333-4444-555555555555",
            "nodeKey": KEY,
            "controlPublicKey": "{\"kty\":\"OKP\"}",
            "dataDir": "/home/u/.config/subshell/data",
            "name": "workstation"
        })
        .to_string()
    }

    #[test]
    fn reads_the_three_facts_it_needs() {
        let facts = parse_node_config(&config_text());
        assert_eq!(facts.node_id.as_deref(), Some("11111111-2222-3333-4444-555555555555"));
        assert_eq!(facts.server_url.as_deref(), Some("https://subshell.example.com"));
        assert_eq!(facts.data_dir.as_deref(), Some("/home/u/.config/subshell/data"));
    }

    // The node key is the reason that file is 0600, and the CLI will not print
    // it even under `--json`. Nothing here may carry it — including a Debug
    // line, which is where a secret reaches a log without anyone deciding to
    // put it there.
    #[test]
    fn the_node_key_never_leaves_the_file() {
        let facts = parse_node_config(&config_text());
        let shown = format!("{facts:?}");
        assert!(!shown.contains(KEY), "{shown}");
        assert!(!shown.contains("nodeKey"), "{shown}");
    }

    #[test]
    fn a_missing_or_corrupt_config_is_empty_not_an_error() {
        assert_eq!(parse_node_config(""), NodeConfigFacts::default());
        assert_eq!(parse_node_config("not json"), NodeConfigFacts::default());
        assert_eq!(parse_node_config("[]"), NodeConfigFacts::default());
        assert_eq!(parse_node_config("{}"), NodeConfigFacts::default());
        assert_eq!(parse_node_config(r#"{"nodeId": ""}"#), NodeConfigFacts::default());
        assert_eq!(parse_node_config(r#"{"nodeId": 7}"#), NodeConfigFacts::default());
    }
}

#[cfg(test)]
mod path_tests {
    use super::*;

    #[test]
    fn the_config_dir_is_the_clis_default_and_ignores_the_override() {
        let Some(dir) = config_dir() else { return };
        assert!(dir.ends_with(".config/subshell"), "{}", dir.display());
    }

    #[test]
    fn the_data_dir_falls_back_to_the_clis_own_default() {
        let paths = node_paths(&NodeConfigFacts::default());
        let Some(data) = paths.data_dir else { return };
        assert!(data.ends_with("/.config/subshell/data"), "{data}");
    }

    #[test]
    fn an_enrolled_data_dir_wins_over_the_default() {
        let paths = node_paths(&NodeConfigFacts {
            data_dir: Some("/srv/subshell-data".into()),
            ..Default::default()
        });
        assert_eq!(paths.data_dir.as_deref(), Some("/srv/subshell-data"));
    }

    // Exactly one of the two is ever set, whatever this machine happens to
    // have on disk: a path to reveal, or a sentence saying what to do instead.
    #[test]
    fn the_node_log_is_a_path_or_a_hint_never_both_and_never_neither() {
        let (path, hint) = node_log_paths();
        assert_ne!(path.is_some(), hint.is_some());
        match (path, hint) {
            (Some(p), None) => assert!(
                p.ends_with("/logs/agent.log") || p.ends_with("/Library/Logs/subshell.log"),
                "{p}"
            ),
            (None, Some(h)) => assert!(!h.is_empty()),
            other => panic!("neither or both: {other:?}"),
        }
    }

    // The agent's OWN capped file wins on every platform: it is the file the
    // plane's log view serves, so revealing anything else here would put the
    // desktop and the browser on two different documents.
    #[test]
    fn the_nodes_own_capped_log_wins_over_the_managers_copy() {
        let own = PathBuf::from("/home/u/.config/subshell/logs/agent.log");
        let (path, hint) = node_log_paths_from(
            Some(PathBuf::from("/home/u/.config/subshell")),
            Some(PathBuf::from("/home/u")),
            |_| true, // both have content
        );
        assert_eq!(path.as_deref(), Some(own.to_str().unwrap()));
        assert!(hint.is_none());
    }

    // The manager's redirect is the fallback rather than a duplicate: it holds
    // the stdout of an agent that died before opening its own file.
    #[test]
    fn the_managers_log_is_the_fallback_where_the_platform_keeps_one() {
        let own = PathBuf::from("/home/u/.config/subshell/logs/agent.log");
        let (path, hint) = node_log_paths_from(
            Some(PathBuf::from("/home/u/.config/subshell")),
            Some(PathBuf::from("/home/u")),
            |p| p != own, // the agent has written nothing of its own
        );
        if cfg!(target_os = "macos") {
            assert_eq!(path.as_deref(), Some("/home/u/Library/Logs/subshell.log"));
            assert!(hint.is_none());
        } else {
            // systemd redirects nothing, so there is no second file to fall to.
            assert!(path.is_none());
            assert_eq!(hint.as_deref(), Some(NO_LOG_FILE));
        }
    }

    // An empty file is not a log: the capped writer truncates to zero and
    // starts over, and the manager's copy may still hold what explains the
    // silence. Same rule as the server app's `server_log_tail`.
    #[test]
    fn nothing_with_content_anywhere_is_the_hint() {
        let (path, hint) = node_log_paths_from(
            Some(PathBuf::from("/home/u/.config/subshell")),
            Some(PathBuf::from("/home/u")),
            |_| false,
        );
        assert!(path.is_none());
        assert_eq!(hint.as_deref(), Some(NO_LOG_FILE));
    }

    // Both platforms name the agent's own file, because that is the one that
    // appears wherever it runs. What differs is the fallback each HAS: a
    // second file on macOS, the journal on Linux. Telling a Mac user to run
    // `journalctl` — or a Linux user to look for a file launchd would have
    // written — is worse than saying nothing.
    #[test]
    fn each_platform_is_told_the_right_reason_for_having_no_log_file() {
        assert!(
            NO_LOG_FILE.contains("~/.config/subshell/logs/agent.log"),
            "{NO_LOG_FILE}"
        );
        if cfg!(target_os = "macos") {
            assert!(NO_LOG_FILE.contains("~/Library/Logs/subshell.log"), "{NO_LOG_FILE}");
            assert!(!NO_LOG_FILE.contains("journalctl"), "{NO_LOG_FILE}");
        } else {
            assert!(
                NO_LOG_FILE.contains("journalctl --user -u subshell.service"),
                "{NO_LOG_FILE}"
            );
            assert!(!NO_LOG_FILE.contains("Library/Logs"), "{NO_LOG_FILE}");
        }
    }

    #[test]
    fn every_target_resolves_or_explains_itself() {
        let paths = node_paths(&NodeConfigFacts::default());
        for target in [OpenTarget::ConfigDir, OpenTarget::DataDir, OpenTarget::NodeLog] {
            match resolve_open_target(target, &paths) {
                Ok(p) => assert!(p.starts_with('/'), "{target:?} resolved to {p}"),
                Err(e) => assert!(!e.is_empty(), "{target:?} refused with nothing to say"),
            }
        }
    }

    // With no log file, the refusal has to BE the remedy rather than a shrug —
    // and the remedy is the hint the probe already handed the page.
    #[test]
    fn a_missing_log_file_answers_with_its_hint() {
        let paths = NodePaths {
            node_log: None,
            node_log_hint: Some("do this instead".into()),
            ..Default::default()
        };
        assert_eq!(
            resolve_open_target(OpenTarget::NodeLog, &paths).unwrap_err(),
            "do this instead"
        );
        // …and when even the hint is missing, with the platform's own reason
        // rather than an empty string.
        let bare = NodePaths::default();
        assert_eq!(
            resolve_open_target(OpenTarget::NodeLog, &bare).unwrap_err(),
            NO_LOG_FILE
        );
    }

    // The page names a member of this set and never a path, so the set has to
    // deserialize from exactly the spellings the page sends.
    #[test]
    fn targets_deserialize_from_kebab_case() {
        assert_eq!(
            serde_json::from_str::<OpenTarget>("\"config-dir\"").unwrap(),
            OpenTarget::ConfigDir
        );
        assert_eq!(
            serde_json::from_str::<OpenTarget>("\"data-dir\"").unwrap(),
            OpenTarget::DataDir
        );
        assert_eq!(
            serde_json::from_str::<OpenTarget>("\"node-log\"").unwrap(),
            OpenTarget::NodeLog
        );
        assert!(serde_json::from_str::<OpenTarget>("\"/etc/passwd\"").is_err());
    }

    fn stored(close_to_tray: bool) -> Settings {
        Settings {
            binary_path: None,
            close_to_tray,
            open_at_login: false,
            planes: Vec::new(),
            // The server app's wizard flag. Client ignores it; it shares the
            // struct, not the semantics.
            onboarded: false,
            // Read by the menus, never by the page — see the key-set test below.
            zoom: 1.0,
            // Read by the TRAY (the "Check for Updates…" label) and by the
            // launch check's own 24-hour gate, never by the page: the app
            // update is a screen a person asks for, not a fact on the probe.
            last_update_check_at: None,
            last_update_version: None,
            // The unfinished half of an update (spec 2026-09-18 § 5). Written
            // before the relaunch, read by the NEW build at boot; nothing
            // here has one.
            pending_bundled_install: None,
            // Subshell Server's own: who runs the control plane there. This
            // app has a node agent with its own service and no such mode, so
            // it shares the struct and ignores the field, exactly as the
            // server app ignores `planes`.
            supervision: subshell_desktop_core::settings::Supervision::Service,
        }
    }

    // The WHOLE key set, because the removal is the point: the tray trio left
    // with the switch it fed (spec 2026-09-12 § 6.4), and a field added back
    // here would be one the assistant has nowhere to draw. The clamp those
    // fields expressed is not lost — it lives in `close_to_tray_now`, which
    // the tray check item and the window-close handler both read, and
    // `effective_close_to_tray` carries its own tests in desktop-core.
    #[test]
    fn plane_add_canonicalizes_and_dedupes() {
        let list = vec!["https://one.example".to_string()];
        let next = plane_list_add(&list, " HTTPS://Two.Example/ ", None).unwrap();
        assert_eq!(next, ["https://one.example", "https://two.example"]);
        // A stored spelling that canonicalizes equal is not a second plane.
        assert_eq!(plane_list_add(&next, "https://two.example///", None).unwrap(), next);
    }

    #[test]
    fn plane_add_refuses_the_nodes_own_address_and_reaches_without_a_node() {
        let own = "https://plane.example";
        let err = plane_list_add(&[], "https://plane.example/", Some(own)).unwrap_err();
        assert!(err.contains("already reports to"), "{err}");
        // No enrolled node, no own address to collide with — a plain watcher
        // stores the plane it watches like any other.
        assert_eq!(plane_list_add(&[], own, None).unwrap(), [own]);
    }

    #[test]
    fn plane_remove_matches_canonically_refuses_a_stranger_and_keeps_the_unreadable() {
        let list = vec!["https://one.example".to_string(), "nonsense".to_string()];
        assert_eq!(plane_list_remove(&list, "HTTPS://One.Example").unwrap(), ["nonsense"]);
        // The page can only name a row it renders; a miss is a stale list,
        // said as an error rather than a success that leaves the row.
        assert!(plane_list_remove(&list, "https://absent.example").is_err());
    }

    #[test]
    fn the_payload_is_the_two_fields_the_assistant_reads() {
        let json = serde_json::to_value(settings_view(stored(true))).unwrap();
        let mut keys: Vec<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["nodeBinPath", "planes"]);
    }

    #[test]
    fn service_verbs_deserialize_from_the_names_the_cli_uses() {
        for (json, verb) in [
            ("\"install\"", ServiceCommand::Install),
            ("\"uninstall\"", ServiceCommand::Uninstall),
            ("\"start\"", ServiceCommand::Start),
            ("\"stop\"", ServiceCommand::Stop),
            ("\"restart\"", ServiceCommand::Restart),
        ] {
            assert_eq!(serde_json::from_str::<ServiceCommand>(json).unwrap(), verb);
        }
        assert!(serde_json::from_str::<ServiceCommand>("\"run\"").is_err());
        assert!(serde_json::from_str::<ServiceCommand>("\"mcp\"").is_err());
    }
}
