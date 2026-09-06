//! The commands the console window calls.
//!
//! Every one of them is an argument-poor wrapper around the `subshell-server`
//! CLI: the server owns each decision (what a valid port is, whether a restart
//! would kill live panes, what to tell the operator), and this layer only
//! routes. That is why `--json` exists on the CLI at all — nothing here parses
//! prose, and nothing here re-implements a rule that has a home in
//! `apps/server`.

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::proc::{run, Run, ACTION_TIMEOUT, QUERY_TIMEOUT};
use crate::server_bin::{self, decide_server, ServerBinary, ServerChoice};
use crate::settings::SettingsState;
use crate::sidecar;

/// Everything the console needs to decide what to offer, in one round trip.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    /// The server this app ships, if this build carries one.
    pub bundled_version: Option<String>,
    /// The server that would actually run, and which rung found it.
    pub server: Option<ServerBinary>,
    /// `status --json`, verbatim. `null` when no server resolved.
    pub status: Option<serde_json::Value>,
    /// `service status --json`, verbatim. `null` when no server resolved.
    pub service: Option<serde_json::Value>,
    /// What to do about the shipped server versus the installed one.
    pub server_choice: ServerChoice,
    /// What the console should offer next; see {@link Probe::decide}.
    pub next: String,
    /// Populated when a step failed rather than merely being pending.
    pub error: Option<String>,
}

impl Default for Probe {
    fn default() -> Self {
        Probe {
            bundled_version: None,
            server: None,
            status: None,
            service: None,
            server_choice: ServerChoice::NoBundled,
            next: String::new(),
            error: None,
        }
    }
}

/// Read a dotted path out of a `--json` payload.
fn field<'a>(v: &'a Option<serde_json::Value>, key: &str) -> Option<&'a serde_json::Value> {
    v.as_ref()?.get(key)
}

impl Probe {
    /// The single next action, derived from facts rather than remembered.
    ///
    /// Recomputed on every probe on purpose: the user may have installed a
    /// server, edited config.env or stopped the service in a terminal while
    /// this window was open, and a remembered step would be wrong.
    fn decide(&mut self) {
        self.server_choice =
            decide_server(self.bundled_version.as_deref(), self.server.as_ref().and_then(|s| s.version.as_deref()));
        self.next = if self.server.is_none() {
            if self.bundled_version.is_some() {
                "install-server"
            } else {
                "no-server"
            }
        } else if field(&self.status, "configEnv").and_then(|c| c.get("exists")) != Some(&serde_json::Value::Bool(true)) {
            "init"
        } else if field(&self.service, "installed") != Some(&serde_json::Value::Bool(true)) {
            "install-service"
        } else if field(&self.service, "state").and_then(|s| s.as_str()) == Some("running") {
            "ready"
        } else {
            "start"
        }
        .to_string();
    }

    /// The origin the main window should load, from the server's own
    /// `APP_BASE_URL` when that is loopback.
    ///
    /// Never a guess: better-auth derives the passkey rpID from
    /// `APP_BASE_URL`'s hostname and cookie jars are per-host, so opening
    /// `127.0.0.1` against a server configured for `localhost` silently splits
    /// the session in two.
    pub fn origin(&self) -> Option<String> {
        let status = self.status.as_ref()?;
        let settings = status.get("settings")?;
        let port = settings.get("SERVER_PORT")?.get("value")?.as_str()?;
        let base = settings.get("APP_BASE_URL")?.get("value")?.as_str().unwrap_or("");
        let host = url_host(base);
        match host.as_deref() {
            Some(h) if is_loopback(h) => Some(base.trim_end_matches('/').to_string()),
            // A non-loopback base URL is not reachable as itself from here and,
            // on macOS, plain http to a named host is refused by ATS. Fall back
            // to loopback and let the UI say passkeys will not work.
            _ => Some(format!("http://127.0.0.1:{port}")),
        }
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

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "0:0:0:0:0:0:0:1")
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

/// Look at the machine and report what it would take to reach a running server.
#[tauri::command]
pub fn desktop_probe(settings: State<'_, SettingsState>) -> Probe {
    let configured = settings.get().server_bin_path;
    let mut p = Probe {
        bundled_version: sidecar::bundled_path().and_then(|_| bundled_version()),
        server: server_bin::resolve(configured.as_deref()),
        ..Default::default()
    };
    if let Some(cmd) = server_cmd(&p.server, &["status", "--json"]) {
        p.status = json_of(&run(&cmd, QUERY_TIMEOUT));
    }
    if let Some(cmd) = server_cmd(&p.server, &["service", "status", "--json"]) {
        p.service = json_of(&run(&cmd, QUERY_TIMEOUT));
    }
    p.decide();
    p
}

/// What the shipped binary says it is.
fn bundled_version() -> Option<String> {
    let path = sidecar::bundled_path()?;
    let out = run(&[path.to_string_lossy().into_owned(), "version".into()], QUERY_TIMEOUT);
    out.ok()
        .then(|| out.stdout.lines().next()?.trim().strip_prefix("subshell-server ").map(str::to_string))
        .flatten()
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
        let stderr = if r.ok() || !r.stderr.trim().is_empty() { r.stderr.clone() } else { r.detail() };
        ActionResult { ok: r.ok(), stdout: r.stdout, stderr }
    }
}

/// Materialise the bundled server at `~/.local/bin/subshell-server`.
#[tauri::command]
pub fn desktop_install_server(settings: State<'_, SettingsState>) -> Result<ActionResult, String> {
    let configured = settings.get().server_bin_path;
    let version = bundled_version();
    // Stop whatever is running from the target path first — replacing a live
    // binary is ETXTBSY on Linux and a SIGKILL on macOS.
    let stop = || {
        if let Some(cmd) = server_cmd(&server_bin::resolve(configured.as_deref()), &["service", "stop"]) {
            let _ = run(&cmd, ACTION_TIMEOUT);
        }
    };
    match sidecar::install_bundled(version.as_deref(), stop)? {
        sidecar::InstallOutcome::NoSidecar => Err("this build ships no server binary".into()),
        sidecar::InstallOutcome::UpToDate => {
            Ok(ActionResult { ok: true, stdout: "The bundled server is already installed.".into(), stderr: String::new() })
        }
        sidecar::InstallOutcome::Installed => {
            let where_ = sidecar::install_path().map(|p| p.display().to_string()).unwrap_or_default();
            Ok(ActionResult { ok: true, stdout: format!("Installed subshell-server to {where_}"), stderr: String::new() })
        }
    }
}

/// `subshell-server init --yes` with the operator's port/host.
#[tauri::command]
pub fn desktop_init(settings: State<'_, SettingsState>, port: String, host: String) -> ActionResult {
    let server = server_bin::resolve(settings.get().server_bin_path.as_deref());
    let Some(mut cmd) = server_cmd(&server, &["init", "--yes"]) else {
        return ActionResult { ok: false, stdout: String::new(), stderr: "no subshell-server found".into() };
    };
    // `--yes` is what keeps this non-interactive; a GUI spawn has no TTY, so
    // the CLI would refuse to prompt anyway, but saying so is the contract.
    cmd.extend(["--port".into(), port, "--host".into(), host]);
    run(&cmd, ACTION_TIMEOUT).into()
}

/// One `service` verb, straight through. The server decides whether to refuse.
#[tauri::command]
pub fn desktop_service(settings: State<'_, SettingsState>, verb: String, force: bool) -> ActionResult {
    const ALLOWED: [&str; 5] = ["install", "uninstall", "start", "stop", "restart"];
    if !ALLOWED.contains(&verb.as_str()) {
        return ActionResult { ok: false, stdout: String::new(), stderr: format!("unknown service verb '{verb}'") };
    }
    let server = server_bin::resolve(settings.get().server_bin_path.as_deref());
    let Some(mut cmd) = server_cmd(&server, &["service", &verb]) else {
        return ActionResult { ok: false, stdout: String::new(), stderr: "no subshell-server found".into() };
    };
    // Only `restart` takes it; the CLI refuses the flag anywhere else.
    if force && verb == "restart" {
        cmd.push("--force".into());
    }
    run(&cmd, ACTION_TIMEOUT).into()
}

/// Remember an explicitly chosen server binary.
#[tauri::command]
pub fn desktop_set_server_bin(settings: State<'_, SettingsState>, path: Option<String>) -> Result<(), String> {
    let mut guard = settings.0.lock().map_err(|_| "settings lock poisoned".to_string())?;
    guard.server_bin_path = path.filter(|p| !p.is_empty());
    guard.save()
}

/// Open (or focus) the window that shows the server's own UI.
#[tauri::command]
pub fn desktop_open_main(app: AppHandle, settings: State<'_, SettingsState>) -> Result<(), String> {
    let probe = desktop_probe(settings);
    let origin = probe.origin().ok_or_else(|| "the server has not reported a base URL yet".to_string())?;
    crate::windows::open_main(&app, &origin)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn probe_with(status: serde_json::Value, service: serde_json::Value, has_server: bool) -> Probe {
        let mut p = Probe {
            bundled_version: Some("1.8.0".into()),
            server: has_server
                .then(|| ServerBinary { argv: vec!["/x/subshell-server".into()], source: "path".into(), version: Some("1.8.0".into()) }),
            status: Some(status),
            service: Some(service),
            ..Default::default()
        };
        p.decide();
        p
    }

    const CONFIGURED: fn() -> serde_json::Value = || json!({"configEnv": {"exists": true}, "settings": {}});

    #[test]
    fn with_no_server_the_first_step_is_installing_the_bundled_one() {
        let p = probe_with(json!({}), json!({}), false);
        assert_eq!(p.next, "install-server");
    }

    #[test]
    fn a_build_with_no_sidecar_and_no_server_says_so() {
        let mut p = Probe::default();
        p.decide();
        assert_eq!(p.next, "no-server");
    }

    #[test]
    fn a_server_without_config_needs_init() {
        let p = probe_with(json!({"configEnv": {"exists": false}}), json!({"installed": false}), true);
        assert_eq!(p.next, "init");
    }

    #[test]
    fn a_configured_server_with_no_service_offers_the_install() {
        let p = probe_with(CONFIGURED(), json!({"installed": false, "state": "not-installed"}), true);
        assert_eq!(p.next, "install-service");
    }

    #[test]
    fn an_installed_but_stopped_service_offers_start() {
        let p = probe_with(CONFIGURED(), json!({"installed": true, "state": "stopped"}), true);
        assert_eq!(p.next, "start");
    }

    #[test]
    fn a_running_service_is_ready() {
        let p = probe_with(CONFIGURED(), json!({"installed": true, "state": "running"}), true);
        assert_eq!(p.next, "ready");
    }

    // `unknown` is the manager failing to answer — it must not read as ready.
    #[test]
    fn an_unknown_manager_state_is_not_ready() {
        let p = probe_with(CONFIGURED(), json!({"installed": true, "state": "unknown"}), true);
        assert_eq!(p.next, "start");
    }

    #[test]
    fn origin_prefers_the_servers_own_loopback_base_url() {
        let p = probe_with(
            json!({"configEnv": {"exists": true}, "settings": {"SERVER_PORT": {"value": "3080"}, "APP_BASE_URL": {"value": "http://localhost:3080"}}}),
            json!({"installed": true, "state": "running"}),
            true,
        );
        assert_eq!(p.origin().as_deref(), Some("http://localhost:3080"));
    }

    // Guessing the loopback spelling splits the cookie jar and breaks passkeys,
    // so the server's own spelling wins whenever it is loopback.
    #[test]
    fn origin_keeps_the_127_spelling_when_that_is_what_the_server_says() {
        let p = probe_with(
            json!({"configEnv": {"exists": true}, "settings": {"SERVER_PORT": {"value": "9000"}, "APP_BASE_URL": {"value": "http://127.0.0.1:9000"}}}),
            json!({"installed": true, "state": "running"}),
            true,
        );
        assert_eq!(p.origin().as_deref(), Some("http://127.0.0.1:9000"));
    }

    #[test]
    fn origin_falls_back_to_loopback_for_a_named_host() {
        let p = probe_with(
            json!({"configEnv": {"exists": true}, "settings": {"SERVER_PORT": {"value": "3080"}, "APP_BASE_URL": {"value": "https://box.tail1234.ts.net"}}}),
            json!({"installed": true, "state": "running"}),
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
        for h in ["localhost", "127.0.0.1", "::1"] {
            assert!(is_loopback(h), "{h}");
        }
        assert!(!is_loopback("example.com"));
    }
}
