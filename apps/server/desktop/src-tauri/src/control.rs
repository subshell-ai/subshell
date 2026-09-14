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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

use subshell_desktop_core::legal;
use subshell_desktop_core::proc::{run, run_streaming, LineSink, Run, ACTION_TIMEOUT, QUERY_TIMEOUT};
use subshell_desktop_core::settings::{SettingsState, Supervision};
use subshell_desktop_core::sidecar;
use subshell_desktop_core::tray::{effective_close_to_tray, tray_support};

use crate::server_bin::{self, decide_server, parse_server_version, ServerBinary, ServerChoice, SERVER_SIDECAR};
use crate::supervisor;

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
    /// Whether this app has ever watched a server on this machine reach
    /// `ready`. Boot branches on it (after marking, via `boot_window`), and
    /// the page reads it off the probe rather than owning a second source.
    pub onboarded: bool,
    /// The machine's hostname: the string the reset screen shows, asks to be
    /// typed, and compares against — one memoized read, so displayed and
    /// checked values cannot drift (spec § 7.1, R15).
    pub hostname: String,
    /// Who runs the server here, AFTER the disk-wins correction.
    ///
    /// Never the stored preference alone: see [`effective_supervision`]. The
    /// page branches on this rather than asking for the setting, so the two
    /// cannot disagree about a machine whose service was installed from a
    /// terminal.
    pub supervision: Supervision,
    /// The app's own child, when it is the one running the server.
    ///
    /// `None` in service mode and before the app has spawned anything, which
    /// are different facts with the same rendering — the step says which.
    pub supervisor: Option<SupervisorReport>,
}

/// What the app's own supervisor is doing, for the assistant to render.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorReport {
    /// The live child's pid, `None` between a crash and the respawn.
    pub pid: Option<u32>,
    /// One sentence about the last exit, `None` when nothing has exited yet.
    pub last_exit: Option<String>,
    /// Where this child's console output is being collected.
    pub console_log: String,
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
            onboarded: false,
            hostname: String::new(),
            supervision: Supervision::Service,
            supervisor: None,
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
        } else if self.supervision == Supervision::App {
            // The app runs the server here, so there is no service to install
            // and no manager to ask: the port is the whole question. Without
            // this branch `!installed` below would send an app-mode machine to
            // InstallService forever — the assistant would nag to install the
            // very thing the operator declined, `mark_onboarded` would never
            // fire, and boot would never open the dashboard.
            if self.listening() {
                ProbeStep::Ready
            } else {
                ProbeStep::Start
            }
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
        self.origin_with(dev_spa_origin().as_deref())
    }

    /// [`Probe::origin`] with the dev override passed IN rather than read from
    /// the environment.
    ///
    /// Split so the tests never set a process-wide variable: cargo runs tests
    /// in parallel across modules, and an env var one test sets is read by
    /// another test's `origin()` on a different thread. That is not a
    /// hypothetical — it is what the first version of these tests did, and it
    /// broke `watch::tests` two modules away.
    fn origin_with(&self, dev: Option<&str>) -> Option<String> {
        let listen = self.status.as_ref()?.get("listen")?;
        if listen.get("portValid")? != &serde_json::Value::Bool(true) {
            return None;
        }
        // AFTER the readiness check, deliberately: the override changes WHERE
        // the dashboard window points, never whether there is a server worth
        // pointing it at. A window opened at the SPA's dev server with nothing
        // behind the proxy is a page of failed requests, which is a worse dev
        // experience than the recovery screen that would otherwise show.
        if let Some(dev) = dev {
            return Some(dev.to_string());
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

/// A DEV-ONLY substitute for the dashboard window's address.
///
/// **Why this exists.** `tauri dev` gives the bundled assistant page real HMR
/// — `devUrl` points at its own Vite server — but the dashboard window loads
/// the RUNNING SERVER's origin, and that server is the installed
/// `subshell-server` binary serving the SPA embedded in it at build time. So
/// an edit anywhere in `apps/server/web` reaches that window not slowly but
/// NOT AT ALL, until the SPA is rebuilt, embedded into a new binary, installed
/// and restarted. Pointing the window at the SPA's own Vite server instead
/// (`http://localhost:5174`, which proxies `/api` and `/ws` to the real
/// server) is what makes the dashboard editable in the app at all.
///
/// Applied inside [`Probe::origin`] rather than at the `open_main` call sites,
/// because `watch.rs` compares the window's current URL against this same
/// answer and navigates when they differ — an override the watcher did not
/// know about would be dragged back to the server's own port on the next tick.
///
/// **It cannot exist in a release build.** `debug_assertions` is off there, so
/// this returns `None` before reading the environment at all; a variable left
/// set in a user's shell reaches nothing. The value is still required to be a
/// loopback http origin, and `open_main` re-checks that independently.
#[cfg(not(test))]
fn dev_spa_origin() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let raw = std::env::var("SUBSHELL_DESKTOP_SPA_URL").ok();
    let chosen = dev_spa_origin_from(raw.as_deref())?;
    // ONCE per process, not once per call. `watch.rs` asks every five
    // seconds for the life of the session, so printing on each one buried the
    // disclosure under ~720 identical lines an hour, interleaved with Vite's
    // own output — a line repeated that often is read as noise, which is the
    // opposite of saying it out loud.
    static ANNOUNCED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    if ANNOUNCED.set(()).is_ok() {
        eprintln!("subshell: dev override — opening the dashboard at {chosen} instead of the server's own address");
    }
    Some(chosen)
}

/// **Test builds read no environment at all.**
///
/// The variable is process-wide, and five tests reach this through
/// `Probe::origin` / `origin_changed` — so exporting it, which
/// `apps/server/desktop/AGENTS.md` documents as the way to use a non-default
/// port, made `cargo test` fail in five places with no connection to anything
/// the developer had changed. Removing the WRITER from the tests was half the
/// fix; this removes the reader, which retires the class rather than the two
/// instances. `dev_spa_origin_from` still carries the validation coverage.
#[cfg(test)]
fn dev_spa_origin() -> Option<String> {
    None
}

/// The validation half of {@link dev_spa_origin}, with no environment in it.
///
/// Loopback http only. The dashboard window holds privileged globals, and a
/// convenience for developers is not the place to widen where those may be
/// served from — `open_main` refuses a non-loopback origin independently, so
/// this agreeing with it is belt and braces rather than the only gate.
fn dev_spa_origin_from(raw: Option<&str>) -> Option<String> {
    // Parsed with the SAME parser the webview will use, and reduced to an
    // actual origin. The hand-rolled `url_host` disagreed with WHATWG on
    // inputs like `http://evil.com\@localhost:5174/` — it read the host as
    // `localhost` where `Url` reads `evil.com` — so the two checks could
    // differ about what a value even was. `open_main` refused that one, which
    // made the outcome safe and the comment here wrong: it was not "belt and
    // braces", it was the only correct gate. Now they agree by construction.
    //
    // `Url::origin()` also drops any path, query or fragment, so this returns
    // an origin rather than whatever was typed — which is what the name says
    // and what `watch.rs` needs in order to compare.
    let url: tauri::Url = raw?.trim().parse().ok()?;
    if url.scheme() != "http" {
        return None;
    }
    if !url.host_str().map(is_loopback).unwrap_or(false) {
        return None;
    }
    Some(url.origin().ascii_serialization())
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
pub(crate) fn bundled_version() -> Option<String> {
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
/// The one writer of `onboarded`: the first probe that sees `ready` marks
/// the flag, which is the whole marking rule (spec § 4) — one function
/// ([`mark_onboarded`]) with this command and [`boot_probe`] as its callers,
/// and `probe_now` itself untouched and still pure.
#[tauri::command(async)]
pub fn desktop_probe(app: AppHandle, settings: State<'_, SettingsState>) -> Probe {
    let mut p = probe_now(settings.get().binary_path.as_deref(), settings.get().supervision);
    p.hostname = machine_hostname();
    p.onboarded = settings.get().onboarded;
    if p.next == ProbeStep::Ready && !p.onboarded {
        mark_onboarded(p.next, &settings);
        p.onboarded = true;
    }
    attach_supervisor(&app, &mut p);
    // The disk may have corrected the preference (a service installed from a
    // terminal); write that back so one probe settles it rather than every
    // probe re-deciding it. Same single-writer shape as `mark_onboarded`.
    if p.supervision != settings.get().supervision {
        let corrected = p.supervision;
        let _ = settings.update(|s| s.supervision = corrected);
        // And if the correction took the machine OUT of app mode while this
        // app's own child is still running, stop it. Two servers racing for
        // one port is the immediate damage; the durable damage is that every
        // verb now routes to the CLI, so nothing in the UI can reach the
        // child again — and a reset from that state would take the
        // `service_now(Stop)` branch and begin deleting the database out from
        // under a live process.
        if corrected == Supervision::Service {
            // The spawner, not the pid: during the respawn window the pid is
            // None while the loop still wants a server, and skipping the stop
            // there leaves a child racing the service for the port.
            let sup = app.state::<supervisor::Supervisor>();
            if let Some(spawner) = sup.spawner() {
                if !sup.stop(spawner.as_ref()) {
                    p.error = Some(
                        "A service is installed here, but the server this app started would not stop. \
                         Two servers may be contending for the port."
                            .into(),
                    );
                }
            }
        }
    }
    p
}

/// Attach what the app's own supervisor is doing, in app mode only.
///
/// In service mode there is nothing to report and `None` says so. The last
/// exit is turned into a sentence HERE rather than on the page, so the
/// recovery screen renders a fact the Rust side owns — and a crash loop reads
/// as a crash loop instead of a bare "Stopped".
pub(crate) fn attach_supervisor(app: &AppHandle, p: &mut Probe) {
    if p.supervision != Supervision::App {
        return;
    }
    let snap = app.state::<supervisor::Supervisor>().snapshot();
    // `last_exit_sentence` answers `None` for an exit the app ASKED for and
    // for one older than the window — so a server the user stopped is never
    // reported as a fault, and a crash an hour ago on a machine fine since is
    // history rather than a diagnosis. Both were missing, and between them
    // they turned this crash-loop signal into noise.
    let last_exit =
        supervisor::last_exit_sentence(snap.last_exit, std::time::SystemTime::now(), supervisor::RESPAWN_DELAY);
    if p.error.is_none() && p.next != ProbeStep::Ready {
        p.error = last_exit.clone();
    }
    p.supervisor = Some(SupervisorReport {
        pid: snap.pid,
        last_exit,
        console_log: console_log_path().display().to_string(),
    });
}

/// The machine's hostname, read once per process. `libc::gethostname` was
/// declined (libc is no direct dependency of either crate; spec § 7.1), and
/// `hostname(1)` is one bounded spawn through the discipline every other
/// subprocess already uses. Memoized because a running machine does not
/// rename itself, and the memo is the SINGLE source: the value the reset
/// screen displays and the value `desktop_reset` compares are the same read
/// by construction (R15), so a mid-session rename surfaces next launch
/// rather than as an instruction that cannot be followed. An empty return
/// is a failed read, never a name: consent compares against it only after
/// refusing it.
pub fn machine_hostname() -> String {
    // Moved to `subshell_desktop_core::reset_guards` (2026-09-12) when Subshell
    // Client's reset needed the same memo: it is the value `consent_granted` is
    // compared against, and two copies of a fail-closed rule is one copy that
    // can drift open. Kept as a named re-export here because this module is
    // where the rest of this app reaches for it.
    subshell_desktop_core::reset_guards::machine_hostname()
}

/// Mark `onboarded` once a probe has seen `ready`. One function by name
/// (spec R16), called by `desktop_probe` and `boot_probe`, never by
/// `probe_now`. A failed write is survivable by design: the cost is opening
/// the wizard once more on next boot, and the wizard renders a ready machine
/// as facts already met within one Continue.
pub fn mark_onboarded(next: ProbeStep, settings: &SettingsState) {
    if next != ProbeStep::Ready || settings.get().onboarded {
        return;
    }
    let _ = settings.update(|s| s.onboarded = true);
}

/// How long boot waits for an app-run server to bind before choosing a window.
///
/// `spawn` returns when the process exists; the window choice needs the PORT.
/// Five seconds covers an ordinary cold start, and a server slower than that
/// lands on the recovery screen rather than being waited for indefinitely —
/// where Start is idempotent and the last exit is on screen.
const BOOT_START_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

/// Poll the machine until the app-run server answers, or the grace expires.
pub fn wait_for_boot(app: &AppHandle, settings: &SettingsState) -> Probe {
    let deadline = std::time::Instant::now() + BOOT_START_GRACE;
    loop {
        let mut p = boot_probe(settings);
        attach_supervisor(app, &mut p);
        if p.next == ProbeStep::Ready || std::time::Instant::now() >= deadline {
            return p;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

/// Boot's probe: look at the machine, mark what it proves, return the answer
/// the window choice is made from. The write-in-read is deliberate — it is
/// what lets a CLI-provisioned machine skip the wizard (spec § 4).
pub fn boot_probe(settings: &SettingsState) -> Probe {
    let mut p = probe_now(settings.get().binary_path.as_deref(), settings.get().supervision);
    p.hostname = machine_hostname();
    p.onboarded = settings.get().onboarded;
    mark_onboarded(p.next, settings);
    if p.next == ProbeStep::Ready {
        p.onboarded = true;
    }
    p
}

/// Which window boot opens, as a pure decision over the POST-MARK probe.
/// Never call this on the stored flag alone: that is the R6 bug (a
/// CLI-provisioned machine would meet an assistant it has nothing to do with).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowChoice {
    Wizard,
    Main,
}

/// Ready → the dashboard; anything else → the assistant, whose page picks
/// first-run or recovery screens by `onboarded` (spec 2026-09-12 § 5.2).
pub fn boot_window(p: &Probe) -> WindowChoice {
    if p.next == ProbeStep::Ready {
        WindowChoice::Main
    } else {
        WindowChoice::Wizard
    }
}

/// THE opener every tray item, Dock reopen, single-instance relaunch, menu
/// fallback and SPA pill goes through: a fresh probe, then the dashboard if
/// the server is ready, else the assistant. One function, so no two openers
/// can disagree about which window this machine gets (spec § 5.5).
pub fn open_home(app: &AppHandle) -> Result<(), String> {
    let settings = app.state::<SettingsState>();
    let p = probe_now(settings.get().binary_path.as_deref(), settings.get().supervision);
    if p.next == ProbeStep::Ready {
        // Idempotent by construction (`mark_onboarded` returns early on a
        // flag already set), so this is the same single-writer rule the boot
        // probe follows rather than a second one.
        mark_onboarded(p.next, &settings);
        open_main_now(app)
    } else {
        crate::windows::open_assistant(app).map(|_| ())
    }
}

/// One full look at the machine: binary ladder, `status --json`, service
/// state, and the decision `decide()` draws from them.
///
/// `pub(crate)` for `reset::arm_and_raise`, which re-reads at press time so
/// the stashed delete plan is a fresh fact and not a page's cached value
/// (spec R18).
pub(crate) fn probe_now(configured: Option<&str>, stored: Supervision) -> Probe {
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
    // The DISK decides, not the stored preference — see `effective_supervision`.
    p.supervision = effective_supervision(stored, service_installed(&p.service));
    p.decide();
    p
}

/// Who is really running the server here.
///
/// **A definition on disk outranks the stored preference**, and that is the
/// whole rule. Someone can install a service from a terminal on a machine
/// this app last set to app mode; if the preference won, the app would
/// believe it owned a process it never spawned — and would stop it on quit,
/// taking down a server the operator had just arranged to be permanent.
///
/// The reverse needs no rule: with nothing installed, the preference is the
/// only fact there is.
///
/// `installed` is `None` when the service manager would not answer, which is
/// not evidence of absence — the preference stands there rather than flipping
/// a machine's mode on a `launchctl` hiccup.
pub fn effective_supervision(stored: Supervision, installed: Option<bool>) -> Supervision {
    match installed {
        Some(true) => Supervision::Service,
        _ => stored,
    }
}

/// `service status --json`'s `installed`, or `None` when it did not answer.
fn service_installed(service: &Option<serde_json::Value>) -> Option<bool> {
    field(service, "installed")?.as_bool()
}

/// Set while a native action (setup, a service verb, an install, a reset) is
/// running.
///
/// The watch thread reads it and skips its tick: a probe taken mid-chain
/// reports a half state — a service uninstalled but not yet reinstalled, a
/// binary replaced but not yet started — and acting on that (re-pointing the
/// dashboard, say) is worse than waiting five seconds. It is the same rule
/// the console page's own poll followed with `state.busy`, moved to where the
/// poll now lives.
pub static ACTION_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// RAII holder for [`ACTION_IN_FLIGHT`].
///
/// A guard rather than a set/clear pair because every one of these commands
/// has early returns and `?`s in it, and a flag left set by an early exit
/// stops the watch thread for the rest of the session — silently, since
/// nothing about the app would look wrong.
pub struct ActionGuard {
    /// Whether THIS guard is the one that took the flag from false.
    ///
    /// `Drop` used to clear unconditionally, which quietly undid `try_new`'s
    /// whole point: the assistant's [`ActionGuard::new`] takes the flag even
    /// when one is already held, and dropping that second guard released a
    /// flag the FIRST holder was still relying on — after which a fresh
    /// `try_new` succeeded beside a chain that was still uninstalling a
    /// service. A guard that did not acquire does not release.
    owned: bool,
}

impl ActionGuard {
    pub fn new() -> Self {
        // Still unconditional as a SET — the assistant may always proceed —
        // but it records whether it was the one that flipped it.
        let owned = ACTION_IN_FLIGHT
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();
        ActionGuard { owned }
    }

    /// Take the flag only if no action is already running.
    ///
    /// **This is a refusal, not a lock, and the difference is deliberate.**
    /// Blocking would be the obvious fix and is the wrong one here: these are
    /// `#[tauri::command(async)]` bodies doing synchronous CLI work, so a
    /// caller that spammed them would park one executor thread per call and
    /// take the app down instead of the server.
    ///
    /// It exists because `desktop_set_supervision` is reachable from the
    /// SERVED page (`capabilities/main.json`), and that page is the one whose
    /// contents this repo does not control. One call from an XSS there flips
    /// the machine between supervisors, which is the accounted-for cost in
    /// `docs/security.md`. A HUNDRED concurrent calls were something else: the
    /// chain uninstalls a service, writes a setting and installs another, and
    /// interleaved copies of that can leave a machine with no definition and
    /// no running server, needing a hand to repair. `ACTION_IN_FLIGHT` looked
    /// like it prevented that and never did — it is a hint for the watch
    /// thread, and `Drop` clears it even when a second action is still
    /// running.
    ///
    /// The assistant's own commands keep [`ActionGuard::new`]: its page
    /// serializes its presses through one action runner, and a refusal there
    /// would be a new failure mode on the surface that repairs a broken
    /// machine.
    pub fn try_new() -> Option<Self> {
        // `compare_exchange`, not load-then-store: two callers that both read
        // false would both proceed, which is the race this is here to close.
        ACTION_IN_FLIGHT
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
            .then_some(ActionGuard { owned: true })
    }
}

impl Default for ActionGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for ActionGuard {
    fn drop(&mut self) {
        // Only the acquirer releases — see `owned`.
        if self.owned {
            ACTION_IN_FLIGHT.store(false, Ordering::SeqCst);
        }
    }
}

/// Result of anything that changes the machine — the CLI's own words, verbatim.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

/// What [`desktop_set_supervision`] answers: the chain's words, plus what the
/// machine turned out to be in when it finished.
///
/// A type of its own rather than two more fields on `ActionResult`, which
/// eight other commands share and for which "which supervision mode" means
/// nothing. Flattened on the wire, so a caller that only wants the words
/// still reads an `ActionResult`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisionResult {
    /// The chain's own report
    #[serde(flatten)]
    pub result: ActionResult,
    /// The mode this machine is in NOW — `"service"` or `"app"`, re-read
    /// after the chain rather than echoed back from the request.
    pub mode: &'static str,
    /// True when the machine was already in the requested state, so nothing
    /// ran. Distinct from failure, and distinct from success: the page has to
    /// say "nothing to change" rather than close on a switch that never moved.
    pub noop: bool,
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
    let _guard = ActionGuard::new();
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
    let probe = probe_now(configured.as_deref(), settings.get().supervision);
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
///
/// The four address fields exist for the wizard's Run step (spec § 5): all
/// absent is today's derived-defaults chain byte for byte, and present values
/// map through the same `init_args` as `desktop_init`, so one argv assembly
/// serves both entry points. Empty-string vs absent keeps `init_args`'
/// existing per-field rules.
#[tauri::command(async)]
pub fn desktop_setup(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    port: Option<String>,
    host: Option<String>,
    base_url: Option<String>,
    trusted_origins: Option<String>,
    supervision: Option<SetupSupervision>,
) -> Result<ActionResult, String> {
    let _guard = ActionGuard::new();
    let addresses = SetupAddresses {
        port: port.unwrap_or_default(),
        host: host.unwrap_or_default(),
        base_url: base_url.unwrap_or_default(),
        trusted_origins,
    };
    // Absent means today's chain, byte for byte: a caller that predates the
    // checkboxes — or a person who pressed Set Up without reading — gets a
    // background service that starts at login.
    let SetupSupervision { background, autostart } = supervision.unwrap_or_default();
    let mut log = String::new();
    let steps: &[SetupStep] = if background {
        &[
            SetupStep::InstallServer,
            SetupStep::Init,
            SetupStep::ServiceInstall,
            SetupStep::Start,
        ]
    } else {
        &[SetupStep::InstallServer, SetupStep::Init, SetupStep::RunWithApp]
    };
    for step in steps.iter().copied() {
        let result = step.run(&app, &settings, &addresses, autostart)?;
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
#[derive(Clone, Copy)]
enum SetupStep {
    InstallServer,
    Init,
    ServiceInstall,
    Start,
    /// Hand the server to this app instead of a service manager.
    RunWithApp,
}

/// The two supervision answers the setup screen collects.
///
/// One struct rather than two arguments because they travel together, mean
/// nothing apart (login is meaningless without a service to start), and the
/// page already holds them as one value. The default is today's chain —
/// a background service, armed for login — so a caller that sends nothing,
/// or one older than the checkboxes, gets exactly what it always got.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupSupervision {
    pub background: bool,
    pub autostart: bool,
}

impl Default for SetupSupervision {
    fn default() -> Self {
        SetupSupervision {
            background: true,
            autostart: true,
        }
    }
}

/// The addresses `desktop_setup`'s Init step may carry. Empty strings for
/// `port`/`host`/`base_url` mean "omit the flag, let the CLI derive";
/// `trusted_origins` keeps `init_args`' None-vs-Some("") distinction.
struct SetupAddresses {
    port: String,
    host: String,
    base_url: String,
    trusted_origins: Option<String>,
}

impl SetupStep {
    fn run(
        self,
        app: &AppHandle,
        settings: &SettingsState,
        a: &SetupAddresses,
        autostart: bool,
    ) -> Result<ActionResult, String> {
        match self {
            SetupStep::InstallServer => install_server_now(settings),
            // Derived defaults unless the wizard's Addresses step collected
            // edits: empty address fields omit their flags, so `init --yes`
            // falls back to the CLI's own answers (port 3080, all interfaces,
            // base URL derived from the port), and a `None` trusted-origins
            // says nothing rather than clearing the list. This is what the
            // four-step flow wrote on a fresh install where the operator
            // typed nothing.
            SetupStep::Init => Ok(init_now(
                settings,
                &a.port,
                &a.host,
                &a.base_url,
                a.trusted_origins.as_deref(),
            )),
            SetupStep::ServiceInstall => Ok(install_service_now(settings, autostart)),
            // `service install` already starts the server, and `start` on a
            // running service answers "already running" with exit 0
            // (service.ts), so the chain is a straight line rather than a
            // branch that has to know which verb already ran.
            SetupStep::Start => Ok(service_now(settings, ServiceCommand::Start, false)),
            // The setting is written BEFORE the spawn, so a crash between the
            // two leaves a machine that knows what it is — the next launch
            // starts the child rather than looking for a service nobody
            // installed.
            SetupStep::RunWithApp => {
                settings.update(|s| s.supervision = Supervision::App)?;
                let spawner = server_spawner(app)?;
                app.state::<supervisor::Supervisor>().start(spawner);
                Ok(ActionResult {
                    ok: true,
                    stdout: "subshell-server is running with this app.".into(),
                    stderr: String::new(),
                })
            }
        }
    }
}

/// `service install`, with or without the login arming.
///
/// Separate from `service_now` because this is the one verb that takes a
/// flag the others must never receive: the CLI refuses `--no-autostart`
/// anywhere else, exactly as it refuses `--force` outside `restart`.
fn install_service_now(settings: &SettingsState, autostart: bool) -> ActionResult {
    let server = server_bin::resolve(settings.get().binary_path.as_deref());
    let Some(mut cmd) = server_cmd(&server, &["service", "install"]) else {
        return ActionResult {
            ok: false,
            stdout: String::new(),
            stderr: "no subshell-server found".into(),
        };
    };
    if !autostart {
        cmd.push("--no-autostart".into());
    }
    run(&cmd, ACTION_TIMEOUT).into()
}

/// A package install is not a probe. `ACTION_TIMEOUT` is sized for a CLI
/// answering a question; fetching and unpacking a package over a slow link
/// routinely takes minutes, and timing that out mid-write is worse than
/// waiting.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

/// The OS name the console understands: the web convention `installers.ts`
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
/// Never bundled: see `ui/src/lib/installers.ts` for the accounting. This runs what a
/// user would have run in a terminal, with their own privileges, and reports
/// the manager's own output verbatim — including the fallback to `detail()`
/// when the spawn itself is what failed, so a refused or timed-out install
/// never reads back as an empty success.
/// The event each output line is emitted on while tmux installs.
///
/// Named here rather than inline because the page listens for this exact
/// string and nothing else connects the two.
pub const INSTALL_LINE_EVENT: &str = "desktop-install-line";

#[tauri::command(async)]
pub fn desktop_install_tmux(app: AppHandle) -> Result<ActionResult, String> {
    let _guard = ActionGuard::new();
    let argv = tmux_install_argv().ok_or("no package manager this app can drive")?;
    // STREAMED, unlike every other action here, because this one's wait is
    // the user experience: `brew install` on a cold cache runs for minutes
    // under a 10-minute deadline, and a screen that says nothing for that
    // long cannot be told apart from a hung one. The manager's own output is
    // the only real progress signal — there is no percentage to invent.
    //
    // Emitted to the whole app rather than one window: the assistant is the
    // only page listening, and addressing it by label here would make this
    // command care which window called it.
    let handle = app.clone();
    let sink: LineSink = std::sync::Arc::new(move |line: &str| {
        // Best-effort by design. A failed emit means nothing is listening —
        // the window closed mid-install — and the install itself carries on
        // and still reports through its return value.
        let _ = handle.emit(INSTALL_LINE_EVENT, line.to_string());
    });
    Ok(run_streaming(&argv, INSTALL_TIMEOUT, sink).into())
}

/// The argv that installs tmux here, or None when no manager we can drive is
/// present.
///
/// Mirrors `tmuxInstallPlan` in `ui/src/lib/installers.ts`, which owns the same
/// decision for the rendering side. Two copies because one runs in a webview
/// with no process access and one runs where `which` works, and
/// `the_console_install_table_and_the_rust_one_agree` fails the build when a token
/// this runs is removed or changed in the console copy (containment, as that test
/// documents). `apt-get` is hardcoded because the only Linux artifact this app
/// ships is the `.deb`, so every machine this reaches is Debian-family; the
/// note in `installers.ts` carries the lever if that changes.
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

/// `subshell-server init --yes` with the addresses the setup chain collected.
///
/// There is no `desktop_init` command any more (spec 2026-09-12 § 5.6): the
/// Addresses form moved to the SPA, which writes through
/// `PATCH /api/admin/server/config`, and first-run customization rides
/// `desktop_setup`'s own payload. So this is reachable only from the chain,
/// and no page can rewrite a working `config.env` through this app.
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

/// One `service` verb. In service mode the CLI decides; in app mode this app
/// IS the manager, so the same three control verbs drive its own child.
#[tauri::command(async)]
pub fn desktop_service(app: AppHandle, verb: ServiceCommand, force: bool) -> ActionResult {
    let _guard = ActionGuard::new();
    let settings = app.state::<SettingsState>();
    if effective_supervision(settings.get().supervision, installed_now(&settings)) == Supervision::App {
        return supervise_now(&app, verb);
    }
    service_now(&settings, verb, force)
}

/// The app-mode answer to a control verb.
///
/// `force` has no meaning here and is deliberately ignored rather than
/// refused: it means "act even though live panes will die", and this
/// supervisor signals the main pid only, so no verb of its own can kill one.
///
/// `install` and `uninstall` are not control verbs at all in this mode —
/// there is no definition to write or remove — so they say so rather than
/// silently succeeding. Switching modes is `desktop_set_supervision`.
fn supervise_now(app: &AppHandle, verb: ServiceCommand) -> ActionResult {
    let sup = app.state::<supervisor::Supervisor>();
    let spawner = match server_spawner(app) {
        Ok(s) => s,
        Err(err) => {
            return ActionResult {
                ok: false,
                stdout: String::new(),
                stderr: err,
            }
        }
    };
    let done = |line: &str| ActionResult {
        ok: true,
        stdout: format!("{line}\n"),
        stderr: String::new(),
    };
    match verb {
        ServiceCommand::Start => {
            sup.start(spawner);
            done("subshell-server started.")
        }
        ServiceCommand::Stop => {
            if sup.stop(spawner.as_ref()) {
                done("subshell-server stopped.")
            } else {
                ActionResult {
                    ok: false,
                    stdout: String::new(),
                    stderr: "the server did not stop: it ignored both signals".into(),
                }
            }
        }
        ServiceCommand::Restart => {
            // A restart whose OLD child outlived both signals is reported —
            // two servers briefly contending for the port is not a success.
            if sup.restart(spawner) {
                done("subshell-server restarted.")
            } else {
                ActionResult {
                    ok: false,
                    stdout: String::new(),
                    stderr: "the previous server did not stop; a new one may not be able to bind".into(),
                }
            }
        }
        ServiceCommand::Install | ServiceCommand::Uninstall => ActionResult {
            ok: false,
            stdout: String::new(),
            stderr: "this server runs with the app; there is no service to install or remove".into(),
        },
    }
}

/// Whether a service definition exists on this machine right now.
///
/// `false` when the manager would not answer: the reset's stop needs a
/// decision rather than a maybe, and stopping a supervisor that is not
/// running is a no-op while failing to stop one that is would wipe data out
/// from under a live process.
pub(crate) fn service_installed_json(settings: &SettingsState) -> bool {
    installed_now(settings) == Some(true)
}

/// `service status --json`'s `installed` for the machine right now.
fn installed_now(settings: &SettingsState) -> Option<bool> {
    let server = server_bin::resolve(settings.get().binary_path.as_deref());
    let cmd = server_cmd(&server, &["service", "status", "--json"])?;
    service_installed(&json_of(&run(&cmd, QUERY_TIMEOUT)))
}

/// Build the spawner that runs this machine's server as our child.
///
/// The config dir comes from the server's OWN `status --json` when it answers
/// — the same rule the unit and plist follow with `WorkingDirectory` — and
/// falls back to the documented default only when it does not, because a
/// server that cannot be asked is one whose config home we can only guess at.
pub(crate) fn server_spawner(app: &AppHandle) -> Result<std::sync::Arc<dyn supervisor::Spawner>, String> {
    let settings = app.state::<SettingsState>();
    let server = server_bin::resolve(settings.get().binary_path.as_deref());
    let Some(argv) = server.as_ref().map(|s| s.argv.clone()) else {
        return Err("no subshell-server found".into());
    };
    let probe_status = server_cmd(&server, &["status", "--json"]).map(|cmd| json_of(&run(&cmd, QUERY_TIMEOUT)));
    let cwd = probe_status
        .flatten()
        .as_ref()
        .and_then(|st| {
            field(&Some(st.clone()), "configEnv")?
                .get("path")?
                .as_str()
                .map(String::from)
        })
        .and_then(|p| std::path::Path::new(&p).parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(default_config_dir);
    Ok(std::sync::Arc::new(supervisor::ServerSpawner {
        argv,
        cwd,
        console_log: console_log_path(),
        own_pid: std::process::id(),
    }))
}

/// `~/.config/subshell-server`, the CLI's own default config home.
fn default_config_dir() -> std::path::PathBuf {
    let home = subshell_desktop_core::shell_env::home_dir().unwrap_or_default();
    std::path::Path::new(&home).join(".config").join("subshell-server")
}

/// Where an app-run server's console output is collected.
///
/// macOS deliberately reuses the file the plist names, so `desktop_logs`'
/// existing fallback finds it with no new rung and a person who switched
/// modes keeps reading the same path. Linux has no equivalent — the unit logs
/// to the journal, which an app-run server has no part in — so it takes the
/// XDG state directory, which is where a user-level program's non-essential
/// records belong.
pub(crate) fn console_log_path() -> std::path::PathBuf {
    let home = subshell_desktop_core::shell_env::home_dir().unwrap_or_default();
    let home = std::path::Path::new(&home);
    if cfg!(target_os = "macos") {
        return home.join("Library").join("Logs").join("subshell-server.log");
    }
    std::env::var_os("XDG_STATE_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".local").join("state"))
        .join("subshell-server")
        .join("console.log")
}

/// `desktop_service`'s body, reachable without a command context.
///
/// See [`install_server_now`] for why the body lives below its wrapper;
/// `desktop_setup` calls this for the install and start steps, and
/// `reset::desktop_reset` for the stop and uninstall the wipe needs first.
pub(crate) fn service_now(settings: &SettingsState, verb: ServiceCommand, force: bool) -> ActionResult {
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

/// Move this machine between "a background service runs the server" and "this
/// app runs it", and set whether that service starts at login.
///
/// **Reachable from the served page, and it is the only command in this file
/// that is.** Both directions leave the server unreachable for a moment — an
/// uninstall stops it, a mode switch restarts it — which is exactly why it
/// cannot be an HTTP route: the actor has to outlive the server. It used to
/// be assistant-only for that reason, and the SPA merely named the screen;
/// the operator's call on 2026-09-12 was that a window opening to ask one
/// question reads as a bug rather than as a safeguard. `capabilities/main.json`
/// grants it and `docs/security.md` carries the accounting.
///
/// Channel discipline is `desktop_setup`'s: every step's words accumulate in
/// `stdout`, a failure stops the chain and answers `ok: false` with the CLI's
/// own stderr, and the setting is written only AFTER the step that makes it
/// true has succeeded — so a half-run leaves a machine whose stored mode
/// still matches what is on disk.
///
/// **It answers with the mode the machine ENDED in, re-read rather than
/// assumed.** The page derives "current" from the server's own view of its
/// parentage and this command derives it from the settings file corrected by
/// an installed-definition probe, so the two can disagree — a stale plist
/// under an app-run server is enough. When they do, the request lands on a
/// same-mode branch, nothing runs, and a bare `ok: true` would close the
/// dialog on a machine that did not move. `mode` and `noop` are what let the
/// page say so.
#[tauri::command(async)]
pub fn desktop_set_supervision(
    app: AppHandle,
    mode: String,
    autostart: bool,
    force: bool,
) -> Result<SupervisionResult, String> {
    // Refused rather than queued while anything else is running — see
    // `ActionGuard::try_new`. This is the one command in this file a page we
    // did not write can invoke.
    let Some(_guard) = ActionGuard::try_new() else {
        return Err("Another action is already running on this machine.".into());
    };
    let want = match mode.as_str() {
        "app" => Supervision::App,
        "service" => Supervision::Service,
        // A closed set, like every other argument a page supplies: an
        // unrecognised word is a refusal before anything is touched.
        other => return Err(format!("unknown supervision mode '{other}'")),
    };
    let settings = app.state::<SettingsState>();
    let (result, noop) = set_supervision_now(&app, &settings, want, autostart, force);
    // Re-read, never assume: on a failure the machine is wherever the chain
    // stopped, which is not what was asked for.
    let ended = effective_supervision(settings.get().supervision, Some(installed_now(&settings) == Some(true)));
    Ok(SupervisionResult {
        result,
        mode: match ended {
            Supervision::App => "app",
            Supervision::Service => "service",
        },
        noop,
    })
}

/// The chain itself, answering `(what happened, nothing needed to)`.
///
/// Split from the command so the command can re-read the machine after it —
/// every early return in here is a different half-state, and one place that
/// asks the machine what it ended in beats sixteen that each guess.
fn set_supervision_now(
    app: &AppHandle,
    settings: &SettingsState,
    want: Supervision,
    autostart: bool,
    force: bool,
) -> (ActionResult, bool) {
    let installed = installed_now(settings) == Some(true);
    let current = effective_supervision(settings.get().supervision, Some(installed));
    let mut log = String::new();
    /// The CLI's own words, accumulated — a free function rather than a
    /// closure so the borrow ends with the call and `log` stays writable
    /// between steps.
    fn push(log: &mut String, r: &ActionResult) {
        if !r.stdout.trim().is_empty() {
            log.push_str(r.stdout.trim_end());
            log.push('\n');
        }
    }

    match (current, want) {
        (Supervision::Service, Supervision::App) => {
            // **The pane-safety refusal, and it is what makes this command no
            // more permissive than the restart route it is justified by.**
            //
            // Leaving app mode means `service uninstall`, which by deliberate
            // design gates on NOTHING (`apps/server/api/src/service.ts`) so a
            // stranded unit can always come down. On a definition that
            // predates `KillMode=process` / `AbandonProcessGroup`, that
            // teardown takes every live subshell's tmux server with it — the
            // exact case `POST /api/admin/server/restart` answers with a 409
            // unless the caller passes `force`.
            //
            // Without this, the page could do silently what the route refuses,
            // and the argument in `docs/security.md` — "a page that already
            // holds the restart route can do worse" — was false on the one
            // axis it needed to be true. It fails CLOSED on `unknown`, like
            // every other consumer of this fact: an unreadable definition is
            // not evidence of safety.
            if !force {
                if let Some(refusal) = pane_safety_refusal(settings) {
                    return (
                        ActionResult {
                            ok: false,
                            stdout: log,
                            stderr: refusal,
                        },
                        false,
                    );
                }
            }
            let un = service_now(settings, ServiceCommand::Uninstall, false);
            push(&mut log, &un);
            if !un.ok {
                return (
                    ActionResult {
                        ok: false,
                        stdout: log,
                        stderr: un.stderr,
                    },
                    false,
                );
            }
            // NOT `?`. The chain's contract is that a failure answers
            // `ok: false` carrying every word so far — and by this point the
            // service is already UNINSTALLED, so a bare `Err` would tell the
            // operator "no subshell-server found" while hiding that their
            // server is now gone and nothing is supervising it.
            if let Err(e) = settings.update(|s| s.supervision = Supervision::App) {
                return (
                    ActionResult {
                        ok: false,
                        stdout: log,
                        stderr: e,
                    },
                    false,
                );
            }
            match server_spawner(app) {
                Ok(spawner) => app.state::<supervisor::Supervisor>().start(spawner),
                Err(e) => {
                    return (
                        ActionResult {
                            ok: false,
                            stdout: log,
                            stderr: e,
                        },
                        false,
                    )
                }
            }
            log.push_str("subshell-server is running with this app.\n");
        }
        (Supervision::App, Supervision::Service) => {
            // The supervisor's OWN spawner first: `server_spawner` rebuilds one
            // from the binary ladder and can fail (a moved binary, a stale
            // `binary_path`), and the previous version swallowed that and then
            // claimed the stop had happened — after which the install below
            // would race a still-live child for the port, with nothing in the
            // UI able to reach that child again.
            let sup = app.state::<supervisor::Supervisor>();
            let Some(spawner) = sup.spawner().or_else(|| server_spawner(app).ok()) else {
                return (
                    ActionResult {
                        ok: false,
                        stdout: log,
                        stderr: "could not find the server this app is running, so it was not stopped".into(),
                    },
                    false,
                );
            };
            if !sup.stop(spawner.as_ref()) {
                return (
                    ActionResult {
                        ok: false,
                        stdout: log,
                        stderr: "the server this app was running did not stop; a service would not be able to bind"
                            .into(),
                    },
                    false,
                );
            }
            log.push_str("Stopped the server this app was running.\n");
            // BEFORE the install, so a failure leaves a machine in service
            // mode with nothing running — which the recovery screen can fix —
            // rather than in app mode with a service half-installed.
            if let Err(e) = settings.update(|s| s.supervision = Supervision::Service) {
                return (
                    ActionResult {
                        ok: false,
                        stdout: log,
                        stderr: e,
                    },
                    false,
                );
            }
            let install = install_service_now(settings, autostart);
            push(&mut log, &install);
            if !install.ok {
                return (
                    ActionResult {
                        ok: false,
                        stdout: log,
                        stderr: install.stderr,
                    },
                    false,
                );
            }
            let start = service_now(settings, ServiceCommand::Start, false);
            push(&mut log, &start);
            if !start.ok {
                return (
                    ActionResult {
                        ok: false,
                        stdout: log,
                        stderr: start.stderr,
                    },
                    false,
                );
            }
        }
        (Supervision::Service, Supervision::Service) => {
            // Same mode: the only thing that can differ is the login arming,
            // and that is the one change here that touches no process.
            let armed = installed && service_enabled(settings) == Some(true);
            if armed == autostart {
                return (
                    ActionResult {
                        ok: true,
                        stdout: "Nothing to change.\n".into(),
                        stderr: String::new(),
                    },
                    true,
                );
            }
            let res = autostart_now(settings, autostart);
            push(&mut log, &res);
            if !res.ok {
                return (
                    ActionResult {
                        ok: false,
                        stdout: log,
                        stderr: res.stderr,
                    },
                    false,
                );
            }
        }
        (Supervision::App, Supervision::App) => {
            return (
                ActionResult {
                    ok: true,
                    stdout: "Nothing to change.\n".into(),
                    stderr: String::new(),
                },
                true,
            );
        }
    }
    (
        ActionResult {
            ok: true,
            stdout: log,
            stderr: String::new(),
        },
        false,
    )
}

/// Whether removing this machine's service definition would take live panes
/// with it, as a refusal sentence — `None` when it is safe or there is
/// nothing installed.
///
/// Fails CLOSED: `unknown` (an unreadable definition, a manager that would
/// not answer) refuses, because absence of evidence is not evidence of
/// safety. The wording distinguishes the two, since telling someone their
/// panes will die when the truth is "nobody could read the definition" is
/// the kind of certainty that teaches people to ignore warnings.
fn pane_safety_refusal(settings: &SettingsState) -> Option<String> {
    let server = server_bin::resolve(settings.get().binary_path.as_deref());
    let cmd = server_cmd(&server, &["service", "status", "--json"])?;
    let state = json_of(&run(&cmd, QUERY_TIMEOUT));
    if !is_true(&state, "installed") {
        return None;
    }
    match field(&state, "paneSafety").and_then(|p| p.as_str()) {
        Some("keeps") => None,
        Some("kills") => Some(
            "This machine's service definition would close every running subshell when it is removed. \
             Reinstall the service definition first, or switch anyway."
                .into(),
        ),
        _ => Some(
            "This machine's service definition could not be read, so whether removing it closes running \
             subshells is unknown. Switch anyway to proceed."
                .into(),
        ),
    }
}

/// `service enable|disable` — the login arming, which touches no process.
fn autostart_now(settings: &SettingsState, enabled: bool) -> ActionResult {
    let server = server_bin::resolve(settings.get().binary_path.as_deref());
    let verb = if enabled { "enable" } else { "disable" };
    let Some(cmd) = server_cmd(&server, &["service", verb]) else {
        return ActionResult {
            ok: false,
            stdout: String::new(),
            stderr: "no subshell-server found".into(),
        };
    };
    run(&cmd, ACTION_TIMEOUT).into()
}

/// `service status --json`'s `enabled` for the machine right now.
fn service_enabled(settings: &SettingsState) -> Option<bool> {
    let server = server_bin::resolve(settings.get().binary_path.as_deref());
    let cmd = server_cmd(&server, &["service", "status", "--json"])?;
    field(&json_of(&run(&cmd, QUERY_TIMEOUT)), "enabled")?.as_bool()
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
/// The SERVER'S OWN log file is read first, on every platform: since spec
/// 2026-09-12 § 3.4 the server writes one capped JSON-lines file and reports
/// its path as `status --json`'s `paths.serverLog`. That is the same file the
/// SPA's Service page shows, so the two surfaces cannot describe different
/// logs.
///
/// The SERVICE MANAGER's log is the fallback, and the platforms genuinely
/// differ in MECHANISM there, not just in path: Linux has no file at all (the
/// unit's output goes to the journal, so the tail is a `journalctl` query),
/// while macOS has a file the plist names and the CLI stays the authority on
/// where (`service status --json` reports `logPath`). It is reached when
/// `paths.serverLog` is absent — a server older than the field — or when
/// nothing has been written there yet.
///
/// Never an `Err`: every outcome is a caption the pane can render, because a
/// missing log during setup is normal and an error banner for it would train
/// the user to ignore the pane.
#[tauri::command(async)]
pub fn desktop_logs(settings: State<'_, SettingsState>) -> LogTail {
    let probe = probe_now(settings.get().binary_path.as_deref(), settings.get().supervision);
    if let Some(tail) = server_log_tail(&probe) {
        return tail;
    }
    #[cfg(target_os = "linux")]
    {
        journal_tail()
    }
    #[cfg(not(target_os = "linux"))]
    {
        file_tail(&probe)
    }
}

/// The server's own capped log file, when this server reports one and it has
/// something in it. `None` means "ask the service manager instead" — an older
/// server that never names the path, a file not created yet, or one that
/// cannot be read.
///
/// Returning `None` rather than an empty tail with a note is what keeps the
/// fallback reachable: the launchd file and the journal still hold the boot
/// output of a server that died before opening its own log, which is exactly
/// the machine someone is trying to repair.
fn server_log_tail(probe: &Probe) -> Option<LogTail> {
    let path = field(&probe.status, "paths")?.get("serverLog")?.as_str()?.to_string();
    let body = std::fs::read_to_string(&path).ok()?;
    let lines: Vec<&str> = body.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        return None;
    }
    let text = lines[lines.len().saturating_sub(LOG_TAIL_LINES)..]
        .iter()
        .map(|line| render_log_line(line))
        .collect::<Vec<_>>()
        .join("\n");
    Some(LogTail {
        text,
        source: path,
        note: None,
    })
}

/// One JSON-lines entry as `HH:MM:SS level message`.
///
/// A line that will not parse is returned VERBATIM: the file is capped and
/// replaced when full, so the first line after a replacement can be a partial
/// write, and a half-written line is still the most recent thing the server
/// said. The timestamp is sliced out of the ISO string rather than parsed —
/// no date crate for one field, and a value that is not an ISO timestamp
/// simply contributes nothing.
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
///
/// Takes the probe `desktop_logs` already read, rather than re-probing: the
/// server-log path and this one come from the same look at the machine, so
/// the fallback cannot describe a different moment than the thing it fell
/// back from.
#[cfg(not(target_os = "linux"))]
fn file_tail(probe: &Probe) -> LogTail {
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
///
/// Gated with its only caller (`journal_tail`): reading a journald refusal is a
/// Linux act, and left unconditional this is `dead_code` in every darwin build
/// — which the release shards show, because only test.yml's Linux clippy runs
/// `-D warnings`.
#[cfg(target_os = "linux")]
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
    let probe = probe_now(configured.get().binary_path.as_deref(), configured.get().supervision);
    let origin = probe
        .origin()
        .ok_or_else(|| "the server has not reported a usable base URL yet".to_string())?;
    crate::windows::open_main(app, &origin)?;
    // The wizard's job ends at the dashboard - by either door. The Done press
    // lives in the wizard page, which has no window-close permission (and
    // should not: a page that can close its own window can close it at the
    // wrong moment); the shell that just opened the dashboard closes the
    // guide instead, one direction of data, same closed-intent shape as the
    // reveal enum below. The tray/menu dashboard opens pass through here too,
    // which is also correct: a wizard left behind an open dashboard is the
    // second manage surface this app decided not to have.
    if let Some(w) = app.get_webview_window("wizard") {
        let _ = w.close();
    }
    Ok(())
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

/// Reveal one of a fixed set of the server's own files or directories.
#[tauri::command(async)]
pub fn desktop_open_path(app: AppHandle, settings: State<'_, SettingsState>, target: OpenTarget) -> Result<(), String> {
    let probe = probe_now(settings.get().binary_path.as_deref(), settings.get().supervision);
    let path = resolve_open_target(target, &probe)?;
    if !std::path::Path::new(&path).exists() {
        return Err(format!("{path} does not exist yet"));
    }
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| format!("could not reveal {path}: {e}"))
}

/// Who made this, under what terms, and where to read more.
///
/// One command rather than the strings being copied into the webview, because
/// the licence facts already exist twice by necessity — `legal.ts` for the CLIs
/// and the SPA, `legal.rs` for the two desktop apps — and
/// `scripts/license-fields.ts` asserts those two agree. A third copy in
/// `ui/src` would be one the detector does not cover, and a copyright line
/// that has drifted is invisible: nobody re-reads an About box.
///
/// The version is this APP's, from its own manifest — the only one of these
/// facts the webview could not get from anywhere else (the probe reports the
/// server CLI's version, which is a different program).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct About {
    /// The product family, e.g. `Subshell`.
    pub product_name: String,
    /// THIS app as a person installed it, e.g. `Subshell Server` — the
    /// bundle's own `productName`, which is what its window and its icon are
    /// called. `product_name` above names the family the app belongs to, and
    /// an About box has to answer the narrower question first.
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
    /// [`desktop_open_web`], which holds its own copies.
    pub website_url: String,
    pub license_url: String,
    pub company_url: String,
}

#[tauri::command(async)]
pub fn desktop_about(app: AppHandle) -> About {
    About {
        product_name: legal::PRODUCT_NAME.to_string(),
        // `package_info().name` is the CRATE name (`subshell-desktop`); the
        // bundle's productName is the label, and it is what the window title,
        // the menu bar and the installed `.app` all carry.
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

/// The pages the About section may open in the system browser.
///
/// A closed enum for the same reason [`OpenTarget`] is one: the page names a
/// member and this side decides what that member IS, so no URL crosses the
/// boundary. That the same strings are also SENT to the page for display does
/// not weaken it — display and navigation are different capabilities, and a
/// page that could open an address it chose is the thing being prevented.
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
    MacPorts,
}

/// Where the tmux screen sends someone who has no package manager at all.
/// Constants here rather than arguments from the page, for the same reason
/// every other member of this set is one.
const HOMEBREW_URL: &str = "https://brew.sh";
const MACPORTS_URL: &str = "https://www.macports.org/install.php";

/// Open one of a fixed set of pages in the system browser: the three About
/// links, and the two package managers the tmux screen names.
///
/// The console's CSP makes an ordinary `<a href>` open inside the webview,
/// which is the wrong window for a website — the same reason
/// `desktop_open_tmux_docs` exists.
#[tauri::command(async)]
pub fn desktop_open_web(app: AppHandle, target: WebTarget) -> Result<(), String> {
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

/// The tmux formula page — spec §6.1's reading for the plan the console
/// cannot run itself (a Mac without Homebrew). The same string
/// `ui/src/lib/installers.ts` carries as its plans' `docsUrl`, pinned equal to it by
/// `the_console_install_table_and_the_rust_one_agree`.
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

/// The origin "Open in browser" opens, for whatever route is named.
///
/// The `main` window's OWN url first, because that is the server the person is
/// actually looking at — a port changed from the Service page moves it, and
/// `watch.rs` re-points the window rather than re-creating it. A fresh probe is
/// the fallback for the window not existing yet (the tray item on a machine
/// sitting on the assistant), and it answers the same loopback origin
/// `open_main_now` would open.
///
/// Either way the origin is THIS SIDE's: nothing a page sends reaches it.
fn browser_origin(app: &AppHandle) -> Option<String> {
    if let Some(url) = app.get_webview_window("main").and_then(|w| w.url().ok()) {
        return Some(url.origin().ascii_serialization());
    }
    let settings = app.state::<SettingsState>();
    probe_now(settings.get().binary_path.as_deref(), settings.get().supervision).origin()
}

/// Open a page of THIS server in the system browser.
///
/// The one command granted to the served SPA that takes a string, and the
/// string is a PATH: `subshell_desktop_core::browser::browser_url` refuses
/// anything that could name a host, and the origin comes from
/// [`browser_origin`]. So the widest thing an XSS in the SPA gains here is
/// opening a page of the very server it is already running in, in the person's
/// own browser — which they can do by typing the address.
///
/// Two things a person will notice, and neither is a bug this command should
/// paper over: the browser carries no session cookie from the webview, so they
/// sign in again; and this app's window is pinned to LOOPBACK, so the address
/// that opens is the loopback one — where a passkey works only if
/// `APP_BASE_URL` is loopback too.
#[tauri::command(async)]
pub fn desktop_open_in_browser(app: AppHandle, path: String) -> Result<(), String> {
    let origin = browser_origin(&app).ok_or_else(|| "the server has not reported a usable base URL yet".to_string())?;
    let url = subshell_desktop_core::browser::browser_url(&origin, &path)?;
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| format!("could not open {url}: {e}"))
}

/// The path "Open in Browser" opens from the tray or the View menu.
///
/// The CURRENT route when a window is showing one, so the menu item and the
/// SPA's own row do the same thing; `/` when there is no window (or its url
/// cannot be read), because the app still has a sensible page to offer and a
/// disabled menu item would need a probe to know it should be.
///
/// Rust-side, deliberately: this is not a `DesktopAction`. Those are
/// ROUTER-level operations the page performs, and they need a page — here the
/// act is opening another program, which works with no window at all.
fn current_path(app: &AppHandle) -> String {
    let Some(url) = app.get_webview_window("main").and_then(|w| w.url().ok()) else {
        return "/".to_string();
    };
    let mut path = url.path().to_string();
    if let Some(query) = url.query() {
        path.push('?');
        path.push_str(query);
    }
    path
}

/// The MENU BAR's "Open in Browser" id.
///
/// It lives here rather than in `menu.rs` because `mod menu` is macOS-only and
/// `tray.rs` — which is not — has to assert the two ids DIFFER: a Tauri menu
/// event is global, so one id in both menus fires twice per click. A constant
/// behind a `#[cfg]` cannot be named from a test that compiles on Linux, which
/// is the cfg-stripping hazard both desktop `AGENTS.md` files warn about.
///
/// Which leaves it with NO non-test user on Linux — `menu.rs` is the only one
/// and that module is macOS-only — and `mod control` is private, so a `pub`
/// item in it is not externally reachable and `dead-code` fires. Measured:
/// `cargo clippy --all-targets -- -D warnings` (CI's exact command) fails the
/// LIB target there; the `#[cfg(test)]` use in `tray.rs` does not rescue it,
/// because the lib target is built without it. Hence the allow, scoped to the
/// platforms where the item really is unused.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const MENU_BROWSER_ID: &str = "menu:browser";

/// Open whatever the dashboard is showing in the system browser.
///
/// The tray's and the menu bar's entry point. Failure is reported on stderr
/// and nowhere else: a menu item has no place to render an error, and the two
/// ways this fails (no server address yet, no browser) are both states the
/// person can see for themselves.
pub fn open_current_in_browser(app: &AppHandle) {
    let path = current_path(app);
    if let Err(err) = desktop_open_in_browser(app.clone(), path) {
        eprintln!("subshell: could not open this page in a browser: {err}");
    }
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

/// Raise the assistant, optionally at a named screen (`reset` | `update`).
///
/// Called from the SPA's pill (no screen: the recovery screen for whatever
/// the probe says) and from its danger/update cards. The argument names a
/// SCREEN, never a command: raising `update` performs one read-only probe,
/// and the update itself is a press inside the bundled page.
#[tauri::command(async)]
pub fn desktop_open_assistant(app: AppHandle, screen: Option<String>) -> Result<(), String> {
    crate::reset::arm_and_raise(&app, screen)
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

    /// A probe in app mode, which is `probe_with` plus the one field that
    /// changes which branch `decide()` takes.
    fn app_mode_probe(status: Option<serde_json::Value>, service: Option<serde_json::Value>) -> Probe {
        let mut p = probe_with(status, service, true);
        p.supervision = Supervision::App;
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
        // `installers.ts` speaks the web convention ("darwin"); Rust's own
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

    /// The two halves of the tmux-install contract speak different languages
    /// and each comment claims the other: `ui/src/lib/installers.ts` decides
    /// what the console SHOWS, `tmux_install_argv` here decides what gets
    /// RUN. Nothing else fails if they drift — the warning would display one
    /// command while its own button ran another, on CI that is green.
    /// Text-matching rather than a shared data file: the console copy is
    /// prose-shaped on purpose (readable, hand-edited), and this is the
    /// price of that shape.
    ///
    /// The pin is CONTAINMENT, Rust into JS, and it is worth being exact
    /// about what that catches: anything either side relies on being REMOVED
    /// or CHANGED in the other fails here (the drift that actually bit), on
    /// the host that ships. The mac tokens are compared only where they run,
    /// since `tmux_install_argv` answers for the current OS only.
    ///
    /// Agent CLI installs used to be pinned here too (`AGENT_INSTALLS`); they
    /// moved to the control plane (spec 2026-09-11 § 7,
    /// `POST /api/setup/agents/:id/install`), so this test is tmux-only now.
    #[test]
    fn the_console_install_table_and_the_rust_one_agree() {
        let ts = include_str!("../../ui/src/lib/installers.ts");
        if let Some(argv) = tmux_install_argv() {
            for token in &argv {
                assert!(
                    ts.contains(token.as_str()),
                    "installers.ts lost the tmux token {token:?}"
                );
            }
        }
        // The docs button opens Rust's constant; the JS plans carry the same
        // URL for readers of the table.
        assert!(
            ts.contains(TMUX_DOCS_URL),
            "installers.ts and the docs command name different pages"
        );
        // And the dialect pair holds on EVERY host, not only where
        // `console_platform`'s mac arm runs: the JS must branch on "darwin",
        // and must not have learned Rust's "macos" spelling.
        assert!(ts.contains("\"darwin\""), "installers.ts does not branch on darwin");
        assert!(
            !ts.contains("\"macos\""),
            "installers.ts must not branch on the Rust consts::OS spelling"
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

    /// The dev override replaces the ADDRESS, never the readiness check.
    ///
    /// Driven through the PURE helpers, so nothing here sets a process-wide
    /// variable — cargo runs tests in parallel across modules, and the first
    /// version of this test set `SUBSHELL_DESKTOP_SPA_URL` and broke
    /// `watch::tests` on another thread.
    #[test]
    fn the_dev_spa_override_takes_only_loopback_http() {
        assert_eq!(
            dev_spa_origin_from(Some("http://localhost:5174")).as_deref(),
            Some("http://localhost:5174")
        );
        // A trailing slash would make `watch.rs`'s origin comparison disagree
        // with itself and re-navigate the window on every tick.
        assert_eq!(
            dev_spa_origin_from(Some("http://127.0.0.1:5174/")).as_deref(),
            Some("http://127.0.0.1:5174")
        );
        // Not loopback: this window holds privileged globals.
        assert_eq!(dev_spa_origin_from(Some("http://example.com:5174")), None);
        // **The input that made the hand-rolled host parser disagree with
        // WHATWG.** A backslash terminates the authority, so `Url` reads the
        // host as `evil.com` where the old `url_host` read `localhost` and
        // let it through — safe only because `open_main` refused it
        // afterwards. Parsing with the webview's own parser makes the two
        // agree here instead of downstream.
        assert_eq!(dev_spa_origin_from(Some("http://evil.com\\@localhost:5174/")), None);
        // Reduced to an ORIGIN: a path, query or fragment is dropped rather
        // than passed through, which is what the name promises and what
        // `watch.rs` compares against.
        assert_eq!(
            dev_spa_origin_from(Some("http://localhost:5174/foo?a=b#c")).as_deref(),
            Some("http://localhost:5174")
        );
        // Not http, not a URL, absent, blank.
        assert_eq!(dev_spa_origin_from(Some("https://localhost:5174")), None);
        assert_eq!(dev_spa_origin_from(Some("5174")), None);
        assert_eq!(dev_spa_origin_from(Some("   ")), None);
        assert_eq!(dev_spa_origin_from(None), None);
    }

    #[test]
    fn a_server_that_is_not_ready_is_still_not_opened_under_the_override() {
        // `portValid: false` means there is no server worth pointing at.
        // Overriding the ADDRESS must not turn that into a window of failed
        // requests against a proxy with nothing behind it.
        let down = probe_with(
            Some(serde_json::json!({ "listen": { "portValid": false, "port": 3080 } })),
            None,
            true,
        );
        assert_eq!(down.origin_with(Some("http://localhost:5174")), None);

        // Ready: the override is what the window opens at.
        let up = probe_with(
            Some(serde_json::json!({ "listen": { "portValid": true, "port": 3080 } })),
            None,
            true,
        );
        assert_eq!(
            up.origin_with(Some("http://localhost:5174")).as_deref(),
            Some("http://localhost:5174")
        );
        // And without one, the server's own address, unchanged.
        assert_eq!(up.origin_with(None).as_deref(), Some("http://127.0.0.1:3080"));
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
            "wizard" => include_str!("../capabilities/wizard.json"),
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

    /// Serializes the tests that drive `ACTION_IN_FLIGHT`.
    ///
    /// It is a process-wide static and cargo runs tests in parallel threads,
    /// so two of them setting and clearing it race — invisibly while the rest
    /// of the suite happens to interleave them apart, and then not. Found by
    /// running with a filter, which changed which tests were in flight
    /// together; a filter must not decide whether a test passes.
    ///
    /// It sits ABOVE the next test's own doc block on purpose: inserted
    /// between that block and its `#[test]`, it silently took ownership of a
    /// paragraph written about the test, leaving the test undocumented and
    /// this mutex explained by a security rationale that has nothing to do
    /// with it.
    static GUARD_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// The one command a page we did not write can invoke refuses to
    /// interleave with anything else.
    ///
    /// `ACTION_IN_FLIGHT` looked like it prevented this and never did: it is a
    /// hint for the watch thread, `new()` stores true unconditionally, and
    /// `Drop` clears it even while a second action is still running. That was
    /// harmless while every caller was the assistant page, which serializes
    /// its own presses — and stopped being harmless when `main.json` granted
    /// `desktop_set_supervision` to the served page, where an XSS can fire a
    /// hundred at once into a chain that uninstalls a service and installs
    /// another.
    #[test]
    fn a_second_action_cannot_start_while_one_is_running() {
        let _serial = GUARD_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        // Nothing running: the first caller takes it.
        ACTION_IN_FLIGHT.store(false, Ordering::SeqCst);
        let first = ActionGuard::try_new().expect("an idle machine admits one");
        // A second, concurrent caller is REFUSED rather than queued: blocking
        // would park an executor thread per call and take the app down
        // instead of the server.
        assert!(ActionGuard::try_new().is_none());
        drop(first);
        // ...and the next one after it finishes is admitted again.
        let second = ActionGuard::try_new().expect("released");
        assert!(ActionGuard::try_new().is_none());
        drop(second);
        assert!(!ACTION_IN_FLIGHT.load(Ordering::SeqCst));
    }

    /// An assistant guard dropping must not release a served-page guard's hold.
    ///
    /// `new()` is unconditional as a SET, by design — the assistant repairs
    /// broken machines and a refusal there would be a new way to be stuck.
    /// But `Drop` was unconditional too, so the assistant's guard going out of
    /// scope cleared a flag the SPA's chain was still relying on, and the next
    /// `try_new` was admitted beside a live uninstall. That is precisely the
    /// interleave `try_new` exists to prevent, reachable without any race.
    #[test]
    fn a_non_owning_guard_does_not_release_the_owner_s_flag() {
        let _serial = GUARD_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        ACTION_IN_FLIGHT.store(false, Ordering::SeqCst);
        let owner = ActionGuard::try_new().expect("an idle machine admits one");
        // The assistant proceeds anyway — that part is unchanged.
        let passenger = ActionGuard::new();
        assert!(!passenger.owned, "it did not take the flag from false");
        drop(passenger);
        // The gate is STILL shut, because the owner has not finished.
        assert!(ACTION_IN_FLIGHT.load(Ordering::SeqCst));
        assert!(ActionGuard::try_new().is_none());
        drop(owner);
        assert!(!ACTION_IN_FLIGHT.load(Ordering::SeqCst));
    }

    /// The REMOTE window's grant list, pinned whole.
    ///
    /// That window loads a page this repo did not ship, so every command it can
    /// reach is reachable by an XSS in the server's SPA. The list is asserted
    /// exactly rather than by absence of specific entries, because the failure
    /// to catch is a command added to it by habit — a test that only forbade
    /// today's names would not see tomorrow's.
    ///
    /// Five of the six cannot touch the CLI. The last,
    /// `desktop_set_supervision`, can — it is the ONE deliberate exception
    /// (operator's call, 2026-09-12): the dashboard confirms in its own dialog
    /// rather than raising the assistant, on the argument that a page already
    /// holding the admin restart route can do worse than choose the server's
    /// respawner. `docs/security.md` carries the accounting. A SEVENTH entry,
    /// or a wider one of these, is what this pin exists to make loud.
    ///
    /// `allow-desktop-open-in-browser` (2026-09-14) is of the harmless kind,
    /// and its harmlessness is in its ARGUMENT rather than its name: a path,
    /// refused by `subshell_desktop_core::browser` if it could name a host, and
    /// joined onto this window's own loopback origin. Its signature is pinned
    /// separately, by `ui/src/__tests__/ipc-acl.test.ts`.
    #[test]
    fn the_remote_window_is_granted_five_harmless_commands_and_one_deliberate_exception() {
        assert_eq!(
            grants("main"),
            vec![
                "core:window:allow-start-dragging",
                "allow-desktop-open-assistant",
                "allow-desktop-shell-ready",
                "allow-desktop-notify",
                "allow-desktop-open-in-browser",
                "allow-desktop-set-supervision",
            ]
        );
    }

    /// Reading the server's log is an ASSISTANT-only surface.
    ///
    /// It takes no path, so it is not an arbitrary-file read, but it does hand
    /// back the server's own log lines — and the remote window is the one place
    /// whose page we do not control.
    #[test]
    fn only_the_assistant_may_read_the_logs() {
        assert!(grants("wizard").contains(&"allow-desktop-logs".to_string()));
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
    fn boot_window_opens_the_dashboard_on_a_ready_probe_and_the_assistant_otherwise() {
        // Spec 2026-09-12 § 5.2: a machine set up entirely from the CLI opens
        // the DASHBOARD on its first app launch, because the first probe
        // answers ready. `onboarded` no longer decides the window at all — it
        // decides which family of assistant screens a not-ready machine sees.
        let ready = Probe {
            next: ProbeStep::Ready,
            onboarded: true,
            ..Probe::default()
        };
        assert_eq!(boot_window(&ready), WindowChoice::Main);
        let stopped = Probe {
            next: ProbeStep::Start,
            onboarded: true,
            ..Probe::default()
        };
        assert_eq!(boot_window(&stopped), WindowChoice::Wizard);
        let virgin = Probe {
            next: ProbeStep::Setup,
            onboarded: false,
            ..Probe::default()
        };
        assert_eq!(boot_window(&virgin), WindowChoice::Wizard);
    }

    #[test]
    fn probe_serializes_onboarded_and_hostname_for_the_page() {
        let p = Probe {
            onboarded: true,
            hostname: "devbox".into(),
            ..Probe::default()
        };
        let v: serde_json::Value = serde_json::to_value(&p).unwrap();
        assert_eq!(v["onboarded"], serde_json::json!(true));
        assert_eq!(v["hostname"], serde_json::json!("devbox"));
    }

    #[test]
    fn hostname_is_trimmed_and_non_empty_here() {
        // Memo + trim contract; the value itself is the machine's business.
        let h = machine_hostname();
        assert!(!h.is_empty());
        assert_eq!(h, h.trim(), "the compared string must be exactly what the screen shows");
        assert!(!h.contains('\n'));
        // One value per process: the display side and the gate read the same
        // memo by construction (R15), not two spawns that happen to agree.
        assert_eq!(h, machine_hostname());
    }

    #[test]
    fn setup_payload_maps_through_the_same_init_args_as_init() {
        // The chain's address fields thread into init_args unchanged, so a
        // setup press that carried wizard edits writes exactly what the init
        // form would have. The per-field empty/None rules are pinned by the
        // init_args tests above; this pins the intent of the shared path.
        let args = init_args("4100", "0.0.0.0", "http://x:4100", Some("http://lan"));
        assert!(args.contains(&"--port".to_string()) && args.contains(&"4100".to_string()));
        let empty = init_args("", "", "", None);
        assert!(
            !empty.iter().any(|a| a.starts_with("--port")),
            "omitted flags fall back to derived defaults"
        );
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

    // One JSON line as the pane renders it, plus the two shapes a capped
    // file produces that are not JSON at all: a partial write left by the
    // replacement, and anything a crash wrote straight to the stream. Both
    // come back VERBATIM rather than being dropped — the most recent thing
    // the server said is the thing someone repairing it wants to read.
    #[test]
    fn a_log_line_renders_as_time_level_message() {
        assert_eq!(
            render_log_line(r#"{"timestamp":"2026-09-12T10:00:00.000Z","level":"info","message":"listening"}"#),
            "10:00:00 info listening"
        );
        assert_eq!(render_log_line("half a li"), "half a li");
        // A JSON line missing the fields contributes what it has, never the
        // word "undefined" or an empty prefix of spaces.
        assert_eq!(render_log_line(r#"{"message":"no level"}"#), "no level");
    }

    // The fallback is the path that runs against every server built before
    // `paths.serverLog` existed, which is the only one this can be exercised
    // against today — so all three ways of reaching it are pinned.
    #[test]
    fn the_server_log_is_skipped_when_there_is_none_to_read() {
        // An older server: no `paths.serverLog` at all.
        let old = probe_with(Some(json!({"paths": {"dataDir": "/d"}})), None, true);
        assert!(server_log_tail(&old).is_none());
        // No `paths` block whatsoever.
        assert!(server_log_tail(&probe_with(Some(json!({})), None, true)).is_none());
        // Named but not written yet — a server that has never started.
        let missing = probe_with(
            Some(json!({"paths": {"serverLog": "/nonexistent/subshell/logs/server.log"}})),
            None,
            true,
        );
        assert!(server_log_tail(&missing).is_none());
    }

    #[test]
    fn the_server_log_is_read_and_rendered_when_it_has_lines() {
        let path = std::env::temp_dir().join(format!("subshell-log-test-{}.log", std::process::id()));
        std::fs::write(
            &path,
            "{\"timestamp\":\"2026-09-12T09:59:59.000Z\",\"level\":\"warn\",\"message\":\"one\"}\n\
             \n\
             {\"timestamp\":\"2026-09-12T10:00:00.000Z\",\"level\":\"info\",\"message\":\"two\"}\n",
        )
        .unwrap();
        let p = probe_with(
            Some(json!({"paths": {"serverLog": path.to_string_lossy()}})),
            None,
            true,
        );
        let tail = server_log_tail(&p).expect("a written log is read");
        assert_eq!(tail.text, "09:59:59 warn one\n10:00:00 info two");
        assert_eq!(tail.source, path.to_string_lossy());
        assert!(tail.note.is_none());
        // An empty file is NOT an empty tail: it falls through to the service
        // manager's log, which still holds the boot output of a server that
        // died before opening its own.
        std::fs::write(&path, "\n  \n").unwrap();
        assert!(server_log_tail(&p).is_none());
        let _ = std::fs::remove_file(&path);
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

    /// **The disk outranks the preference**, and only in that direction.
    ///
    /// Someone can install a service from a terminal on a machine this app
    /// last set to app mode. If the stored preference won, the app would
    /// believe it owned a process it never spawned — and `RunEvent::Exit`
    /// would stop it on quit, taking down a server the operator had just
    /// arranged to be permanent.
    #[test]
    fn a_service_on_disk_wins_over_the_stored_preference() {
        assert_eq!(
            effective_supervision(Supervision::App, Some(true)),
            Supervision::Service
        );
        assert_eq!(
            effective_supervision(Supervision::Service, Some(true)),
            Supervision::Service
        );
        // Nothing installed: the preference is the only fact there is.
        assert_eq!(effective_supervision(Supervision::App, Some(false)), Supervision::App);
        assert_eq!(
            effective_supervision(Supervision::Service, Some(false)),
            Supervision::Service
        );
        // The manager would not answer. NOT evidence of absence — a launchctl
        // hiccup must not flip a machine's mode.
        assert_eq!(effective_supervision(Supervision::App, None), Supervision::App);
        assert_eq!(effective_supervision(Supervision::Service, None), Supervision::Service);
    }

    /// The branch that gives app mode a steady state at all.
    ///
    /// Without it `!installed` sends an app-mode machine to `InstallService`
    /// forever: the assistant nags to install the very thing the operator
    /// declined, `mark_onboarded` never fires, and boot never opens the
    /// dashboard.
    #[test]
    fn app_mode_reads_the_port_and_never_asks_for_a_service() {
        let listening = json!({"configEnv": {"exists": true}, "settings": {},
                               "listen": {"portValid": true, "port": 3080, "listening": true}});
        let quiet = json!({"configEnv": {"exists": true}, "settings": {},
                           "listen": {"portValid": true, "port": 3080, "listening": false}});
        let no_service = json!({"installed": false});
        assert_eq!(
            app_mode_probe(Some(listening), Some(no_service.clone())).next,
            ProbeStep::Ready
        );
        assert_eq!(
            app_mode_probe(Some(quiet.clone()), Some(no_service)).next,
            ProbeStep::Start
        );
        // Even with the manager silent, which in service mode is Unreachable.
        assert_eq!(app_mode_probe(Some(quiet), None).next, ProbeStep::Start);
    }

    /// App mode does not skip the checks that come BEFORE it: a machine with
    /// no binary or no config has the same first problem either way.
    #[test]
    fn app_mode_still_reaches_the_earlier_steps() {
        let mut p = probe_with(None, None, false);
        p.supervision = Supervision::App;
        p.decide();
        assert_eq!(p.next, ProbeStep::Setup, "no server is still no server");

        let unconfigured = json!({"configEnv": {"exists": false}, "settings": {}, "listen": {}});
        let mut p = probe_with(Some(unconfigured), Some(json!({"installed": false})), true);
        p.supervision = Supervision::App;
        p.decide();
        assert_eq!(p.next, ProbeStep::Init, "an unconfigured server is still unconfigured");
    }

    /// The console log is a real path, and on macOS it is the SAME file the
    /// plist names — so `desktop_logs`' existing fallback finds it with no new
    /// rung, and someone who switches modes keeps reading one path.
    #[test]
    fn the_console_log_is_the_platform_s_own_place() {
        let path = console_log_path();
        assert!(path.is_absolute(), "{path:?}");
        if cfg!(target_os = "macos") {
            assert!(path.ends_with("Library/Logs/subshell-server.log"), "{path:?}");
        } else {
            assert!(path.ends_with("subshell-server/console.log"), "{path:?}");
        }
    }
}
