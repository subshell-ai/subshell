//! The commands the console window calls.
//!
//! Every one is an argument-poor wrapper around the `subshell-server` CLI: the
//! server owns each decision (what a valid port is, whether a restart would
//! kill live panes, what to tell the operator), and this layer only routes.
//! That is why `--json` exists on the CLI at all — nothing here parses prose,
//! and nothing here re-implements a rule that has a home in `apps/server/api`.
//!
//! **Every command is `async`.** They are not async internally — the CLI is
//! synchronous by contract — but a plain `#[tauri::command]` runs on the main
//! thread, and `ACTION_TIMEOUT` is 90 seconds. A blocking command there does
//! not merely delay the answer: it freezes both windows, so the console cannot
//! even paint the "Working…" state it set before calling.

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use subshell_desktop_core::proc::{run, Run, ACTION_TIMEOUT, QUERY_TIMEOUT};
use subshell_desktop_core::settings::{Settings, SettingsState};
use subshell_desktop_core::sidecar;
use subshell_desktop_core::tray::{effective_close_to_tray, tray_support, TraySupport};

use crate::server_bin::{self, decide_server, parse_server_version, ServerBinary, ServerChoice, SERVER_SIDECAR};

/// The single next action the console should offer.
///
/// An enum rather than a string so a step the page does not handle is a
/// compile-time question on this side and an explicit fallback on the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProbeStep {
    /// No server, and this build ships none.
    NoServer,
    /// No server, but one is bundled: the whole setup chain, behind one press.
    Setup,
    /// A server exists but did not answer. NOT the same as "unconfigured".
    Unreachable,
    /// A server with no `config.env`.
    Init,
    /// Configured, but not installed as a service.
    InstallService,
    /// Installed and not running.
    Start,
    /// Running.
    Ready,
}

/// Everything the console needs to decide what to offer, in one round trip.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    /// The server this app ships, if this build carries one.
    pub bundled_version: Option<String>,
    /// The server that would actually run, and which rung found it.
    pub server: Option<ServerBinary>,
    /// Whether that server is the copy THIS APP installed and can replace.
    pub managed: bool,
    /// `status --json`, verbatim. `null` when it did not answer.
    pub status: Option<serde_json::Value>,
    /// `service status --json`, verbatim. `null` when it did not answer.
    pub service: Option<serde_json::Value>,
    /// What to do about the shipped server versus the installed one.
    pub server_choice: ServerChoice,
    /// The single next action.
    pub next: ProbeStep,
    /// The CLI's own words when a step failed rather than merely being pending.
    pub error: Option<String>,
    /// tmux's path on the LOGIN path, or `null`.
    ///
    /// Resolved here rather than read off `status`, because it has to be
    /// answerable before there is a server to ask: tmux is a hard stop on both
    /// `init` and `service install` (every local pane launches through it), and
    /// on a clean machine the console reaches those steps with `status` still
    /// null. Learning about it at the refusal is learning too late.
    pub tmux: Option<String>,
    /// The OS in the names the console branches on: "linux", "darwin", …
    ///
    /// The console's install offers branch on the machine; the webview's own
    /// UA sniff (`navigator.userAgent`) was the old source, and a UA string is
    /// a guess where this is the fact `tmux_install_argv` will act on.
    /// Normalized through [`console_platform`] because the two sides speak
    /// different dialects, and a "macos" here silently drops every Mac user
    /// into the no-button fallback.
    pub platform: String,
    /// Whether `brew` resolves on the login PATH.
    ///
    /// Asked where `tmux` is, for the same reason: a Mac without Homebrew gets
    /// the MacPorts instructions rather than a button that cannot work, and
    /// the webview has no way to look.
    pub has_brew: bool,
}

impl Default for Probe {
    fn default() -> Self {
        Probe {
            bundled_version: None,
            server: None,
            managed: false,
            status: None,
            service: None,
            server_choice: ServerChoice::NoBundled,
            next: ProbeStep::NoServer,
            error: None,
            tmux: None,
            platform: String::new(),
            has_brew: false,
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

impl Probe {
    /// The single next action, derived from facts rather than remembered.
    ///
    /// Recomputed on every probe on purpose: the user may have installed a
    /// server, edited config.env or stopped the service in a terminal while
    /// this window was open, and a remembered step would be wrong.
    fn decide(&mut self) {
        // A newer INSTALLED server is adopted, so the upgrade offer only makes
        // sense against the copy this app owns. Offering it for a server the
        // user installed elsewhere would write ~/.local/bin, change nothing
        // about what the service runs, and offer again forever.
        let comparable = if self.managed || self.server.is_none() {
            self.server.as_ref().and_then(|s| s.version.as_deref())
        } else {
            self.bundled_version.as_deref() // nothing to offer: treat as up to date
        };
        self.server_choice = decide_server(self.bundled_version.as_deref(), comparable);

        self.next = if self.server.is_none() {
            if self.bundled_version.is_some() {
                ProbeStep::Setup
            } else {
                ProbeStep::NoServer
            }
        } else if self.status.is_none() {
            // The binary ran `version` but not `status`. Treating that as
            // "unconfigured" would offer `init`, which REWRITES config.env —
            // destroying a working configuration to fix a transient failure.
            ProbeStep::Unreachable
        } else if field(&self.status, "configEnv").and_then(|c| c.get("exists")) != Some(&serde_json::Value::Bool(true))
        {
            ProbeStep::Init
        } else if self.service.is_none() {
            ProbeStep::Unreachable
        } else if !is_true(&self.service, "installed") {
            ProbeStep::InstallService
        } else if field(&self.service, "state").and_then(|s| s.as_str()) == Some("running") && self.listening() {
            // `active` from the manager only means the process was started.
            // A server mid-boot, or one that died on EADDRINUSE and is inside
            // its RestartSec window, is `active` with nothing on the port —
            // and opening the window then lands on a connection refused.
            ProbeStep::Ready
        } else {
            ProbeStep::Start
        };
    }

    /// Whether something is actually answering on the resolved port.
    fn listening(&self) -> bool {
        field(&self.status, "listen").and_then(|l| l.get("listening")) == Some(&serde_json::Value::Bool(true))
    }

    /// The origin the main window should load.
    ///
    /// Built from the server's own `APP_BASE_URL` HOST when that host is
    /// loopback, and from the validated port — never from the base URL's own
    /// scheme or port. better-auth derives the passkey rpID from that hostname
    /// and cookie jars are per-host, so opening `127.0.0.1` against a server
    /// configured for `localhost` silently splits the session in two; but the
    /// rest of the URL is config we should not trust into a window that holds
    /// privileged globals.
    pub fn origin(&self) -> Option<String> {
        let listen = self.status.as_ref()?.get("listen")?;
        if listen.get("portValid")? != &serde_json::Value::Bool(true) {
            return None;
        }
        let port = listen.get("port")?.as_u64()?;
        let base = self
            .status
            .as_ref()
            .and_then(|s| s.get("settings")?.get("APP_BASE_URL")?.get("value")?.as_str())
            .unwrap_or("");
        let host = url_host(base)
            .filter(|h| is_loopback(h))
            .unwrap_or_else(|| "127.0.0.1".to_string());
        // Bracket a literal IPv6 host so the result parses as a URL.
        let host = if host.contains(':') { format!("[{host}]") } else { host };
        Some(format!("http://{host}:{port}"))
    }
}

/// Host of an http(s) URL, without pulling in a URL crate for one field.
fn url_host(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    if let Some(v6) = host.strip_prefix('[') {
        return v6.split_once(']').map(|(h, _)| h.to_string());
    }
    Some(host.split(':').next()?.to_string())
}

/// The loopback spellings this app will open a window on.
///
/// Deliberately NARROWER than the server's own `localOriginsFor()`, which also
/// trusts `::1`. `capabilities/main.json` has to name the same origins, and a
/// bracketed IPv6 host is not expressible in the URL patterns Tauri matches —
/// so accepting `[::1]` here produced a window that loaded fine and whose every
/// IPC call was then silently refused: no title-bar handshake, no server pill,
/// no notifications, all with no error anywhere. Falling back to `127.0.0.1`
/// for an IPv6 base URL loses the hostname's cookie jar, which is visible and
/// recoverable, where the alternative was invisible.
pub fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1")
}

/// `<server> <args…>`, or `None` when nothing resolved.
fn server_cmd(server: &Option<ServerBinary>, args: &[&str]) -> Option<Vec<String>> {
    let s = server.as_ref()?;
    let mut cmd = s.argv.clone();
    cmd.extend(args.iter().map(|a| a.to_string()));
    Some(cmd)
}

fn json_of(out: &Run) -> Option<serde_json::Value> {
    out.ok().then(|| serde_json::from_str(out.stdout.trim()).ok()).flatten()
}

static BUNDLED_VERSION: OnceLock<Option<String>> = OnceLock::new();

/// What the shipped binary says it is. Memoized — it cannot change under a
/// running app, and probing it spawns a ~110 MB binary.
fn bundled_version() -> Option<String> {
    BUNDLED_VERSION
        .get_or_init(|| {
            let path = sidecar::bundled_path(&SERVER_SIDECAR)?;
            let out = run(&[path.to_string_lossy().into_owned(), "version".into()], QUERY_TIMEOUT);
            out.ok().then(|| parse_server_version(&out.stdout)).flatten()
        })
        .clone()
}

/// Look at the machine and report what it would take to reach a running server.
///
/// Also the ONE place the tray's enabled state is updated from. Every console
/// refresh and every console action runs this, including the first render at
/// startup, so the tray follows the server without a poll of its own.
#[tauri::command(async)]
pub fn desktop_probe(app: AppHandle, settings: State<'_, SettingsState>) -> Probe {
    let p = probe_now(settings.get().binary_path.as_deref());
    crate::tray::set_server_ready(&app, p.next == ProbeStep::Ready);
    p
}

fn probe_now(configured: Option<&str>) -> Probe {
    let server = server_bin::resolve(configured);
    let managed = match (&server, sidecar::install_path(&SERVER_SIDECAR)) {
        (Some(s), Some(managed_path)) => s.argv.first().map(|p| p.as_str()) == managed_path.to_str(),
        _ => false,
    };
    let mut p = Probe {
        bundled_version: bundled_version(),
        server,
        managed,
        tmux: subshell_desktop_core::shell_env::which("tmux"),
        platform: console_platform().to_string(),
        has_brew: subshell_desktop_core::shell_env::which("brew").is_some(),
        ..Default::default()
    };

    if let Some(cmd) = server_cmd(&p.server, &["status", "--json"]) {
        let out = run(&cmd, QUERY_TIMEOUT);
        p.status = json_of(&out);
        if p.status.is_none() {
            p.error = Some(format!("`status --json` failed: {}", out.detail()));
        }
    }
    if let Some(cmd) = server_cmd(&p.server, &["service", "status", "--json"]) {
        let out = run(&cmd, QUERY_TIMEOUT);
        p.service = json_of(&out);
        if p.service.is_none() && p.error.is_none() {
            p.error = Some(format!("`service status --json` failed: {}", out.detail()));
        }
    }
    p.decide();
    p
}

/// Result of anything that changes the machine — the CLI's own words, verbatim.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
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

/// Materialise the bundled server at `~/.local/bin/subshell-server`.
#[tauri::command(async)]
pub fn desktop_install_server(settings: State<'_, SettingsState>) -> Result<ActionResult, String> {
    install_server_now(&settings)
}

/// `desktop_install_server`'s body, reachable without a command context.
///
/// `desktop_setup` runs this same act as the first step of the chain, and the
/// chain calls the plain function rather than another command's wrapper: the
/// command layer stays argument-poor routing, and the one-press path can
/// never drift from the button that runs the act alone.
fn install_server_now(settings: &SettingsState) -> Result<ActionResult, String> {
    let configured = settings.get().binary_path;
    let version = bundled_version();
    let probe = probe_now(configured.as_deref());
    // Only tear down a service we are actually replacing. Stopping one that
    // points somewhere else would be an outage for no upgrade.
    let stop_target = probe
        .managed
        .then(|| server_cmd(&probe.server, &["service", "stop"]))
        .flatten();
    let stop = || {
        if let Some(cmd) = stop_target {
            let _ = run(&cmd, ACTION_TIMEOUT);
        }
    };
    match sidecar::install_bundled(&SERVER_SIDECAR, version.as_deref(), stop)? {
        sidecar::InstallOutcome::NoSidecar => Err("this build ships no server binary".into()),
        sidecar::InstallOutcome::UpToDate => Ok(ActionResult {
            ok: true,
            stdout: "The bundled server is already installed.".into(),
            stderr: String::new(),
        }),
        sidecar::InstallOutcome::Installed => {
            let where_ = sidecar::install_path(&SERVER_SIDECAR)
                .map(|p| p.display().to_string())
                .unwrap_or_default();
            Ok(ActionResult {
                ok: true,
                stdout: format!("Installed subshell-server to {where_}"),
                stderr: String::new(),
            })
        }
    }
}

/// The whole first-run chain, behind one consented press.
///
/// Install, configure, register as a service, start. Every one of these has a
/// correct default and asks the user nothing they can answer on day one, so
/// the console used to spend four clicks and four form fields executing a plan
/// it had already made.
///
/// **Stops at the first failure.** A half-run leaves the machine in a state
/// the ordinary probe describes, so the console falls back to the step that
/// names it and the user is never worse off than the four-step flow left them.
/// The CLI's own words are returned verbatim; two surfaces that phrase the
/// same refusal differently are two surfaces that drift.
#[tauri::command(async)]
pub fn desktop_setup(settings: State<'_, SettingsState>) -> Result<ActionResult, String> {
    let mut log = String::new();
    for step in [
        SetupStep::InstallServer,
        SetupStep::Init,
        SetupStep::ServiceInstall,
        SetupStep::Start,
    ] {
        let result = step.run(&settings)?;
        log.push_str(&result.stdout);
        log.push('\n');
        if !result.ok {
            // The failure's stderr leaves on the failure channel, not also
            // into the log: the console renders both halves, and the refusal
            // a user most needs to read must appear exactly once.
            return Ok(ActionResult {
                ok: false,
                stdout: log,
                stderr: result.stderr,
            });
        }
        // A success that warned on stderr must not warn on the single-button
        // path and go silent on the one-press one — the chain's contract is
        // the CLI's own words, verbatim.
        if !result.stderr.is_empty() {
            log.push_str(&result.stderr);
            log.push('\n');
        }
    }
    Ok(ActionResult {
        ok: true,
        stdout: log,
        stderr: String::new(),
    })
}

/// The acts `desktop_setup` runs, in order.
///
/// Private: the console drives the individual commands when a machine is
/// already part-way through, and only the fresh run is one press. `run`
/// delegates to each command's extracted body, never to a
/// `#[tauri::command]` wrapper.
enum SetupStep {
    InstallServer,
    Init,
    ServiceInstall,
    Start,
}

impl SetupStep {
    fn run(self, settings: &SettingsState) -> Result<ActionResult, String> {
        match self {
            SetupStep::InstallServer => install_server_now(settings),
            // Derived defaults, not a form payload: empty address fields omit
            // their flags, so `init --yes` falls back to the CLI's own answers
            // (port 3080, all interfaces, base URL derived from the port), and
            // a `None` trusted-origins says nothing rather than clearing the
            // list. This is what the four-step flow wrote on a fresh install
            // where the operator typed nothing.
            SetupStep::Init => Ok(init_now(settings, "", "", "", None)),
            SetupStep::ServiceInstall => Ok(service_now(settings, ServiceCommand::Install, false)),
            // `service install` already starts the server, and `start` on a
            // running service answers "already running" with exit 0
            // (service.ts), so the chain is a straight line rather than a
            // branch that has to know which verb already ran.
            SetupStep::Start => Ok(service_now(settings, ServiceCommand::Start, false)),
        }
    }
}

/// A package install is not a probe. `ACTION_TIMEOUT` is sized for a CLI
/// answering a question; fetching and unpacking a package over a slow link
/// routinely takes minutes, and timing that out mid-write is worse than
/// waiting.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

/// The OS name the console understands: the web convention `installers.js`
/// branches on ("darwin"), not `std::env::consts::OS`'s "macos". The Linux
/// and every other spelling already agrees.
fn console_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    }
}

/// Install tmux with the platform's own package manager.
///
/// Never bundled: see `ui/installers.js` for the accounting. This runs what a
/// user would have run in a terminal, with their own privileges, and reports
/// the manager's own output verbatim — including the fallback to `detail()`
/// when the spawn itself is what failed, so a refused or timed-out install
/// never reads back as an empty success.
#[tauri::command(async)]
pub fn desktop_install_tmux() -> Result<ActionResult, String> {
    let argv = tmux_install_argv().ok_or("no package manager this app can drive")?;
    Ok(run(&argv, INSTALL_TIMEOUT).into())
}

/// The argv that installs tmux here, or None when no manager we can drive is
/// present.
///
/// Mirrors `tmuxInstallPlan` in `ui/installers.js`, which owns the same
/// decision for the rendering side. Two copies because one runs in a webview
/// with no process access and one runs where `which` works, and
/// `the_js_install_table_and_the_rust_one_agree` fails the build when a token
/// this runs is removed or changed in the JS copy (containment, as that test
/// documents). `apt-get` is hardcoded because the only Linux artifact this app
/// ships is the `.deb`, so every machine this reaches is Debian-family; the
/// note in `installers.js` carries the lever if that changes.
fn tmux_install_argv() -> Option<Vec<String>> {
    let argv = match std::env::consts::OS {
        // No package manager we can drive without installing one first, and
        // Homebrew is too large a thing to install on someone's behalf from a
        // setup screen. The console shows the MacPorts line instead.
        "macos" => {
            subshell_desktop_core::shell_env::which("brew")?;
            vec!["brew", "install", "tmux"]
        }
        // pkexec so the user gets their desktop's own password prompt. A bare
        // sudo spawned from a GUI has no terminal to read a password from and
        // hangs until the timeout.
        "linux" => vec!["pkexec", "apt-get", "install", "-y", "tmux"],
        _ => return None,
    };
    Some(argv.into_iter().map(String::from).collect())
}

/// The install script for each built-in agent CLI.
///
/// **The webview sends an ID, never a command.** A command that runs what it
/// is handed is a different security property from one that runs what it
/// ships, and this process is the one that can write to the user's PATH. The
/// list is duplicated from `ui/installers.js` for the same reason it exists
/// there: what this app may EXECUTE has to be changeable only by editing this
/// file, never by anything it reads at runtime. This is the copy that
/// ENFORCES; the JS copy renders, and `the_js_install_table_and_the_rust_one_agree`
/// keeps them in step as far as revocation goes — an id or script REMOVED or
/// CHANGED on either side fails that test. A JS-only ADDition passes it and
/// runs nothing, because only this list executes.
///
/// All five are user-space installers that need no elevation.
const AGENT_INSTALLS: &[(&str, &str)] = &[
    ("claude-code", "curl -fsSL https://claude.ai/install.sh | bash"),
    ("codex", "curl -fsSL https://chatgpt.com/codex/install.sh | sh"),
    (
        "hermes",
        "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
    ),
    ("opencode", "curl -fsSL https://opencode.ai/install | bash"),
    ("pi", "curl -fsSL https://pi.dev/install.sh | sh"),
];

/// Install one built-in agent CLI, by id.
#[tauri::command(async)]
pub fn desktop_install_agent(id: String) -> Result<ActionResult, String> {
    let script = AGENT_INSTALLS
        .iter()
        .find(|(known, _)| *known == id)
        .map(|(_, script)| *script)
        .ok_or_else(|| format!("this app does not install \"{id}\""))?;
    let argv = vec!["sh".to_string(), "-c".to_string(), script.to_string()];
    // `.into()` for the same reason as the tmux install: the installer's own
    // stderr on success is kept, and a failed spawn with nothing on either
    // stream still says what happened rather than answering empty.
    Ok(run(&argv, INSTALL_TIMEOUT).into())
}

/// The `init --yes` argv for one set of console answers.
///
/// Split out of [`desktop_init`] so the assembly is testable without a Tauri
/// app handle — the command itself is then just "resolve the binary, run this".
///
/// Two rules, and they differ per field. `port`/`host`/`base_url`: an empty
/// field must not become an empty flag VALUE, because the CLI refuses one,
/// where OMITTING the flag correctly falls back to its own default (and the
/// base URL to a derivation from the answered port). `trusted_origins`: `None`
/// means "say nothing", `Some("")` means "say none" — the CLI accepts an empty
/// value for that one flag precisely so a list can be cleared, and since a
/// stored value is now every key's default, collapsing the two would make
/// clearing impossible.
fn init_args(port: &str, host: &str, base_url: &str, trusted_origins: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = vec!["init".into(), "--yes".into()];
    for (flag, value) in [("--port", port), ("--host", host), ("--base-url", base_url)] {
        if !value.trim().is_empty() {
            args.extend([flag.to_string(), value.to_string()]);
        }
    }
    if let Some(origins) = trusted_origins {
        args.extend(["--trusted-origins".to_string(), origins.to_string()]);
    }
    args
}

/// `subshell-server init --yes` with the addresses the operator typed.
///
/// The console passes every field it shows, not just the changed ones: it
/// seeds the form from `status --json`, and `configure` now defaults an
/// unflagged key to its STORED value — so an omitted flag means "keep what is
/// on disk", which is not what a form someone just edited means.
#[tauri::command(async)]
pub fn desktop_init(
    settings: State<'_, SettingsState>,
    port: String,
    host: String,
    base_url: String,
    trusted_origins: Option<String>,
) -> ActionResult {
    init_now(&settings, &port, &host, &base_url, trusted_origins.as_deref())
}

/// `desktop_init`'s body, reachable without a command context.
///
/// See [`install_server_now`] for why the body lives below its wrapper;
/// `desktop_setup` calls this with the derived defaults.
fn init_now(
    settings: &SettingsState,
    port: &str,
    host: &str,
    base_url: &str,
    trusted_origins: Option<&str>,
) -> ActionResult {
    let server = server_bin::resolve(settings.get().binary_path.as_deref());
    let args = init_args(port, host, base_url, trusted_origins);
    let Some(cmd) = server_cmd(&server, &args.iter().map(String::as_str).collect::<Vec<_>>()) else {
        return ActionResult {
            ok: false,
            stdout: String::new(),
            stderr: "no subshell-server found".into(),
        };
    };
    run(&cmd, ACTION_TIMEOUT).into()
}

/// The `service` verbs the console may drive.
///
/// A deserialized enum rather than a hand-written allowlist: an unknown verb is
/// then refused by Tauri's own argument handling, before any code here runs.
#[derive(Debug, Clone, Copy, Deserialize)]
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

/// One `service` verb, straight through. The server decides whether to refuse.
#[tauri::command(async)]
pub fn desktop_service(settings: State<'_, SettingsState>, verb: ServiceCommand, force: bool) -> ActionResult {
    service_now(&settings, verb, force)
}

/// `desktop_service`'s body, reachable without a command context.
///
/// See [`install_server_now`] for why the body lives below its wrapper;
/// `desktop_setup` calls this for the install and start steps.
fn service_now(settings: &SettingsState, verb: ServiceCommand, force: bool) -> ActionResult {
    let server = server_bin::resolve(settings.get().binary_path.as_deref());
    let Some(mut cmd) = server_cmd(&server, &["service", verb.as_str()]) else {
        return ActionResult {
            ok: false,
            stdout: String::new(),
            stderr: "no subshell-server found".into(),
        };
    };
    // Only `restart` takes it; the CLI refuses the flag anywhere else.
    if force && matches!(verb, ServiceCommand::Restart) {
        cmd.push("--force".into());
    }
    run(&cmd, ACTION_TIMEOUT).into()
}

/// Remember an explicitly chosen server binary.
///
/// Validated before it is persisted: this path is EXECUTED on every launch, so
/// accepting whatever a file dialog returned would let one mis-click wedge the
/// app on a file that is not a server.
#[tauri::command(async)]
pub fn desktop_set_server_bin(settings: State<'_, SettingsState>, path: Option<String>) -> Result<(), String> {
    let cleaned = match path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
        None => None,
        Some(p) => {
            if !std::path::Path::new(&p).is_absolute() {
                return Err(format!("{p} is not an absolute path"));
            }
            if server_bin::probe_version(std::slice::from_ref(&p)).is_none() {
                return Err(format!(
                    "{p} does not look like a subshell-server — it could not report a version"
                ));
            }
            Some(p)
        }
    };
    settings.update(|s| s.binary_path = cleaned)
}

/// What the console is told when the tray switch cannot be honoured.
///
/// "Detected", not "does not exist": the probe is a false negative on the
/// older XEmbed tray, so the sentence has to be true for a user who can see
/// their own tray icon while reading it.
const NO_TRAY: &str = "no system tray was detected on this desktop, so a hidden window would have nowhere to go";

/// The desktop app's own preferences, for the console to render.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    pub close_to_tray: bool,
    /// Whether the switch is LIVE — the tray probe's answer at this call.
    pub tray_supported: bool,
    /// And when it is not, why.
    ///
    /// The console needs the difference between the two "no"s: `unsupported`
    /// is a fact about the platform and the card is not drawn at all, while
    /// `not-detected` is a fact about this desktop SESSION — so the switch is
    /// drawn disabled, with the reason and a way to look again, because an
    /// absent control explains nothing and a GNOME user can fix this in a
    /// minute.
    pub tray_status: TraySupport,
}

/// Build the payload from the stored settings and one probe answer.
///
/// Both tray fields come from the SAME [`TraySupport`] here, so
/// `tray_supported` cannot disagree with `tray_status`, and the stored
/// preference is clamped on the way out — what the app will ACT on, not what
/// the file happens to say. A switch showing the file's value where the tray
/// is gone would be a switch that lies.
fn settings_view(current: Settings, support: TraySupport) -> DesktopSettings {
    DesktopSettings {
        close_to_tray: effective_close_to_tray(current.close_to_tray, support),
        tray_supported: support.supported(),
        tray_status: support,
    }
}

/// Read the desktop app's own preferences.
#[tauri::command(async)]
pub fn desktop_settings(settings: State<'_, SettingsState>) -> DesktopSettings {
    settings_view(settings.get(), tray_support())
}

/// Choose whether closing the window hides it to the tray.
///
/// Refused, with a reason, where no tray answered — an `Err` rather than a
/// silent `false`, so the console can say why instead of showing a switch that
/// springs back. Turning it OFF is always allowed: that direction can only
/// ever make the window easier to reach.
#[tauri::command(async)]
pub fn desktop_set_close_to_tray(settings: State<'_, SettingsState>, enabled: bool) -> Result<(), String> {
    if enabled && !tray_support().supported() {
        return Err(NO_TRAY.to_string());
    }
    settings.update(|s| s.close_to_tray = enabled)
}

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

/// Longest log tail the console renders. Enough to cover a boot and a restart,
/// small enough that the pane stays a pane rather than a transcript.
const LOG_TAIL_LINES: usize = 200;

/// A tail of the server's own log, for the console's log pane.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogTail {
    /// The lines, oldest first, ready to render. Empty when there is nothing
    /// to show, which is not an error: a server that has never started has no
    /// log, and that is the ordinary state of a machine mid-setup.
    pub text: String,
    /// Where these came from, in words, for the pane to caption itself.
    pub source: String,
    /// Why the tail is empty, when it is. `None` when there is text.
    pub note: Option<String>,
}

/// The last {@link LOG_TAIL_LINES} lines of the server's log.
///
/// **Takes no argument**, deliberately: a path parameter would be an
/// arbitrary-file-read reachable from the page, which is the same reason
/// `desktop_open_path` names a closed enum instead. This side decides what
/// "the server's log" is.
///
/// The two platforms genuinely differ in MECHANISM, not just in path. Linux
/// has no log file at all: the unit's output goes to the journal, so the tail
/// is a `journalctl` query. macOS has a file the plist names, and the CLI is
/// the authority on where (`service status --json` reports `logPath`), so it
/// is asked rather than the path being re-derived here.
///
/// Never an `Err`: every outcome is a caption the pane can render, because a
/// missing log during setup is normal and an error banner for it would train
/// the user to ignore the pane.
#[tauri::command(async)]
pub fn desktop_logs(settings: State<'_, SettingsState>) -> LogTail {
    #[cfg(target_os = "linux")]
    {
        let _ = settings;
        journal_tail()
    }
    #[cfg(not(target_os = "linux"))]
    {
        file_tail(settings.get().binary_path.as_deref())
    }
}

/// The systemd journal for the user unit this app installs.
#[cfg(target_os = "linux")]
fn journal_tail() -> LogTail {
    let source = "the systemd journal".to_string();
    let out = run(
        &[
            "journalctl".into(),
            "--user".into(),
            "-u".into(),
            "subshell-server.service".into(),
            "-n".into(),
            LOG_TAIL_LINES.to_string(),
            "--no-pager".into(),
        ],
        QUERY_TIMEOUT,
    );
    if !out.ok() {
        // A unit that was never installed is the common case here, and the
        // journal says so in its own words rather than failing.
        return LogTail {
            text: String::new(),
            source,
            note: Some(first_line(&out.stderr).unwrap_or_else(|| "the journal could not be read".into())),
        };
    }
    let text = out.stdout.trim_end().to_string();
    let empty = text.is_empty() || text.starts_with("-- No entries");
    LogTail {
        note: empty.then(|| "no entries yet for subshell-server.service".to_string()),
        text: if empty { String::new() } else { text },
        source,
    }
}

/// The log file the installed service definition names.
#[cfg(not(target_os = "linux"))]
fn file_tail(configured: Option<&str>) -> LogTail {
    let probe = probe_now(configured);
    let path = match field(&probe.service, "logPath") {
        Some(serde_json::Value::String(p)) => p.clone(),
        _ => {
            return LogTail {
                text: String::new(),
                source: "the server's log file".to_string(),
                note: Some("no log file yet; the service has not been installed".to_string()),
            }
        }
    };
    match std::fs::read_to_string(&path) {
        Ok(body) => {
            let lines: Vec<&str> = body.lines().collect();
            let tail = lines[lines.len().saturating_sub(LOG_TAIL_LINES)..].join("\n");
            let empty = tail.trim().is_empty();
            LogTail {
                note: empty.then(|| "the log file is empty".to_string()),
                text: if empty { String::new() } else { tail },
                source: path,
            }
        }
        // Not an error: launchd creates the file on first start.
        Err(err) => LogTail {
            text: String::new(),
            source: path,
            note: Some(format!("could not be read: {err}")),
        },
    }
}

/// The first non-empty line of a command's stderr, trimmed.
fn first_line(text: &str) -> Option<String> {
    text.lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_string)
}

/// Open (or focus) the window that shows the server's own UI.
#[tauri::command(async)]
pub fn desktop_open_main(app: AppHandle, settings: State<'_, SettingsState>) -> Result<(), String> {
    let _ = settings;
    open_main_now(&app)
}

/// `desktop_open_main`'s body, reachable without a command context.
///
/// The tray needs the same thing the console's button does, and a tray menu
/// handler has no `State` argument — so the settings are read off the app
/// handle here instead. Kept as one function because the origin must come from
/// a FRESH probe either way: a `configure` can move the port, and a cached
/// origin would open a window pointed at a server that is no longer there.
pub fn open_main_now(app: &AppHandle) -> Result<(), String> {
    let configured = app.state::<SettingsState>();
    let probe = probe_now(configured.get().binary_path.as_deref());
    let origin = probe
        .origin()
        .ok_or_else(|| "the server has not reported a usable base URL yet".to_string())?;
    crate::windows::open_main(app, &origin)
}

/// The files and directories the console may ask to reveal.
///
/// A closed enum, not a path: the page names a member and this side decides
/// what that member is, so there is no argument through which a reveal could
/// be pointed anywhere else — the same shape `apps/client/desktop`'s
/// `node_open_path` uses for the same reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OpenTarget {
    /// The `config.env` path the CLI resolved.
    ConfigEnv,
    /// The directory holding the server binary this app would run.
    ServerDir,
    /// The service definition on disk (the systemd unit / launchd plist).
    ServiceDefinition,
    /// The server's own log file, where the platform has one.
    Logs,
}

/// What to say when there is no log FILE to reveal.
///
/// The reason is platform-specific, so the string is too: the systemd user
/// unit redirects nothing, so on Linux the server's output is in the journal
/// and no file will ever appear; the macOS plist names one and the CLI
/// reports it, so a null there is a server too old to have answered.
const NO_LOG_FILE: &str = if cfg!(target_os = "macos") {
    "the server has not reported a log file yet — update it to a version that names one"
} else {
    "the server logs to the systemd journal on Linux — run `journalctl --user -u subshell-server.service -f`"
};

/// Resolve one target to a path, or explain why there is none.
///
/// Takes the [`Probe`] because every path here is one the CLI already knows:
/// the desktop never re-derives platform paths (the log location moved once
/// already, and a second copy of the rule would have missed it). When the
/// installed server does not know a fact, the console says so rather than
/// guessing it from this side.
pub fn resolve_open_target(target: OpenTarget, probe: &Probe) -> Result<String, String> {
    match target {
        OpenTarget::ConfigEnv => field(&probe.status, "configEnv")
            .and_then(|c| c.get("path"))
            .and_then(|p| p.as_str())
            .map(str::to_string)
            .ok_or_else(|| "the server has not reported its config.env path yet".to_string()),
        OpenTarget::ServerDir => probe
            .server
            .as_ref()
            .and_then(|s| s.argv.first())
            .map(std::path::Path::new)
            .and_then(|p| p.parent())
            .map(|d| d.display().to_string())
            .ok_or_else(|| "no server binary has been found yet".to_string()),
        OpenTarget::ServiceDefinition => match field(&probe.service, "definitionPath") {
            Some(serde_json::Value::String(p)) => Ok(p.clone()),
            // Explicit null is the CLI's own answer: no per-user service
            // manager on this platform, or none installed.
            _ => Err("no service definition is installed on this machine".to_string()),
        },
        OpenTarget::Logs => match field(&probe.service, "logPath") {
            Some(serde_json::Value::String(p)) => Ok(p.clone()),
            // A reported `null` and an absent field are DIFFERENT facts with
            // different fixes: "this platform has no log file" (journal hint)
            // versus "this server build predates the field" (upgrade it).
            // Anything else the field could hold is the second case too —
            // a server that reports garbage about its own paths wants an
            // update, not a reveal of a `true`.
            Some(serde_json::Value::Null) => Err(NO_LOG_FILE.to_string()),
            _ => Err("the installed server does not report its log path — update it".to_string()),
        },
    }
}

/// The address the console shows as the control plane URL, or why there isn't one.
///
/// Read from the server's own `status --json` rather than passed in: the page
/// names the INTENT and this side re-reads the value it is displaying, so a
/// command argument can never send the browser somewhere the user has not
/// already seen on the row. The scheme check is the belt on that braces —
/// this opens a URL, never a path, and never to a `file:`/`mailto:` handler.
pub fn control_plane_url(probe: &Probe) -> Result<String, String> {
    let url = field(&probe.status, "settings")
        .and_then(|s| s.get("APP_BASE_URL"))
        .and_then(|u| u.get("value"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "the server has not reported a base URL yet".to_string())?;
    // Case-insensitive: a scheme is one per RFC 3986, and refusing
    // `HTTP://plane.example` would be a false negative the user experiences
    // as a broken button, not as safety. The value OPENED is still the
    // original — only the test is lowercased.
    let lowered = url.to_ascii_lowercase();
    if !lowered.starts_with("http://") && !lowered.starts_with("https://") {
        return Err(format!("refusing to open a non-http(s) URL: {url}"));
    }
    Ok(url.to_string())
}

/// Reveal one of a fixed set of the server's own files or directories.
#[tauri::command(async)]
pub fn desktop_open_path(app: AppHandle, settings: State<'_, SettingsState>, target: OpenTarget) -> Result<(), String> {
    let probe = probe_now(settings.get().binary_path.as_deref());
    let path = resolve_open_target(target, &probe)?;
    if !std::path::Path::new(&path).exists() {
        return Err(format!("{path} does not exist yet"));
    }
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| format!("could not reveal {path}: {e}"))
}

/// Open the control plane's URL in the SYSTEM browser.
///
/// The in-app `main` window stays the fast path for the usual loopback case;
/// this exists because the row is the configured base URL, which may name a
/// LAN address that window is deliberately never pointed at (see
/// [`Probe::origin`]).
#[tauri::command(async)]
pub fn desktop_open_control_plane(app: AppHandle, settings: State<'_, SettingsState>) -> Result<(), String> {
    let probe = probe_now(settings.get().binary_path.as_deref());
    let url = control_plane_url(&probe)?;
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| format!("could not open {url}: {e}"))
}

/// The tmux formula page — spec §6.1's reading for the plan the console
/// cannot run itself (a Mac without Homebrew). The same string
/// `ui/installers.js` carries as its plans' `docsUrl`, pinned equal to it by
/// `the_js_install_table_and_the_rust_one_agree`.
const TMUX_DOCS_URL: &str = "https://formulae.brew.sh/formula/tmux";

/// Open the tmux formula page in the system browser.
///
/// A command that HOLDS the URL rather than a link whose href the page
/// supplies: the same boundary `desktop_open_control_plane` and
/// `desktop_open_path` keep, applied to a constant for the one surface that
/// needs reading material (the console's CSP makes an ordinary `<a>` open in
/// the webview, which is the wrong window for docs).
#[tauri::command(async)]
pub fn desktop_open_tmux_docs(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(TMUX_DOCS_URL, None::<&str>)
        .map_err(|e| format!("could not open {TMUX_DOCS_URL}: {e}"))
}

/// Show a native notification, and focus the app when it is clicked.
///
/// A dedicated command rather than granting the server-origin page the whole
/// `notification` plugin: this way the shape is ours (one title, one body, no
/// arbitrary payload), and the page cannot schedule, replace or enumerate
/// anything. The web path this replaces is VAPID push through a service
/// worker, which no webview has — `lib/notifications.ts` gates on
/// `PushManager`, so the desktop app would otherwise report "unsupported".
#[tauri::command(async)]
pub fn desktop_notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    // Truncated rather than refused: the source is the SPA's own subshell
    // titles, and a long one should be a short notification, not none.
    let title: String = title.chars().take(120).collect();
    let body: String = body.chars().take(400).collect();
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| format!("could not show a notification: {e}"))
}

/// Open (or focus) the server console. Called from the SPA's own footer.
#[tauri::command(async)]
pub fn desktop_open_console(app: AppHandle) -> Result<(), String> {
    crate::windows::open_console(&app).map(|_| ())
}

/// The SPA has rendered its desktop chrome and the window can lose its title bar.
///
/// The negotiation exists because the chrome ships inside the SERVER's embedded
/// SPA, so a desktop build can meet an instance that has never heard of it.
/// A version floor would have to be kept in step with a release it cannot see;
/// asking the page is a fact rather than a guess, and an old page simply never
/// answers.
#[tauri::command(async)]
pub fn desktop_shell_ready(app: AppHandle, overlay: bool) -> Result<(), String> {
    crate::windows::shell_ready(&app, overlay)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn probe_with(status: Option<serde_json::Value>, service: Option<serde_json::Value>, has_server: bool) -> Probe {
        let mut p = Probe {
            bundled_version: Some("1.8.0".into()),
            server: has_server.then(|| ServerBinary {
                argv: vec!["/x/subshell-server".into()],
                source: server_bin::ServerSource::Path,
                version: Some("1.8.0".into()),
            }),
            managed: true,
            status,
            service,
            ..Default::default()
        };
        p.decide();
        p
    }

    fn configured() -> serde_json::Value {
        json!({"configEnv": {"exists": true}, "settings": {}, "listen": {"portValid": true, "port": 3080, "listening": true}})
    }

    /// The console is the only place these four are typed together, and it
    /// passes ALL of them every time — it seeds from `status --json`, so an
    /// omitted flag would mean "keep whatever is stored", which is not what a
    /// form the user just edited means.
    #[test]
    fn init_args_carry_every_non_empty_field() {
        assert_eq!(
            init_args(
                "3080",
                "0.0.0.0",
                "http://box.local:3080",
                Some("http://box.local:3080")
            ),
            vec![
                "init",
                "--yes",
                "--port",
                "3080",
                "--host",
                "0.0.0.0",
                "--base-url",
                "http://box.local:3080",
                "--trusted-origins",
                "http://box.local:3080",
            ]
        );
    }

    /// An empty field must not become an empty flag VALUE: the CLI refuses one
    /// for these three, where omitting the flag correctly falls back to its own
    /// default (and, for the base URL, to a derivation from the answered port).
    #[test]
    fn init_args_omit_empty_port_host_and_base_url() {
        assert_eq!(init_args("  ", "", "   ", None), vec!["init", "--yes"]);
    }

    /// `--trusted-origins ""` is the ONE emptyable flag, and passing it is how
    /// clearing the list is expressed — `None` (nothing to say) and `Some("")`
    /// (say "none") are different requests and must not collapse.
    #[test]
    fn init_args_pass_an_empty_trusted_origins_as_an_explicit_clear() {
        assert_eq!(
            init_args("", "", "", Some("")),
            vec!["init", "--yes", "--trusted-origins", ""]
        );
        assert_eq!(init_args("", "", "", None), vec!["init", "--yes"]);
    }

    #[test]
    fn with_no_server_the_first_step_is_the_setup_chain() {
        assert_eq!(probe_with(None, None, false).next, ProbeStep::Setup);
    }

    #[test]
    fn a_build_with_no_sidecar_and_no_server_says_so() {
        let mut p = Probe::default();
        p.decide();
        assert_eq!(p.next, ProbeStep::NoServer);
    }

    #[test]
    fn the_probe_names_the_platform_the_way_the_console_branches_on_it() {
        // `installers.js` speaks the web convention ("darwin"); Rust's own
        // `consts::OS` says "macos". A host that ships the wrong spelling
        // shows Mac users the no-button fallback on their commonest path,
        // with no error anywhere — the classic cross-language drift.
        let expected = if cfg!(target_os = "macos") {
            "darwin"
        } else {
            std::env::consts::OS
        };
        assert_eq!(console_platform(), expected);
    }

    #[test]
    fn an_unknown_agent_id_is_refused_rather_than_run() {
        // The refusal happens before any spawn — an id outside the shipped
        // list never reaches a shell.
        assert!(desktop_install_agent("acme-harness".into()).is_err());
    }

    /// The two halves of the install contract speak different languages and
    /// each comment claims the other: `ui/installers.js` decides what the
    /// console SHOWS, `tmux_install_argv` and `AGENT_INSTALLS` here decide
    /// what gets RUN. Nothing else fails if they drift — the warning would
    /// display one command while its own button ran another, on CI that is
    /// green. Text-matching rather than a shared data file: the JS copy is
    /// prose-shaped on purpose (readable, hand-edited), and this is the
    /// price of that shape.
    ///
    /// The pin is CONTAINMENT, Rust into JS, and it is worth being exact
    /// about what that catches: anything either side relies on being REMOVED
    /// or CHANGED in the other fails here (the drift that actually bit), on
    /// the host that ships. An id added JS-side alone is out of scope by
    /// construction — no button names it and Rust refuses it — and the mac
    /// tmux tokens are compared only where they run, since `tmux_install_argv`
    /// answers for the current OS only.
    #[test]
    fn the_js_install_table_and_the_rust_one_agree() {
        let js = include_str!("../../ui/installers.js");
        if let Some(argv) = tmux_install_argv() {
            for token in &argv {
                assert!(
                    js.contains(token.as_str()),
                    "installers.js lost the tmux token {token:?}"
                );
            }
        }
        for (id, script) in AGENT_INSTALLS {
            assert!(js.contains(id), "installers.js lost the agent id {id:?}");
            // The script is the load-bearing half: a drifted URL or shell
            // there is a different install, whatever the id still says.
            assert!(js.contains(script), "installers.js lost the install script for {id:?}");
        }
        // The docs button opens Rust's constant; the JS plans carry the same
        // URL for readers of the table.
        assert!(
            js.contains(TMUX_DOCS_URL),
            "installers.js and the docs command name different pages"
        );
        // And the dialect pair holds on EVERY host, not only where
        // `console_platform`'s mac arm runs: the JS must branch on "darwin",
        // and must not have learned Rust's "macos" spelling.
        assert!(js.contains("\"darwin\""), "installers.js does not branch on darwin");
        assert!(
            !js.contains("\"macos\""),
            "installers.js must not branch on the Rust consts::OS spelling"
        );
    }

    #[test]
    fn tmux_install_never_runs_a_bare_sudo() {
        // A GUI-spawned sudo has no tty to read a password from: it hangs until
        // the timeout rather than failing, which reads to the user as a frozen
        // app. Elevation on Linux goes through pkexec or not at all.
        if let Some(argv) = tmux_install_argv() {
            assert_ne!(argv[0], "sudo");
        }
    }

    #[test]
    fn setup_is_the_entry_step_when_nothing_is_installed() {
        // `install-server` named one act in a four-act chain the console already
        // knew how to compute. The chain is now one consented press, so the step
        // that used to start it is the step that runs it.
        assert_eq!(serde_json::to_string(&ProbeStep::Setup).unwrap(), "\"setup\"");
    }

    // The dangerous one: a binary that runs `version` but whose `status`
    // failed used to read as "unconfigured", which offers `init` — and `init`
    // REWRITES config.env. A transient failure would destroy a working setup.
    #[test]
    fn a_server_that_did_not_answer_is_unreachable_not_unconfigured() {
        let p = probe_with(None, None, true);
        assert_eq!(p.next, ProbeStep::Unreachable);
        assert_ne!(p.next, ProbeStep::Init);
    }

    #[test]
    fn a_service_status_that_did_not_answer_is_also_unreachable() {
        assert_eq!(probe_with(Some(configured()), None, true).next, ProbeStep::Unreachable);
    }

    #[test]
    fn a_server_without_config_needs_init() {
        let p = probe_with(
            Some(json!({"configEnv": {"exists": false}})),
            Some(json!({"installed": false})),
            true,
        );
        assert_eq!(p.next, ProbeStep::Init);
    }

    #[test]
    fn a_configured_server_with_no_service_offers_the_install() {
        let p = probe_with(
            Some(configured()),
            Some(json!({"installed": false, "state": "not-installed"})),
            true,
        );
        assert_eq!(p.next, ProbeStep::InstallService);
    }

    #[test]
    fn an_installed_but_stopped_service_offers_start() {
        let p = probe_with(
            Some(configured()),
            Some(json!({"installed": true, "state": "stopped"})),
            true,
        );
        assert_eq!(p.next, ProbeStep::Start);
    }

    #[test]
    fn a_running_service_is_ready() {
        let p = probe_with(
            Some(configured()),
            Some(json!({"installed": true, "state": "running"})),
            true,
        );
        assert_eq!(p.next, ProbeStep::Ready);
    }

    // The manager saying `active` only means the process was started. A server
    // mid-boot, or one crash-looping inside RestartSec, is `active` with
    // nothing on the port — and opening the window then lands on a refused
    // connection with no explanation.
    #[test]
    fn a_running_unit_with_a_dead_port_is_not_ready() {
        let p = probe_with(
            Some(
                json!({"configEnv": {"exists": true}, "settings": {}, "listen": {"portValid": true, "port": 3080, "listening": false}}),
            ),
            Some(json!({"installed": true, "state": "running"})),
            true,
        );
        assert_eq!(p.next, ProbeStep::Start);
    }

    #[test]
    fn an_unknown_manager_state_is_not_ready() {
        let p = probe_with(
            Some(configured()),
            Some(json!({"installed": true, "state": "unknown"})),
            true,
        );
        assert_eq!(p.next, ProbeStep::Start);
    }

    // Installing to ~/.local/bin cannot change what a service pointing
    // somewhere else runs, so offering the upgrade would repeat forever.
    #[test]
    fn no_upgrade_is_offered_for_a_server_this_app_does_not_manage() {
        let mut p = Probe {
            bundled_version: Some("2.0.0".into()),
            server: Some(ServerBinary {
                argv: vec!["/usr/local/bin/subshell-server".into()],
                source: server_bin::ServerSource::Service,
                version: Some("1.8.0".into()),
            }),
            managed: false,
            ..Default::default()
        };
        p.decide();
        assert_eq!(p.server_choice, ServerChoice::UpToDate);
    }

    #[test]
    fn an_upgrade_is_offered_for_the_managed_copy() {
        let mut p = Probe {
            bundled_version: Some("2.0.0".into()),
            server: Some(ServerBinary {
                argv: vec!["/home/u/.local/bin/subshell-server".into()],
                source: server_bin::ServerSource::LocalBin,
                version: Some("1.8.0".into()),
            }),
            managed: true,
            ..Default::default()
        };
        p.decide();
        assert_eq!(p.server_choice, ServerChoice::UpgradeAvailable);
    }

    #[test]
    fn origin_prefers_the_servers_own_loopback_spelling() {
        let p = probe_with(
            Some(json!({
                "configEnv": {"exists": true},
                "settings": {"APP_BASE_URL": {"value": "http://localhost:3080"}},
                "listen": {"portValid": true, "port": 3080, "listening": true}
            })),
            Some(json!({"installed": true, "state": "running"})),
            true,
        );
        assert_eq!(p.origin().as_deref(), Some("http://localhost:3080"));
    }

    // The port comes from the VALIDATED field, never from the base URL — a
    // config value must not be able to point a privileged window elsewhere.
    #[test]
    fn origin_ignores_the_base_urls_own_port_and_scheme() {
        let p = probe_with(
            Some(json!({
                "configEnv": {"exists": true},
                "settings": {"APP_BASE_URL": {"value": "https://localhost:9999"}},
                "listen": {"portValid": true, "port": 3080, "listening": true}
            })),
            Some(json!({"installed": true, "state": "running"})),
            true,
        );
        assert_eq!(p.origin().as_deref(), Some("http://localhost:3080"));
    }

    #[test]
    fn origin_falls_back_to_loopback_for_a_named_host() {
        let p = probe_with(
            Some(json!({
                "configEnv": {"exists": true},
                "settings": {"APP_BASE_URL": {"value": "http://evil.example.com:3080"}},
                "listen": {"portValid": true, "port": 3080, "listening": true}
            })),
            Some(json!({"installed": true, "state": "running"})),
            true,
        );
        assert_eq!(p.origin().as_deref(), Some("http://127.0.0.1:3080"));
    }

    #[test]
    fn origin_refuses_an_invalid_port_rather_than_guessing() {
        let p = probe_with(
            Some(json!({
                "configEnv": {"exists": true},
                "settings": {"APP_BASE_URL": {"value": "http://localhost:3080"}},
                "listen": {"portValid": false, "port": null}
            })),
            Some(json!({"installed": true, "state": "running"})),
            true,
        );
        assert_eq!(p.origin(), None);
    }

    /// The two capability files, parsed.
    fn grants(file: &str) -> Vec<String> {
        let raw = match file {
            "console" => include_str!("../capabilities/console.json"),
            _ => include_str!("../capabilities/main.json"),
        };
        let v: serde_json::Value = serde_json::from_str(raw).expect("capability file is valid JSON");
        v["permissions"]
            .as_array()
            .expect("permissions is an array")
            .iter()
            .map(|p| p.as_str().expect("permission is a string").to_string())
            .collect()
    }

    /// The REMOTE window's grant list, pinned whole.
    ///
    /// That window loads a page this repo did not ship, so every command it can
    /// reach is reachable by an XSS in the server's SPA. The list is asserted
    /// exactly rather than by absence of specific entries, because the failure
    /// to catch is a command added to it by habit — a test that only forbade
    /// today's names would not see tomorrow's.
    #[test]
    fn the_remote_window_is_granted_only_what_cannot_touch_the_cli() {
        assert_eq!(
            grants("main"),
            vec![
                "core:window:allow-start-dragging",
                "allow-desktop-open-console",
                "allow-desktop-shell-ready",
                "allow-desktop-notify",
            ]
        );
    }

    /// Reading the server's log is a console-only surface.
    ///
    /// It takes no path, so it is not an arbitrary-file read, but it does hand
    /// back the server's own log lines — and the remote window is the one place
    /// whose page we do not control.
    #[test]
    fn only_the_console_may_read_the_logs() {
        assert!(grants("console").contains(&"allow-desktop-logs".to_string()));
        assert!(!grants("main").contains(&"allow-desktop-logs".to_string()));
    }

    // An IPv6 base URL falls back to 127.0.0.1 rather than producing an origin
    // `capabilities/main.json` cannot name — a window whose every IPC call is
    // then silently refused is worse than a split cookie jar.
    #[test]
    fn origin_falls_back_for_an_ipv6_base_url() {
        let p = probe_with(
            Some(json!({
                "configEnv": {"exists": true},
                "settings": {"APP_BASE_URL": {"value": "http://[::1]:3080"}},
                "listen": {"portValid": true, "port": 3080, "listening": true}
            })),
            Some(json!({"installed": true, "state": "running"})),
            true,
        );
        assert_eq!(p.origin().as_deref(), Some("http://127.0.0.1:3080"));
    }

    #[test]
    fn url_host_handles_ipv6_and_userinfo() {
        assert_eq!(url_host("http://[::1]:3080/x").as_deref(), Some("::1"));
        assert_eq!(url_host("http://u:p@example.com:80").as_deref(), Some("example.com"));
        assert_eq!(url_host("http://localhost:3080").as_deref(), Some("localhost"));
    }

    #[test]
    fn loopback_covers_every_spelling_local_origins_trusts() {
        for h in ["localhost", "127.0.0.1"] {
            assert!(is_loopback(h), "{h}");
        }
        assert!(!is_loopback("example.com"));
        // Not expressible in the capability's URL patterns — see is_loopback.
        assert!(!is_loopback("::1"));
    }

    #[test]
    fn probe_steps_serialize_as_kebab_case_for_the_console() {
        assert_eq!(
            serde_json::to_string(&ProbeStep::InstallService).unwrap(),
            "\"install-service\""
        );
        assert_eq!(
            serde_json::to_string(&ProbeStep::Unreachable).unwrap(),
            "\"unreachable\""
        );
    }

    fn stored(close_to_tray: bool) -> Settings {
        Settings {
            binary_path: None,
            close_to_tray,
            open_at_login: false,
            // Subshell Client's field. This app never reads or writes it; it
            // shares the struct, not the file.
            plane_url: None,
        }
    }

    // The clamp is on READ as well as on write, and it is the only guard that
    // survives a settings file arriving from somewhere else — copied from a
    // Mac, or written on a desktop that had a tray before an extension was
    // disabled.
    #[test]
    fn close_to_tray_is_clamped_on_read_not_only_on_write() {
        assert!(settings_view(stored(true), TraySupport::Supported).close_to_tray);
        assert!(!settings_view(stored(true), TraySupport::NotDetected).close_to_tray);
        assert!(!settings_view(stored(true), TraySupport::Unsupported).close_to_tray);
        assert!(!settings_view(stored(false), TraySupport::Supported).close_to_tray);
    }

    // The console branches on both fields, so they must come from one answer:
    // `traySupported` says whether the switch is live, `trayStatus` says
    // whether an absent tray is worth explaining.
    #[test]
    fn the_settings_payload_reports_whether_and_why() {
        for (support, supported, status) in [
            (TraySupport::Supported, true, "supported"),
            (TraySupport::NotDetected, false, "not-detected"),
            (TraySupport::Unsupported, false, "unsupported"),
        ] {
            let view = settings_view(stored(false), support);
            assert_eq!(view.tray_supported, supported);
            let json = serde_json::to_value(&view).unwrap();
            assert_eq!(json["traySupported"], json!(supported));
            assert_eq!(json["trayStatus"], json!(status));
        }
    }

    // A refusal the console can show, and one that does not claim the tray is
    // absent — only that none was detected.
    #[test]
    fn the_tray_refusal_says_detected() {
        assert!(NO_TRAY.contains("detected"));
    }

    // The reveal targets each read the CLI's own reported fact. A typo in a
    // key path here fails SILENTLY at the type level — every field is
    // `serde_json::Value` — and surfaces as "not reported yet" on a machine
    // where the fact exists, so the happy paths are pinned as hard as the
    // refusals.
    #[test]
    fn reveal_targets_resolve_the_paths_the_cli_reported() {
        let p = probe_with(
            Some(json!({"configEnv": {"path": "/c/config.env", "exists": true}, "settings": {}})),
            Some(json!({"definitionPath": "/s/dev.subshell.server.plist", "logPath": "/l/server.log"})),
            true,
        );
        assert_eq!(resolve_open_target(OpenTarget::ConfigEnv, &p).unwrap(), "/c/config.env");
        assert_eq!(resolve_open_target(OpenTarget::ServerDir, &p).unwrap(), "/x");
        assert_eq!(
            resolve_open_target(OpenTarget::ServiceDefinition, &p).unwrap(),
            "/s/dev.subshell.server.plist"
        );
        assert_eq!(resolve_open_target(OpenTarget::Logs, &p).unwrap(), "/l/server.log");
    }

    #[test]
    fn a_target_with_no_reported_path_explains_itself() {
        let p = probe_with(None, None, false);
        assert!(resolve_open_target(OpenTarget::ConfigEnv, &p).is_err());
        assert!(resolve_open_target(OpenTarget::ServerDir, &p).is_err());
        assert!(resolve_open_target(OpenTarget::ServiceDefinition, &p).is_err());
        // Absent field is the UPGRADE message, not the journalctl one — the
        // two nulls mean different things and the user's next action differs.
        let err = resolve_open_target(OpenTarget::Logs, &p).unwrap_err();
        assert!(err.contains("update"), "{err}");
    }

    // The Linux case: the CLI ANSWERS with a null because the journal holds
    // the output. The answer must name the command, not a missing file.
    #[test]
    fn a_reported_null_log_path_answers_with_the_hint() {
        let p = probe_with(None, Some(json!({"definitionPath": null, "logPath": null})), true);
        let err = resolve_open_target(OpenTarget::Logs, &p).unwrap_err();
        assert!(err == NO_LOG_FILE, "{err}");
    }

    // The page never passes a URL, but the guard is the last thing between a
    // config value and the OS handler list, so it is pinned as data.
    #[test]
    fn the_control_plane_url_must_be_http_or_https() {
        let with =
            |v: serde_json::Value| probe_with(Some(json!({"settings": {"APP_BASE_URL": {"value": v}}})), None, true);
        assert_eq!(
            control_plane_url(&with(json!("https://plane.example"))).unwrap(),
            "https://plane.example"
        );
        assert!(control_plane_url(&with(json!("file:///etc/passwd"))).is_err());
        assert!(control_plane_url(&with(json!("javascript:alert(1)"))).is_err());
        assert!(control_plane_url(&with(json!("x"))).is_err());
        // Schemes are case-insensitive per RFC 3986; the refusal of
        // `HTTP://…` would be a broken button, not safety. The ORIGINAL —
        // not the lowercased test copy — is what is returned.
        assert_eq!(
            control_plane_url(&with(json!("HTTP://Plane.Example"))).unwrap(),
            "HTTP://Plane.Example"
        );
        assert!(control_plane_url(&probe_with(None, None, true)).is_err());
    }

    // The wire spelling the console page sends, pinned because the enum is
    // private to Rust and a kebab-case drift is a runtime rejection only.
    #[test]
    fn open_targets_deserialize_the_pages_wire_names() {
        for (raw, want) in [
            ("config-env", OpenTarget::ConfigEnv),
            ("server-dir", OpenTarget::ServerDir),
            ("service-definition", OpenTarget::ServiceDefinition),
            ("logs", OpenTarget::Logs),
        ] {
            let got: OpenTarget = serde_json::from_str(&json!(raw).to_string()).unwrap();
            assert_eq!(got, want, "{raw}");
        }
        assert!(serde_json::from_str::<OpenTarget>(&json!("home").to_string()).is_err());
    }
}
