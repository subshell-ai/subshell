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
//! [`AgentCommand`] is the closed set that keeps them absent:
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
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use subshell_desktop_core::legal;
use subshell_desktop_core::proc::{run, Run, ACTION_TIMEOUT, QUERY_TIMEOUT};
use subshell_desktop_core::reset_guards::machine_hostname;
use subshell_desktop_core::settings::{Settings, SettingsState};
use subshell_desktop_core::shell_env::{home_dir, which};
use subshell_desktop_core::sidecar;
use subshell_desktop_core::tray::{effective_close_to_tray, tray_support};

use crate::agent_bin::{self, decide_agent, AgentBinary, AgentChoice, AGENT_SIDECAR};

/// What the page is told when nothing on the ladder answered.
const NO_AGENT: &str = "no subshell agent found — install the bundled one first";

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
}

impl ServiceCommand {
    fn as_str(self) -> &'static str {
        match self {
            ServiceCommand::Install => "install",
            ServiceCommand::Uninstall => "uninstall",
            ServiceCommand::Start => "start",
            ServiceCommand::Stop => "stop",
            ServiceCommand::Restart => "restart",
        }
    }
}

/// Every `subshell` invocation this app is allowed to make.
///
/// The enum IS the allowlist. There is no variant for `run`, none for `mcp`,
/// and no variant that can emit `--probe` — so the three forbidden
/// invocations cannot be reached by adding an argument at a call site, only by
/// adding a variant here. (`version` is the one invocation outside this set:
/// [`agent_bin::probe_version`] appends it while walking the ladder, before
/// there is an agent to build a command for.)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentCommand {
    /// `status --json` — LOCAL truth only, read from the daemon lock file.
    Status,
    /// `service status --json` — what the service manager reports.
    ServiceStatus,
    /// One `service` verb, `--force` only where the CLI accepts it.
    Service { verb: ServiceCommand, force: bool },
    /// `enroll --json`. Destructive; guarded in [`node_enroll`].
    Enroll {
        server: String,
        key: String,
        name: Option<String>,
    },
    /// `configure --json` — repoint an ALREADY-enrolled node.
    ///
    /// The non-destructive counterpart to [`AgentCommand::Enroll`], and the
    /// reason it is a separate variant rather than a flag on that one: it
    /// carries no setup key, keeps this node's id and node key, and mints no
    /// second node row. "The control plane moved" had no other answer.
    ///
    /// Carries no name, because the CLI takes none: `config.json`'s name never
    /// reaches the plane outside the enroll body, so a rename here would move
    /// a local display string and leave the Nodes page unchanged.
    Configure { server: String },
}

impl AgentCommand {
    /// The arguments to append to a resolved agent's command prefix.
    pub fn args(&self) -> Vec<String> {
        match self {
            AgentCommand::Status => vec!["status".into(), "--json".into()],
            AgentCommand::ServiceStatus => vec!["service".into(), "status".into(), "--json".into()],
            // The CLI refuses `--force` anywhere but `restart`, so passing it
            // elsewhere would turn a stop into a usage error.
            AgentCommand::Service { verb, force } if *force && *verb == ServiceCommand::Restart => {
                vec!["service".into(), verb.as_str().into(), "--force".into()]
            }
            AgentCommand::Service { verb, .. } => vec!["service".into(), verb.as_str().into()],
            AgentCommand::Enroll { server, key, name } => {
                let mut args = vec![
                    "enroll".into(),
                    "--server".into(),
                    server.clone(),
                    "--key".into(),
                    key.clone(),
                ];
                if let Some(n) = name {
                    args.push("--name".into());
                    args.push(n.clone());
                }
                // `--json` so nothing here screen-scrapes the human line for
                // the node id; the body deliberately omits the node key.
                args.push("--json".into());
                args
            }
            AgentCommand::Configure { server } => {
                // `--json` for the same reason enroll uses it: the node id and
                // the stored address come back as data, never screen-scraped
                // off a human line. The body omits the node key.
                vec!["configure".into(), "--server".into(), server.clone(), "--json".into()]
            }
        }
    }

    /// The deadline for this invocation. Reads are quick; anything that drives
    /// the service manager or talks to the control plane is not.
    fn timeout(&self) -> Duration {
        match self {
            AgentCommand::Status | AgentCommand::ServiceStatus => QUERY_TIMEOUT,
            AgentCommand::Service { .. } | AgentCommand::Enroll { .. } | AgentCommand::Configure { .. } => {
                ACTION_TIMEOUT
            }
        }
    }
}

/// `<agent> <args…>`, or `None` when nothing resolved.
fn agent_cmd(agent: Option<&AgentBinary>, command: &AgentCommand) -> Option<Vec<String>> {
    let mut cmd = agent?.argv.clone();
    cmd.extend(command.args());
    Some(cmd)
}

fn run_agent(agent: Option<&AgentBinary>, command: &AgentCommand) -> Option<Run> {
    agent_cmd(agent, command).map(|cmd| run(&cmd, command.timeout()))
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

/// Where this machine's agent writes its own log, per platform.
///
/// macOS gets a file, because the launchd plist names one
/// (`~/Library/Logs/subshell.log`, `StandardOutPath`). The systemd user unit
/// redirects nothing, so on Linux the daemon's output is in the journal and
/// there is no file to reveal — hence a hint instead of a path. Exactly one of
/// the two is ever `Some`.
fn agent_log() -> (Option<String>, Option<String>) {
    // One `match`, so "exactly one is Some" holds by construction rather than
    // by every branch remembering to. `filter` rather than an inner `if`
    // keeps both halves compiled on both platforms, which is what makes a
    // clippy run on either of them mean something.
    match home_dir().filter(|_| cfg!(target_os = "macos")) {
        Some(home) => (Some(format!("{home}/Library/Logs/subshell.log")), None),
        None => (None, Some(NO_LOG_FILE.to_string())),
    }
}

/// What to say when there is no log FILE to reveal.
///
/// Platform-specific because the reason is: on Linux the systemd user unit
/// redirects nothing, so the daemon's output is in the journal and no file
/// will ever appear; on macOS the plist names one and it simply has not been
/// written yet.
const NO_LOG_FILE: &str = if cfg!(target_os = "macos") {
    "the agent has not written a log yet — it appears at ~/Library/Logs/subshell.log once the service runs"
} else {
    "the agent logs to the systemd journal on Linux — run `journalctl --user -u subshell.service -f`"
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
    /// The agent's log FILE, where the platform has one.
    pub agent_log: Option<String>,
    /// What to do instead, where it does not.
    pub agent_log_hint: Option<String>,
}

fn node_paths(config: &NodeConfigFacts) -> NodePaths {
    let dir = config_dir();
    let (agent_log, agent_log_hint) = agent_log();
    NodePaths {
        config_dir: dir.as_ref().map(|p| p.to_string_lossy().into_owned()),
        config_file: config_file().map(|p| p.to_string_lossy().into_owned()),
        data_dir: config
            .data_dir
            .clone()
            .or_else(|| dir.map(|p| p.join("data").to_string_lossy().into_owned())),
        agent_log,
        agent_log_hint,
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
    NoAgent,
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
    pub agent: Option<AgentBinary>,
    /// Whether that agent is the copy THIS APP installed and can replace.
    pub managed: bool,
    /// `status --json`, verbatim. `null` when it did not answer at all.
    pub status: Option<serde_json::Value>,
    /// `service status --json`, verbatim. `null` when it did not answer.
    pub service: Option<serde_json::Value>,
    /// What to do about the shipped agent versus the installed one.
    pub agent_choice: AgentChoice,
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
}

impl Default for Probe {
    fn default() -> Self {
        Probe {
            bundled_version: None,
            agent: None,
            managed: false,
            status: None,
            service: None,
            agent_choice: AgentChoice::NoBundled,
            step: ProbeStep::NoAgent,
            error: None,
            tmux: None,
            paths: NodePaths::default(),
            // Empty by default, not read: `Default` is a shape for tests and
            // for `probe_now` to fill, and `machine_hostname` spawns.
            hostname: String::new(),
            rewrite_tears_down: cfg!(target_os = "macos"),
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
    fn decide(&mut self) {
        // A newer INSTALLED agent is adopted, so the upgrade offer only makes
        // sense against the copy this app owns. Offering it for an agent the
        // user installed elsewhere would write ~/.local/bin, change nothing
        // about what the service runs, and offer again forever.
        let comparable = if self.managed || self.agent.is_none() {
            self.agent.as_ref().and_then(|a| a.version.as_deref())
        } else {
            self.bundled_version.as_deref() // nothing to offer: treat as up to date
        };
        self.agent_choice = decide_agent(self.bundled_version.as_deref(), comparable);

        self.step = if self.agent.is_none() {
            ProbeStep::NoAgent
        } else if self.status.is_none() {
            // The binary answered `version` but not `status --json`. Reading
            // that as "not enrolled" would offer ENROLL, which overwrites
            // config.json, mints a second node row on the control plane and
            // discards the node key whose only home was that file — a
            // transient failure must never route to the destructive step. The
            // honest remedy for a binary that cannot state its own status is a
            // different binary, so it lands here, with `error` saying why.
            ProbeStep::NoAgent
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
    BUNDLED_VERSION.get_or_init(agent_bin::bundled_version).clone()
}

/// Look at the machine and report what it would take to get this node running.
#[tauri::command(async)]
pub fn node_probe(settings: State<'_, SettingsState>) -> Probe {
    probe_now(settings.get().binary_path.as_deref())
}

pub(crate) fn probe_now(configured: Option<&str>) -> Probe {
    let agent = agent_bin::resolve(configured);
    let managed = match (&agent, sidecar::install_path(&AGENT_SIDECAR)) {
        (Some(a), Some(managed_path)) => a.argv.first().map(String::as_str) == managed_path.to_str(),
        _ => false,
    };
    let mut p = Probe {
        bundled_version: bundled_version(),
        agent,
        managed,
        tmux: which("tmux"),
        paths: node_paths(&read_node_config()),
        hostname: machine_hostname(),
        ..Default::default()
    };

    if let Some(out) = run_agent(p.agent.as_ref(), &AgentCommand::Status) {
        p.status = json_of(&out);
        if p.status.is_none() {
            p.error = Some(format!("`status --json` failed: {}", out.detail()));
        }
    }
    if let Some(out) = run_agent(p.agent.as_ref(), &AgentCommand::ServiceStatus) {
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
/// downstream states it: [`decide_agent`]'s rule is that a newer bundled agent
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
/// Decided against the RESOLVED agent rather than read off `Probe::agent_choice`
/// — that field is deliberately narrowed to the copy this app manages, because
/// an upgrade OFFER for an agent the service does not run would change nothing
/// and repeat forever. The guard has to be wider than the offer: `~/.local/bin`
/// outranks the login PATH and the well-known directories, so writing an older
/// binary there is a downgrade of what this app drives even when it never
/// installed the newer one.
pub fn install_refusal(bundled: Option<&str>, installed: Option<&str>) -> Option<String> {
    // Both versions are readable by construction: an agent that cannot state
    // one never resolves, and `decide_agent` reaches AdoptInstalled only when
    // it has two to compare.
    if decide_agent(bundled, installed) != AgentChoice::AdoptInstalled {
        return None;
    }
    let (bundled, installed) = (bundled?, installed?);
    Some(format!(
        "the agent already installed on this machine ({installed}) is newer than the one this app ships \
         ({bundled}), so installing would downgrade it — an agent older than the control plane expects enrolls, \
         comes up online and then refuses every launch. Nothing was changed, and the installed agent is the one \
         this app drives."
    ))
}

/// What to say about the service this install took down, if it took one down.
fn stop_note(stop: Option<&Run>) -> &'static str {
    match stop {
        None => "",
        // Say that the service is down, because this is the one action that
        // stops it without being asked to.
        Some(r) if r.ok() => " The service was stopped so the file could be replaced — start it again.",
        // The copy goes ahead whatever the stop did, so the honest report is
        // that the file changed underneath a daemon still running the old one.
        Some(_) => {
            " The service could NOT be stopped and the file was replaced anyway — what is running is still the old \
             agent until it is restarted."
        }
    }
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

/// Fold the stop's own words into the install's result.
///
/// The stop is a CLI invocation with things to say: "subshell stopped." when it
/// worked, and — the one that matters — the pane warning when the installed
/// definition predates the pane-sparing directive, which is the sentence naming
/// every subshell it just took down. Discarding it made this the one action
/// that could end every pane on the machine and print nothing about it.
fn with_stop_output(result: ActionResult, stop: Option<Run>) -> ActionResult {
    let Some(stop) = stop else { return result };
    let stop = ActionResult::from(stop);
    ActionResult {
        // A stop that failed leaves the manager running the binary that was
        // just replaced, so the machine is not in the state the success line
        // describes — a failure, whatever the copy managed to do.
        ok: result.ok && stop.ok,
        stdout: joined(&stop.stdout, &result.stdout),
        stderr: joined(&stop.stderr, &result.stderr),
    }
}

/// Materialise the bundled agent at `~/.local/bin/subshell`.
#[tauri::command(async)]
pub fn node_install_agent(settings: State<'_, SettingsState>) -> Result<ActionResult, String> {
    let configured = settings.get().binary_path;
    let version = bundled_version();
    let probe = probe_now(configured.as_deref());
    if let Some(reason) = install_refusal(
        version.as_deref(),
        probe.agent.as_ref().and_then(|a| a.version.as_deref()),
    ) {
        return Ok(ActionResult::refused(reason));
    }
    // Only tear the service down when we are actually replacing the binary it
    // runs. Stopping one that points somewhere else would end every subshell's
    // supervision on this machine for no upgrade at all.
    //
    // `stop`, never `restart --force`: the CLI's own pane guard is what decides
    // what a teardown costs — it warns rather than refusing on `stop`, and the
    // warning is the only thing that will say which panes went down — which is
    // why this goes through the CLI rather than through systemctl.
    let stop_target = probe
        .managed
        .then(|| {
            agent_cmd(
                probe.agent.as_ref(),
                &AgentCommand::Service {
                    verb: ServiceCommand::Stop,
                    force: false,
                },
            )
        })
        .flatten();
    // KEPT, not discarded: see `with_stop_output`.
    let mut stopped: Option<Run> = None;
    let outcome = sidecar::install_bundled(&AGENT_SIDECAR, version.as_deref(), || {
        if let Some(cmd) = stop_target {
            stopped = Some(run(&cmd, ACTION_TIMEOUT));
        }
    })?;
    match outcome {
        sidecar::InstallOutcome::NoSidecar => Err("this build ships no subshell agent".into()),
        // Nothing was stopped on this path: `install_bundled` answers before it
        // calls the stop at all.
        sidecar::InstallOutcome::UpToDate => Ok(ActionResult::said("The bundled agent is already installed.")),
        sidecar::InstallOutcome::Installed => {
            let where_ = sidecar::install_path(&AGENT_SIDECAR)
                .map(|p| p.display().to_string())
                .unwrap_or_default();
            let note = stop_note(stopped.as_ref());
            Ok(with_stop_output(
                ActionResult::said(format!("Installed subshell to {where_}.{note}")),
                stopped,
            ))
        }
    }
}

/// One `service` verb, straight through. The agent decides whether to refuse —
/// including the pane guard, which refuses a `restart` whose installed
/// definition would SIGKILL every live subshell on this machine.
#[tauri::command(async)]
pub fn node_service(settings: State<'_, SettingsState>, verb: ServiceCommand, force: bool) -> ActionResult {
    service_now(&settings, verb, force)
}

/// The body of [`node_service`], callable from inside another chain.
///
/// Extracted so the reset runs the SAME stop and uninstall the page's own
/// buttons run, rather than a second spelling of them — a reset whose teardown
/// diverged from the one the user can press by hand is a reset that leaves a
/// different machine behind.
pub(crate) fn service_now(settings: &SettingsState, verb: ServiceCommand, force: bool) -> ActionResult {
    let agent = agent_bin::resolve(settings.get().binary_path.as_deref());
    match run_agent(agent.as_ref(), &AgentCommand::Service { verb, force }) {
        Some(out) => out.into(),
        None => ActionResult::refused(NO_AGENT),
    }
}

/// Repoint this machine's node at a different control plane.
///
/// The non-destructive sibling of [`node_enroll`], and the reason it needs no
/// confirmation gate: it spends no setup key, mints no second node row, and
/// keeps the node key whose only home is `config.json`. Nothing here is
/// unrecoverable, so nothing here has to be asked about twice.
///
/// On success the app's own `planeUrl` is repointed TOO. Those are two
/// independent values — `plane_url_from` falls back to the node's `serverUrl`
/// only when no preference is stored — so leaving it alone would show a plane
/// at one address while this machine's daemon talked to another, with no
/// surface naming the difference. A repoint is a statement about which control
/// plane this machine belongs to, and both halves of the app should hear it.
///
/// The URL is validated HERE, before anything spawns: the same
/// [`validate_server_url`] the enroll form and the plane window use, so all
/// three refuse the same strings with the same words.
#[tauri::command(async)]
pub fn node_configure(settings: State<'_, SettingsState>, server: Option<String>) -> ActionResult {
    let server = match server.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(raw) => match validate_server_url(&raw) {
            Ok(url) => url,
            Err(e) => return ActionResult::refused(e),
        },
        None => return ActionResult::refused("enter the control plane's URL to repoint this node"),
    };
    let agent = agent_bin::resolve(settings.get().binary_path.as_deref());
    let command = AgentCommand::Configure { server: server.clone() };
    let Some(out) = run_agent(agent.as_ref(), &command) else {
        return ActionResult::refused(NO_AGENT);
    };
    // Only on success: a refused repoint must not move the app's own address
    // to a plane this machine is not actually pointed at.
    if out.ok() {
        // A settings write that fails is worth saying so — the repoint itself
        // landed, and the two values are now the divergence this exists to
        // prevent, which the caller can only explain if it is told.
        if let Err(e) = settings.update(|s| s.plane_url = Some(server.clone())) {
            return ActionResult {
                ok: true,
                stdout: out.stdout,
                stderr: format!("the node was repointed, but this app could not remember the address: {e}"),
            };
        }
    }
    out.into()
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
    let url: tauri::Url = trimmed.parse().map_err(|_| {
        format!("'{trimmed}' is not a full URL — include the scheme, e.g. https://subshell.example.com")
    })?;
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
    // page shows, what is persisted as `planeUrl`, and what is handed to
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
    const SHAPE: &str = "a setup key looks like `nsk_` followed by 32 letters, digits, `-` or `_` — copy it from Settings → Node setup keys";
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("paste the setup key minted on the Nodes page".into());
    }
    let Some(body) = trimmed.strip_prefix(SETUP_KEY_PREFIX) else {
        return Err(format!("that does not look like a setup key — {SHAPE}"));
    };
    if body.chars().count() != SETUP_KEY_BODY_LEN
        || !body.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("that setup key is malformed — {SHAPE}"));
    }
    Ok(trimmed.to_string())
}

/// Validate an optional node name. Absent (or blank) means "let the agent
/// default to this machine's hostname", which is what the CLI does.
pub fn validate_node_name(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(name) = raw.map(str::trim).filter(|n| !n.is_empty()) else {
        return Ok(None);
    };
    let len = name.chars().count();
    if len > MAX_NODE_NAME_LEN {
        return Err(format!(
            "that name is {len} characters — the control plane accepts at most {MAX_NODE_NAME_LEN}"
        ));
    }
    Ok(Some(name.to_string()))
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
                             plane, and discards the current node key — whose only copy is that file. The old node \
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
                 That is right if you run the server here, and wrong if you copied the URL from a browser on \
                 another machine — and a setup key is single-use, so a wrong URL spends it."
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
    name: Option<String>,
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
    let name = match validate_node_name(name.as_deref()) {
        Ok(n) => n,
        Err(e) => return EnrollOutcome::refused(e),
    };

    // Resolved BEFORE the confirmation, so a machine with no agent is told so
    // instead of being asked to confirm something that then cannot happen.
    let agent = agent_bin::resolve(settings.get().binary_path.as_deref());
    if agent.is_none() {
        return EnrollOutcome::refused(NO_AGENT);
    }

    if !confirm {
        let confirmations = confirmations_for(&server, &existing_node());
        if !confirmations.is_empty() {
            return EnrollOutcome::ask(confirmations);
        }
    }

    let Some(out) = run_agent(agent.as_ref(), &AgentCommand::Enroll { server, key, name }) else {
        return EnrollOutcome::refused(NO_AGENT);
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

/// Remember an explicitly chosen agent binary.
///
/// Validated before it is persisted: this path is EXECUTED on every launch, so
/// accepting whatever a file dialog returned would let one mis-click wedge the
/// app on a file that is not an agent — including
/// `apps/server/desktop`'s `subshell-server`, which answers `version` with a
/// line this app's prefix deliberately refuses.
#[tauri::command(async)]
pub fn node_set_agent_bin(settings: State<'_, SettingsState>, path: Option<String>) -> Result<(), String> {
    let cleaned = match path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
        None => None,
        Some(p) => {
            if !Path::new(&p).is_absolute() {
                return Err(format!("{p} is not an absolute path"));
            }
            if agent_bin::probe_version(std::slice::from_ref(&p)).is_none() {
                return Err(format!(
                    "{p} does not look like a subshell agent — it could not report a version"
                ));
            }
            Some(p)
        }
    };
    settings.update(|s| s.binary_path = cleaned)
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
    pub agent_bin_path: Option<String>,
    /// The control plane the main window shows, once one has been resolved.
    ///
    /// From the stored preference, else the enrolled node's own `serverUrl` —
    /// the same ladder [`resolve_plane_url`] walks, so what the page offers to
    /// open and what actually opens can never be two different addresses.
    pub plane_url: Option<String>,
}

/// Build the payload from the stored settings.
fn settings_view(current: Settings) -> NodeSettings {
    NodeSettings {
        agent_bin_path: current.binary_path,
        plane_url: plane_url_from(current.plane_url),
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

/// Which control plane this client shows, given a stored preference.
///
/// Two rungs, in this order:
///
/// 1. the **stored** `planeUrl` — the address the user last chose, which is
///    the only rung a client that is not a node ever has;
/// 2. the enrolled node's **`serverUrl`** from `config.json`, so a machine
///    enrolled from the CLI opens on its own plane without being told twice.
///
/// Each rung is validated rather than trusted: both are strings from a file,
/// and the answer is what a window gets pointed at. An unusable value is
/// skipped, not surfaced — the page's own URL field is where a bad address is
/// reported, at the moment someone types one.
pub fn plane_url_from(stored: Option<String>) -> Option<String> {
    stored
        .and_then(|u| validate_server_url(&u).ok())
        .or_else(|| read_node_config().server_url.and_then(|u| validate_server_url(&u).ok()))
}

/// The same ladder, against the live settings. What `lib.rs` asks at startup.
pub fn resolve_plane_url(settings: &SettingsState) -> Option<String> {
    plane_url_from(settings.get().plane_url)
}

/// Show a control plane's own UI, and remember the address.
///
/// `url` is what the user typed or what the page read off the probe; `None`
/// means "open whatever [`resolve_plane_url`] already knows", which is what the
/// header button does once an address is settled.
///
/// The window this opens is granted NO commands — see
/// `windows::open_plane` — so this is the whole of the plane's reach into the
/// app: it gets a webview, an origin pin, and nothing else.
#[tauri::command(async)]
pub fn node_open_plane(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    url: Option<String>,
) -> Result<String, String> {
    let resolved = match url.map(|u| u.trim().to_string()).filter(|u| !u.is_empty()) {
        Some(raw) => validate_server_url(&raw)?,
        None => resolve_plane_url(&settings)
            .ok_or_else(|| "no control plane yet — enter its URL, or enrol this machine first".to_string())?,
    };
    // Persisted BEFORE the window opens, so a plane that is merely unreachable
    // today is still the one this client comes back to tomorrow.
    settings.update(|s| s.plane_url = Some(resolved.clone()))?;
    crate::windows::open_plane(&app, &resolved)?;
    Ok(resolved)
}

/// Open the control plane's address in the SYSTEM browser.
///
/// The in-app plane window stays the primary route; this is for taking the
/// SAME address somewhere a shell cannot — a different browser, a share, a
/// profile with passkeys the webview has no. Like the server app's twin, the
/// page names the INTENT and no URL argument crosses the boundary: this
/// re-reads the same ladder `node_open_plane` points a window at, so the
/// browser can only ever be sent to the address the page is already showing
/// (http(s)-validated by [`validate_server_url`], which the window also
/// relies on).
#[tauri::command(async)]
pub fn node_open_plane_url(app: AppHandle, settings: State<'_, SettingsState>) -> Result<(), String> {
    let url = resolve_plane_url(&settings)
        .ok_or_else(|| "no control plane yet — enter its URL, or enrol this machine first".to_string())?;
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| format!("could not open {url}: {e}"))
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
    AgentLog,
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
            .ok_or_else(|| "this machine has no data directory yet — it is created when the node enrolls".to_string()),
        OpenTarget::AgentLog => paths
            .agent_log
            .clone()
            .ok_or_else(|| paths.agent_log_hint.clone().unwrap_or_else(|| NO_LOG_FILE.to_string())),
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
}

/// Open one of the three About links in the system browser.
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

// ---------------------------------------------------------------------------

#[cfg(test)]
mod command_set_tests {
    use super::*;

    fn every_command() -> Vec<AgentCommand> {
        let mut out = vec![AgentCommand::Status, AgentCommand::ServiceStatus];
        for verb in [
            ServiceCommand::Install,
            ServiceCommand::Uninstall,
            ServiceCommand::Start,
            ServiceCommand::Stop,
            ServiceCommand::Restart,
        ] {
            for force in [false, true] {
                out.push(AgentCommand::Service { verb, force });
            }
        }
        out.push(AgentCommand::Enroll {
            server: "https://subshell.example.com".into(),
            key: "nsk_0123456789012345678901234567890a".into(),
            name: Some("workstation".into()),
        });
        out.push(AgentCommand::Enroll {
            server: "https://subshell.example.com".into(),
            key: "nsk_0123456789012345678901234567890a".into(),
            name: None,
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
        assert_eq!(AgentCommand::Status.args(), ["status", "--json"]);
        assert_eq!(AgentCommand::ServiceStatus.args(), ["service", "status", "--json"]);
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
            let args = AgentCommand::Service { verb, force: true }.args();
            assert!(!args.iter().any(|a| a == "--force"), "{verb:?} kept --force: {args:?}");
        }
        assert_eq!(
            AgentCommand::Service {
                verb: ServiceCommand::Restart,
                force: true
            }
            .args(),
            ["service", "restart", "--force"]
        );
        assert_eq!(
            AgentCommand::Service {
                verb: ServiceCommand::Restart,
                force: false
            }
            .args(),
            ["service", "restart"]
        );
    }

    #[test]
    fn enroll_passes_the_name_only_when_there_is_one() {
        let with = AgentCommand::Enroll {
            server: "https://x.example".into(),
            key: "nsk_k".into(),
            name: Some("box".into()),
        };
        assert_eq!(
            with.args(),
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
        let without = AgentCommand::Enroll {
            server: "https://x.example".into(),
            key: "nsk_k".into(),
            name: None,
        };
        assert!(!without.args().iter().any(|a| a == "--name"));
    }

    /// `configure` is the NON-destructive repoint, and its argv is what proves
    /// it: no `--key` (it spends no setup key) and no `--data-dir` (the
    /// identity directory belongs to the enrollment that made it). No `--name`
    /// either — the plane owns a node's name, and the CLI rejects the flag.
    #[test]
    fn configure_repoints_without_a_setup_key_or_a_rename() {
        let args = AgentCommand::Configure {
            server: "https://subshell.example".into(),
        }
        .args();
        assert_eq!(args, ["configure", "--server", "https://subshell.example", "--json"]);
        for forbidden in ["--key", "--data-dir", "--name"] {
            assert!(!args.iter().any(|a| a == forbidden), "{forbidden} must not appear");
        }
    }

    /// A repoint dials no control plane — it rewrites one local file — but it
    /// does go through the same spawn machinery as an enroll, and the CLI does
    /// its own fs work. The action deadline, not the query one.
    #[test]
    fn a_repoint_gets_the_action_deadline() {
        assert_eq!(
            AgentCommand::Configure {
                server: "https://subshell.example".into(),
            }
            .timeout(),
            ACTION_TIMEOUT
        );
    }

    // A read must never wait 90 seconds, and an enroll must never be killed at
    // 15 — the CLI's own network deadline is 30.
    #[test]
    fn deadlines_match_what_each_invocation_does() {
        assert_eq!(AgentCommand::Status.timeout(), QUERY_TIMEOUT);
        assert_eq!(AgentCommand::ServiceStatus.timeout(), QUERY_TIMEOUT);
        assert_eq!(
            AgentCommand::Enroll {
                server: "https://x.example".into(),
                key: "nsk_k".into(),
                name: None,
            }
            .timeout(),
            ACTION_TIMEOUT
        );
        assert!(ACTION_TIMEOUT > Duration::from_secs(30));
    }

    #[test]
    fn the_agent_prefix_comes_first() {
        let agent = AgentBinary {
            argv: vec!["/bin/bun".into(), "/repo/main.ts".into()],
            source: crate::agent_bin::AgentSource::Service,
            version: Some("1.9.0".into()),
        };
        assert_eq!(
            agent_cmd(Some(&agent), &AgentCommand::Status).unwrap(),
            ["/bin/bun", "/repo/main.ts", "status", "--json"]
        );
        assert!(agent_cmd(None, &AgentCommand::Status).is_none());
    }
}

#[cfg(test)]
mod probe_tests {
    use super::*;
    use serde_json::json;

    fn agent() -> AgentBinary {
        AgentBinary {
            argv: vec!["/home/u/.local/bin/subshell".into()],
            source: crate::agent_bin::AgentSource::LocalBin,
            version: Some("1.9.0".into()),
        }
    }

    fn probe_with(status: Option<serde_json::Value>, service: Option<serde_json::Value>, has_agent: bool) -> Probe {
        let mut p = Probe {
            bundled_version: Some("1.9.0".into()),
            agent: has_agent.then(agent),
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
    fn with_no_agent_the_first_step_is_getting_one() {
        assert_eq!(probe_with(None, None, false).step, ProbeStep::NoAgent);
    }

    // The dangerous one: `enroll` overwrites config.json, mints a second node
    // row and throws away the node key. A binary that ran `version` but whose
    // `status` failed must never route there.
    #[test]
    fn an_agent_that_did_not_answer_is_never_the_enroll_step() {
        let p = probe_with(None, Some(service(true, "running")), true);
        assert_eq!(p.step, ProbeStep::NoAgent);
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
    fn no_upgrade_is_offered_for_an_agent_this_app_does_not_manage() {
        let mut p = Probe {
            bundled_version: Some("2.0.0".into()),
            agent: Some(AgentBinary {
                argv: vec!["/usr/local/bin/subshell".into()],
                source: crate::agent_bin::AgentSource::Service,
                version: Some("1.9.0".into()),
            }),
            managed: false,
            ..Default::default()
        };
        p.decide();
        assert_eq!(p.agent_choice, AgentChoice::UpToDate);
    }

    #[test]
    fn an_upgrade_is_offered_for_the_managed_copy() {
        let mut p = Probe {
            bundled_version: Some("2.0.0".into()),
            agent: Some(agent()),
            managed: true,
            ..Default::default()
        };
        p.decide();
        assert_eq!(p.agent_choice, AgentChoice::UpgradeAvailable);
    }

    #[test]
    fn nothing_installed_and_something_bundled_is_an_install() {
        let mut p = Probe {
            bundled_version: Some("1.9.0".into()),
            ..Default::default()
        };
        p.decide();
        assert_eq!(p.agent_choice, AgentChoice::InstallBundled);
        assert_eq!(p.step, ProbeStep::NoAgent);
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
        assert_eq!(serde_json::to_string(&ProbeStep::NoAgent).unwrap(), "\"no-agent\"");
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
            "agent",
            "managed",
            "status",
            "service",
            "agentChoice",
            "step",
            "error",
            "tmux",
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

    fn run_with(code: Option<i32>, stdout: &str, stderr: &str) -> Run {
        Run {
            code,
            stdout: stdout.into(),
            stderr: stderr.into(),
            timed_out: false,
        }
    }

    // The invariant `agent_bin` states in its own words: a newer installed
    // agent is ADOPTED, never overwritten. Nothing downstream enforces it —
    // `already_installed` compares versions for equality, not order — so an
    // older bundled binary would otherwise overwrite a newer installed one and
    // buy a node that enrolls, reports online and refuses every launch.
    #[test]
    fn a_newer_installed_agent_is_never_overwritten() {
        let refusal = install_refusal(Some("1.9.0"), Some("2.0.0")).expect("a downgrade must be refused");
        assert!(refusal.contains("2.0.0"), "{refusal}");
        assert!(refusal.contains("1.9.0"), "{refusal}");
        assert!(refusal.contains("downgrade"), "{refusal}");
        // Numeric, not lexical — the comparison `decide_agent` already owns.
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

    // The guard is deliberately WIDER than the upgrade offer. `agent_choice`
    // is narrowed to the copy this app manages — an offer for an agent the
    // service does not run would change nothing and repeat forever — but
    // `~/.local/bin` outranks the login PATH and the well-known directories,
    // so writing an older binary there downgrades what this app drives even
    // when it never installed the newer one.
    #[test]
    fn an_agent_this_app_does_not_manage_is_not_downgraded_either() {
        let mut p = Probe {
            bundled_version: Some("1.9.0".into()),
            agent: Some(AgentBinary {
                argv: vec!["/usr/local/bin/subshell".into()],
                source: crate::agent_bin::AgentSource::WellKnown,
                version: Some("2.0.0".into()),
            }),
            managed: false,
            ..Default::default()
        };
        p.decide();
        // Nothing is OFFERED here…
        assert_eq!(p.agent_choice, AgentChoice::UpToDate);
        // …and if the command is reached anyway, it still refuses.
        assert!(install_refusal(
            p.bundled_version.as_deref(),
            p.agent.as_ref().and_then(|a| a.version.as_deref())
        )
        .is_some());
    }

    // The one action that stops the service without being asked to. On a stale
    // definition that stop is what ends every pane on the machine, and the
    // CLI's warning is the only thing that says so.
    #[test]
    fn the_stops_own_words_reach_the_page() {
        let warning = "subshell: warning: /Users/u/Library/LaunchAgents/dev.subshell.client.plist predates \
                       AbandonProcessGroup=true, so stop kills every running subshell's tmux server";
        let result = with_stop_output(
            ActionResult::said("Installed subshell to /home/u/.local/bin/subshell."),
            Some(run_with(Some(0), "subshell stopped.", warning)),
        );
        assert!(result.ok);
        assert!(
            result.stderr.contains("kills every running subshell"),
            "{}",
            result.stderr
        );
        assert!(result.stdout.contains("subshell stopped."), "{}", result.stdout);
        assert!(result.stdout.contains("Installed subshell"), "{}", result.stdout);
    }

    // A stop that failed leaves the manager running the file that was just
    // replaced: the success line describes a machine this one is not.
    #[test]
    fn a_failed_stop_makes_the_whole_install_a_failure() {
        let result = with_stop_output(
            ActionResult::said("Installed subshell to /home/u/.local/bin/subshell."),
            Some(run_with(
                Some(1),
                "",
                "systemctl --user stop subshell.service failed (exit 1): no such unit",
            )),
        );
        assert!(!result.ok);
        assert!(result.stderr.contains("no such unit"), "{}", result.stderr);
    }

    // A silent failure — a deadline or a spawn error — still has to say
    // something, or the install reads as clean.
    #[test]
    fn a_stop_that_said_nothing_still_reports_itself() {
        let result = with_stop_output(
            ActionResult::said("Installed."),
            Some(Run {
                code: None,
                stdout: String::new(),
                stderr: String::new(),
                timed_out: true,
            }),
        );
        assert!(!result.ok);
        assert_eq!(result.stderr, "timed out");
    }

    // Nothing was stopped (an unmanaged agent, or nothing installed), so
    // nothing is claimed about a service.
    #[test]
    fn with_no_stop_the_result_is_untouched() {
        let result = with_stop_output(ActionResult::said("Installed."), None);
        assert!(result.ok);
        assert_eq!(result.stdout, "Installed.");
        assert_eq!(result.stderr, "");
        assert_eq!(stop_note(None), "");
    }

    // The note describes what actually happened to the service, not what the
    // app intended: "start it again" over a stop that failed sends the user to
    // a button that will report the service is already running.
    #[test]
    fn the_note_follows_the_stop_that_actually_ran() {
        assert!(stop_note(Some(&run_with(Some(0), "subshell stopped.", ""))).contains("start it again"));
        let failed = stop_note(Some(&run_with(Some(1), "", "boom")));
        assert!(failed.contains("could NOT be stopped"), "{failed}");
        assert!(!failed.contains("start it again"), "{failed}");
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
    /// This value is what the page shows, what gets persisted as `planeUrl`,
    /// and what is handed to `subshell configure --server`. The agent's
    /// `wsUrlFor` builds its dial URL by string-replacing the scheme, so a
    /// mixed-case one produced `HTTP://host/ws/node` — not a WebSocket URL.
    /// The agent now normalizes on write regardless, so this is the two
    /// spellings of "one normalization" agreeing rather than the only guard.
    #[test]
    fn a_mixed_case_scheme_is_lowercased_like_the_agent_does() {
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
    fn a_blank_name_means_let_the_agent_default_to_the_hostname() {
        assert_eq!(validate_node_name(None).unwrap(), None);
        assert_eq!(validate_node_name(Some("   ")).unwrap(), None);
        assert_eq!(
            validate_node_name(Some("  workstation  ")).unwrap(),
            Some("workstation".into())
        );
    }

    // The control plane's cap, pre-checked here because learning it from a 400
    // costs the setup key.
    #[test]
    fn a_name_longer_than_the_control_plane_accepts_is_refused() {
        assert!(validate_node_name(Some(&"x".repeat(MAX_NODE_NAME_LEN))).is_ok());
        assert!(validate_node_name(Some(&"x".repeat(MAX_NODE_NAME_LEN + 1))).is_err());
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

    // Exactly one of the two is ever set: macOS has a plist that names a log
    // file, and the systemd unit redirects nothing, so Linux has a journal and
    // no file to reveal.
    #[test]
    fn the_agent_log_is_a_path_or_a_hint_never_both_and_never_neither() {
        let (path, hint) = agent_log();
        assert_ne!(path.is_some(), hint.is_some());
        match (path, hint) {
            (Some(p), None) => assert!(p.ends_with("/Library/Logs/subshell.log"), "{p}"),
            (None, Some(h)) => assert!(!h.is_empty()),
            other => panic!("neither or both: {other:?}"),
        }
    }

    // The remedy differs because the reason does: a Linux node's daemon output
    // is in the journal and no file will ever appear, where a macOS one simply
    // has not been written yet. Telling a Mac user to run `journalctl` — or a
    // Linux user to wait for a file — is worse than saying nothing.
    #[test]
    fn each_platform_is_told_the_right_reason_for_having_no_log_file() {
        if cfg!(target_os = "macos") {
            assert!(NO_LOG_FILE.contains("~/Library/Logs/subshell.log"), "{NO_LOG_FILE}");
            assert!(!NO_LOG_FILE.contains("journalctl"), "{NO_LOG_FILE}");
        } else {
            assert!(
                NO_LOG_FILE.contains("journalctl --user -u subshell.service"),
                "{NO_LOG_FILE}"
            );
        }
    }

    #[test]
    fn every_target_resolves_or_explains_itself() {
        let paths = node_paths(&NodeConfigFacts::default());
        for target in [OpenTarget::ConfigDir, OpenTarget::DataDir, OpenTarget::AgentLog] {
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
            agent_log: None,
            agent_log_hint: Some("do this instead".into()),
            ..Default::default()
        };
        assert_eq!(
            resolve_open_target(OpenTarget::AgentLog, &paths).unwrap_err(),
            "do this instead"
        );
        // …and when even the hint is missing, with the platform's own reason
        // rather than an empty string.
        let bare = NodePaths::default();
        assert_eq!(
            resolve_open_target(OpenTarget::AgentLog, &bare).unwrap_err(),
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
            serde_json::from_str::<OpenTarget>("\"agent-log\"").unwrap(),
            OpenTarget::AgentLog
        );
        assert!(serde_json::from_str::<OpenTarget>("\"/etc/passwd\"").is_err());
    }

    fn stored(close_to_tray: bool) -> Settings {
        Settings {
            binary_path: None,
            close_to_tray,
            open_at_login: false,
            plane_url: None,
            // The server app's wizard flag. Client ignores it; it shares the
            // struct, not the semantics.
            onboarded: false,
            // Read by the menus, never by the page — see the key-set test below.
            zoom: 1.0,
            // Subshell Server's own: who runs the control plane there. This
            // app has a node agent with its own service and no such mode, so
            // it shares the struct and ignores the field, exactly as the
            // server app ignores `plane_url`.
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
    fn the_payload_is_the_two_fields_the_assistant_reads() {
        let json = serde_json::to_value(settings_view(stored(true))).unwrap();
        let mut keys: Vec<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["agentBinPath", "planeUrl"]);
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
