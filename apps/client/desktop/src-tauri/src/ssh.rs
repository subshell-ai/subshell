//! Desktop-owned SSH transport. Only the bundled page can start this child.
//! Pairing credentials go over stdin and remain in the CLI's private store.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use subshell_desktop_core::{settings::SettingsState, shell_env::login_path, sidecar};
use tauri::{AppHandle, Manager, State};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    id: String,
    server: String,
    name: String,
    #[serde(default, skip_deserializing)]
    connected: bool,
}

#[derive(Default)]
pub struct SshState(Mutex<Inner>);
#[derive(Default)]
struct Inner {
    loaded: bool,
    connections: Vec<Connection>,
    children: HashMap<String, Child>,
}
fn key(server: &str, id: &str) -> String {
    format!("{server}|{id}")
}
fn metadata_path() -> Result<std::path::PathBuf, String> {
    crate::SETTINGS_PATHS
        .file()
        .and_then(|p| p.parent().map(|d| d.join("ssh-connections.json")))
        .ok_or_else(|| "This computer has no home directory.".into())
}
fn load(inner: &mut Inner) {
    if inner.loaded {
        return;
    }
    inner.loaded = true;
    if let Ok(path) = metadata_path() {
        if let Ok(file) = std::fs::File::open(path) {
            let mut bytes = Vec::new();
            if file.take(65537).read_to_end(&mut bytes).is_ok() && bytes.len() <= 65536 {
                inner.connections = serde_json::from_slice::<Vec<Connection>>(&bytes)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|c| valid_id(&c.id) && server_origin(&c.server).is_ok())
                    .take(16)
                    .collect();
            }
        }
    }
}
fn save(inner: &Inner) -> Result<(), String> {
    let path = metadata_path()?;
    std::fs::create_dir_all(path.parent().ok_or("No settings directory")?).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(&inner.connections).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}
fn valid_id(id: &str) -> bool {
    id.strip_prefix("desktop:")
        .is_some_and(|v| v.len() == 36 && v.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
}
fn server_origin(raw: &str) -> Result<String, String> {
    let url = tauri::Url::parse(raw.trim()).map_err(|_| "Enter a valid server address.")?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Use the server's HTTPS origin, or HTTP on localhost, without a path or credentials.".into());
    }
    Ok(url.origin().ascii_serialization())
}
fn stop_child(child: &mut Child) {
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"{\"type\":\"stop\"}\n");
    }
    let until = Instant::now() + Duration::from_secs(40);
    while Instant::now() < until {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[tauri::command(async)]
pub fn node_ssh_connections(state: State<'_, SshState>) -> Vec<Connection> {
    let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    load(&mut inner);
    inner.children.retain(|_, child| matches!(child.try_wait(), Ok(None)));
    inner
        .connections
        .iter()
        .map(|c| Connection {
            connected: inner.children.contains_key(&key(&c.server, &c.id)),
            ..c.clone()
        })
        .collect()
}

#[tauri::command]
pub async fn node_ssh_connect(
    app: AppHandle,
    server: String,
    pairing_token: Option<String>,
    broker_id: Option<String>,
    confirm: bool,
) -> Result<Connection, String> {
    if !confirm {
        return Err("Confirm that you trust this server with SSH access from this computer.".into());
    }
    let server = server_origin(&server)?;
    if broker_id.as_deref().is_some_and(|id| !valid_id(id)) {
        return Err("Invalid saved connection.".into());
    }
    let token = pairing_token.unwrap_or_default();
    if token.len() > 512 || token.chars().any(char::is_control) || (token.is_empty() && broker_id.is_none()) {
        return Err("Paste a pairing code from Settings > Connections on your server.".into());
    }
    tauri::async_runtime::spawn_blocking(move || start(&app, server, token, broker_id))
        .await
        .map_err(|e| e.to_string())?
}
fn start(app: &AppHandle, server: String, token: String, broker_id: Option<String>) -> Result<Connection, String> {
    let state = app.state::<SshState>();
    let mut inner = state
        .0
        .try_lock()
        .map_err(|_| "Another SSH connection operation is in progress. Retry when it finishes.")?;
    load(&mut inner);
    inner.children.retain(|_, child| matches!(child.try_wait(), Ok(None)));
    if inner.connections.len() >= 16 && !token.is_empty() {
        return Err("This computer already remembers 16 connections. Remove an unused connection first.".into());
    }
    if inner.children.len() >= 8 {
        return Err("Disconnect a server before adding another connection.".into());
    }
    if broker_id
        .as_ref()
        .is_some_and(|id| inner.children.contains_key(&key(&server, id)))
    {
        return Err("This computer is already connected to that server.".into());
    }
    let argv = sidecar::bundled_path(&crate::node_bin::NODE_SIDECAR)
        .map(|p| vec![p.to_string_lossy().into_owned()])
        .or_else(|| crate::node_bin::resolve(app.state::<SettingsState>().get().binary_path.as_deref()).map(|b| b.argv))
        .ok_or("Update Subshell Client to install its bundled SSH support.")?;
    let (program, args) = argv.split_first().ok_or("No Subshell binary")?;
    let mut cmd = Command::new(program);
    cmd.args(args)
        .args(["ssh-broker", "--server", &server])
        .env("PATH", login_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(id) = &broker_id {
        cmd.args(["--broker-id", id]);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Could not start SSH support: {e}"))?;
    let input = serde_json::json!({"pairingToken":token}).to_string() + "\n";
    if child
        .stdin
        .as_mut()
        .ok_or("Missing child input")?
        .write_all(input.as_bytes())
        .is_err()
    {
        stop_child(&mut child);
        return Err("Could not pass the pairing code to SSH support.".into());
    }
    let stdout = child.stdout.take().ok_or("Missing child output")?;
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout.take(16385)).read_line(&mut line).map(|_| line);
        let _ = tx.send(result);
    });
    let response = rx
        .recv_timeout(Duration::from_secs(20))
        .ok()
        .and_then(Result::ok)
        .filter(|line| line.len() <= 16384)
        .and_then(|line| serde_json::from_str::<serde_json::Value>(&line).ok());
    let Some(response) = response.filter(|v| v["type"] == "attached") else {
        stop_child(&mut child);
        return Err("Could not connect. Check the server address and pairing code, or update Subshell Client. Saved connections may need pairing again after access is revoked.".into());
    };
    let id = response["id"].as_str().unwrap_or_default().to_owned();
    if !valid_id(&id) || broker_id.as_ref().is_some_and(|expected| expected != &id) {
        stop_child(&mut child);
        return Err("The server returned an unexpected connection.".into());
    }
    let connection = Connection {
        id,
        server,
        name: response["name"]
            .as_str()
            .unwrap_or("This computer")
            .chars()
            .take(80)
            .collect(),
        connected: true,
    };
    inner
        .connections
        .retain(|c| key(&c.server, &c.id) != key(&connection.server, &connection.id));
    inner.connections.push(connection.clone());
    if let Err(e) = save(&inner) {
        stop_child(&mut child);
        return Err(e);
    }
    // Pairing also remembers the server so an SSH-only client skips first run next time.
    let settings = app.state::<SettingsState>();
    if let Err(error) = settings.update(|s| {
        if !s.planes.contains(&connection.server) {
            s.planes.push(connection.server.clone());
        }
    }) {
        stop_child(&mut child);
        return Err(error);
    }
    inner.children.insert(key(&connection.server, &connection.id), child);
    Ok(connection)
}
#[tauri::command]
pub async fn node_ssh_disconnect(app: AppHandle, server: String, id: String) -> Result<(), String> {
    let server = server_origin(&server)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<SshState>();
        let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut child) = inner.children.remove(&key(&server, &id)) {
            stop_child(&mut child);
        }
    })
    .await
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn node_ssh_forget(app: AppHandle, server: String, id: String) -> Result<(), String> {
    let server = server_origin(&server)?;
    if !valid_id(&id) {
        return Err("Invalid saved connection.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<SshState>();
        let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
        load(&mut inner);
        if let Some(mut child) = inner.children.remove(&key(&server, &id)) {
            stop_child(&mut child);
        }
        let mut argv = sidecar::bundled_path(&crate::node_bin::NODE_SIDECAR)
            .map(|p| vec![p.to_string_lossy().into_owned()])
            .or_else(|| {
                crate::node_bin::resolve(app.state::<SettingsState>().get().binary_path.as_deref()).map(|b| b.argv)
            })
            .ok_or("Update Subshell Client to remove this connection's local credential.")?;
        argv.extend([
            "ssh-broker".into(),
            "--server".into(),
            server.clone(),
            "--broker-id".into(),
            id.clone(),
            "--forget".into(),
        ]);
        let outcome = subshell_desktop_core::proc::run(&argv, Duration::from_secs(10));
        if !outcome.ok() {
            return Err("Could not remove the local connection credential. Update Subshell Client and retry.".into());
        }
        inner.connections.retain(|c| key(&c.server, &c.id) != key(&server, &id));
        save(&inner)
    })
    .await
    .map_err(|e| e.to_string())?
}
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<SshState>();
    let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    for (_, mut child) in inner.children.drain() {
        stop_child(&mut child);
    }
}

/// Hold the connection lock through the rest of reset: a concurrent pairing
/// must not create fresh authority after the reset has removed credentials.
pub struct ResetGuard<'a> {
    _inner: MutexGuard<'a, Inner>,
}

pub fn reset_access(app: &AppHandle) -> Result<ResetGuard<'_>, String> {
    let state = app.state::<SshState>();
    let mut inner = state.inner().0.lock().unwrap_or_else(|e| e.into_inner());
    load(&mut inner);
    reset_connections(&mut inner, |connection| forget_credential(app, connection), save)?;
    Ok(ResetGuard { _inner: inner })
}

fn forget_credential(app: &AppHandle, connection: &Connection) -> Result<(), String> {
    let mut argv = sidecar::bundled_path(&crate::node_bin::NODE_SIDECAR)
        .map(|p| vec![p.to_string_lossy().into_owned()])
        .or_else(|| crate::node_bin::resolve(app.state::<SettingsState>().get().binary_path.as_deref()).map(|b| b.argv))
        .ok_or("Update Subshell Client to remove its saved SSH credentials.")?;
    argv.extend([
        "ssh-broker".into(),
        "--server".into(),
        connection.server.clone(),
        "--broker-id".into(),
        connection.id.clone(),
        "--forget".into(),
    ]);
    if !subshell_desktop_core::proc::run(&argv, Duration::from_secs(10)).ok() {
        return Err("Could not remove a saved SSH credential. Update Subshell Client and retry reset.".into());
    }
    Ok(())
}

fn reset_connections(
    inner: &mut Inner,
    mut forget: impl FnMut(&Connection) -> Result<(), String>,
    persist: impl FnOnce(&Inner) -> Result<(), String>,
) -> Result<(), String> {
    // Close all live access before deleting any credentials, even if a later
    // removal fails. Keep the complete list until every idempotent delete and
    // metadata write succeeds so Retry can finish a partial reset.
    for (_, mut child) in inner.children.drain() {
        stop_child(&mut child);
    }
    for connection in &inner.connections {
        forget(connection)?;
    }
    let previous = std::mem::take(&mut inner.connections);
    if let Err(error) = persist(inner) {
        inner.connections = previous;
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn saved_connection() -> Connection {
        Connection {
            id: "desktop:12345678-1234-1234-1234-123456789abc".into(),
            server: "https://example.test".into(),
            name: "Laptop".into(),
            connected: false,
        }
    }

    #[test]
    fn reset_stops_live_access_and_retains_metadata_until_credential_removal_succeeds() {
        let child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let mut inner = Inner {
            connections: vec![saved_connection()],
            ..Inner::default()
        };
        inner.children.insert("connection".into(), child);
        let result = reset_connections(
            &mut inner,
            |_| Err("credential removal failed".into()),
            |_| panic!("must not erase retry metadata"),
        );
        assert!(result.is_err());
        assert!(inner.children.is_empty());
        assert!(
            !Command::new("kill")
                .args(["-0", &pid.to_string()])
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success(),
            "broker child must be gone"
        );
        assert_eq!(inner.connections.len(), 1);
        reset_connections(
            &mut inner,
            |_| Ok(()),
            |state| {
                assert!(state.connections.is_empty());
                Ok(())
            },
        )
        .unwrap();
        assert!(inner.connections.is_empty());
    }

    #[test]
    fn reset_metadata_write_failure_keeps_connection_list_retryable() {
        let mut inner = Inner {
            connections: vec![saved_connection()],
            ..Inner::default()
        };
        assert!(reset_connections(&mut inner, |_| Ok(()), |_| Err("disk full".into())).is_err());
        assert_eq!(inner.connections.len(), 1);
        reset_connections(&mut inner, |_| Ok(()), |_| Ok(())).unwrap();
        assert!(inner.connections.is_empty());
    }

    #[test]
    fn pairing_is_bound_to_a_secure_origin() {
        assert_eq!(
            server_origin("https://example.test/"),
            Ok("https://example.test".into())
        );
        assert!(server_origin("http://localhost:3080").is_ok());
        for value in [
            "http://example.test",
            "https://u:p@example.test",
            "https://example.test/path",
            "https://example.test/?token=x",
            "file:///etc/passwd",
        ] {
            assert!(server_origin(value).is_err(), "{value}");
        }
    }
    #[test]
    fn only_broker_ids_can_resume() {
        assert!(valid_id("desktop:12345678-1234-1234-1234-123456789abc"));
        assert!(!valid_id("local"));
        assert!(!valid_id("desktop:../../file"));
    }
}
