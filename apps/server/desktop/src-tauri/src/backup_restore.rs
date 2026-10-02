//! Wizard-only orchestration. The CLI owns archive validation, crypto, protected
//! stages, installed-manager ownership and replacement. Rust owns only its child.
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use subshell_desktop_core::proc::run;
use subshell_desktop_core::settings::{SettingsState, Supervision};
use subshell_desktop_core::sidecar;
use tauri::{AppHandle, Manager};

use crate::{control, server_bin, supervisor, SETTINGS_PATHS};

const OPERATION_BOUND: Duration = Duration::from_secs(600);
const BOOT_BOUND: Duration = Duration::from_secs(90);
static SECRET_ID: AtomicU64 = AtomicU64::new(0);

/// Created exclusively at 0600; no password enters argv or command output.
struct SecretFile(PathBuf);
impl SecretFile {
    fn new(secret: &str) -> Result<Self, String> {
        if secret.is_empty()
            || secret.encode_utf16().count() > 4096
            || secret.len() > 16_384
            || secret.contains(['\r', '\n', '\0'])
        {
            return Err("Use a password of 1–4096 characters on one line.".into());
        }
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "subshell-desktop-secret-{}-{stamp}-{}",
            std::process::id(),
            SECRET_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&path)
            .map_err(|_| "Cannot create protected password transport.".to_string())?;
        let transport = Self(path);
        file.write_all(secret.as_bytes())
            .map_err(|_| "Cannot write protected password transport.".to_string())?;
        Ok(transport)
    }
    fn temporary(secret: &str) -> Result<Self, String> {
        if secret.encode_utf16().count() < 8 {
            return Err("Temporary passwords need at least eight characters.".into());
        }
        Self::new(secret)
    }
    fn flag(&self, args: &mut Vec<String>, name: &str) {
        args.extend([name.into(), self.0.to_string_lossy().into_owned()]);
    }
}
impl Drop for SecretFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Prefer the resolved installed server. A compatible owned sidecar may fill a
/// missing/older CLI; it is never copied or installed by a backup/restore act.
fn executable(app: &AppHandle) -> Result<Vec<String>, String> {
    let settings = app.state::<SettingsState>().get();
    let installed = server_bin::resolve(settings.binary_path.as_deref());
    if let Some(server) = &installed {
        // The global help enumerates flags even on binaries whose restore
        // parser refuses --help. Check stdout/stderr rather than status here.
        let mut global = server.argv.clone();
        global.push("--help".into());
        let out = run(&global, Duration::from_secs(10));
        if out.stdout.contains("--list-staged") && out.stdout.contains("--prepare") {
            return Ok(server.argv.clone());
        }
    }
    let bundled = sidecar::bundled_path(&server_bin::SERVER_SIDECAR)
        .ok_or("This app needs a bundled server with backup and restore support.")?;
    let version = server_bin::probe_version(&[bundled.to_string_lossy().into_owned()])
        .ok_or("The bundled server could not report its version.")?;
    if installed
        .as_ref()
        .and_then(|s| s.version.as_deref())
        .is_some_and(|v| subshell_desktop_core::version::version_lt(&version, v))
    {
        return Err("The installed server is newer and lacks the required restore interface. Update this app; an older bundled server cannot restore its database.".into());
    }
    let argv = vec![bundled.to_string_lossy().into_owned()];
    let mut help = argv.clone();
    help.push("--help".into());
    let out = run(&help, Duration::from_secs(10));
    if !out.stdout.contains("--prepare") {
        return Err("Update Subshell Server to a build with native backup and restore support.".into());
    }
    Ok(argv)
}

fn json_command(argv: &[String], args: Vec<String>, secrets: &[&str]) -> Result<Value, String> {
    let mut command = argv.to_vec();
    command.extend(args.iter().cloned());
    let result = run(&command, OPERATION_BOUND);
    if !result.ok() {
        let mut detail = result.detail();
        for secret in secrets.iter().filter(|s| !s.is_empty()) {
            detail = detail.replace(secret, "[redacted]");
        }
        return Err(detail);
    }
    if result.stdout.len() > 64 * 1024 * 1024 {
        return Err("The server returned too much public metadata.".into());
    }
    let parsed = serde_json::from_str(&result.stdout)
        .map_err(|_| "The server returned an invalid operation result.".to_string())?;
    public_response(&args, &parsed, secrets)
}

/// The CLI publishes metadata only. Project that schema rather than guessing
/// that a public path/name matching the supplied password is an echo.
#[derive(Clone, Copy)]
enum PublicSchema {
    Object(&'static [(&'static str, PublicSchema)]),
    Array(&'static PublicSchema, usize),
    Text(usize),
    Number,
    Boolean,
    Port,
}
const PUBLIC_DESTINATION: PublicSchema = PublicSchema::Object(&[
    ("databasePath", PublicSchema::Text(4096)),
    ("dataDir", PublicSchema::Text(4096)),
    ("configPath", PublicSchema::Text(4096)),
]);
const PUBLIC_OVERRIDES: PublicSchema = PublicSchema::Object(&[
    ("baseUrl", PublicSchema::Text(8192)),
    ("host", PublicSchema::Text(256)),
    ("port", PublicSchema::Port),
    ("trustedOrigins", PublicSchema::Text(8192)),
]);
const PUBLIC_CHOICES: PublicSchema =
    PublicSchema::Object(&[("mode", PublicSchema::Text(32)), ("configOverrides", PUBLIC_OVERRIDES)]);
const PUBLIC_ENTRY: PublicSchema = PublicSchema::Object(&[
    ("path", PublicSchema::Text(4096)),
    ("bytes", PublicSchema::Number),
    ("sha256", PublicSchema::Text(64)),
]);
const PUBLIC_ADMIN: PublicSchema = PublicSchema::Object(&[
    ("id", PublicSchema::Text(4096)),
    ("name", PublicSchema::Text(4096)),
    ("email", PublicSchema::Text(4096)),
]);
const PUBLIC_MANIFEST: PublicSchema = PublicSchema::Object(&[
    ("sourcePaths", PUBLIC_DESTINATION),
    ("format", PublicSchema::Text(32)),
    ("version", PublicSchema::Number),
    ("serverVersion", PublicSchema::Text(256)),
    ("startedAt", PublicSchema::Text(64)),
    ("completedAt", PublicSchema::Text(64)),
    ("consistency", PublicSchema::Text(64)),
    ("migrations", PublicSchema::Array(&PublicSchema::Text(4096), 50_000)),
    ("entries", PublicSchema::Array(&PUBLIC_ENTRY, 50_000)),
    ("exclusions", PublicSchema::Array(&PublicSchema::Text(8192), 50_000)),
]);
const PUBLIC_STAGE: PublicSchema = PublicSchema::Object(&[
    ("id", PublicSchema::Text(36)),
    ("expiresAt", PublicSchema::Number),
    ("prepared", PublicSchema::Boolean),
    ("transactionId", PublicSchema::Text(36)),
    ("journalPath", PublicSchema::Text(4096)),
    ("choices", PUBLIC_CHOICES),
    ("destination", PUBLIC_DESTINATION),
    ("recoveryUserId", PublicSchema::Text(4096)),
    ("manifest", PUBLIC_MANIFEST),
    ("admins", PublicSchema::Array(&PUBLIC_ADMIN, 100_000)),
    ("legacyDatabaseOnly", PublicSchema::Boolean),
    ("compatible", PublicSchema::Boolean),
    ("serviceInstalled", PublicSchema::Boolean),
]);
const PUBLIC_BACKUP: PublicSchema = PublicSchema::Object(&[
    ("path", PublicSchema::Text(4096)),
    ("bytes", PublicSchema::Number),
    ("manifest", PUBLIC_MANIFEST),
]);
const PUBLIC_BACKUP_FILE: PublicSchema = PublicSchema::Object(&[
    ("path", PublicSchema::Text(4096)),
    ("name", PublicSchema::Text(512)),
    ("bytes", PublicSchema::Number),
    ("createdAt", PublicSchema::Text(64)),
    ("legacyDatabaseOnly", PublicSchema::Boolean),
    ("encrypted", PublicSchema::Boolean),
    ("serverVersion", PublicSchema::Text(256)),
]);
const PUBLIC_APPLY: PublicSchema = PublicSchema::Object(&[
    ("transactionId", PublicSchema::Text(36)),
    ("journalPath", PublicSchema::Text(4096)),
    ("destination", PUBLIC_DESTINATION),
    ("mode", PublicSchema::Text(32)),
    ("started", PublicSchema::Boolean),
    ("status", PublicSchema::Text(32)),
    ("legacyDatabaseOnly", PublicSchema::Boolean),
]);
const INVALID_PUBLIC_OUTPUT: &str = "The server returned an invalid public operation result.";
const SENSITIVE_PUBLIC_OUTPUT: &str = "The server returned sensitive output; it was withheld.";
fn project_public(schema: PublicSchema, value: &Value, secrets: &[&str]) -> Result<Value, String> {
    match schema {
        PublicSchema::Object(fields) => {
            let object = value.as_object().ok_or(INVALID_PUBLIC_OUTPUT)?;
            let mut projected = serde_json::Map::new();
            for (key, value) in object {
                if let Some((_, schema)) = fields.iter().find(|(field, _)| *field == key) {
                    projected.insert(key.clone(), project_public(*schema, value, secrets)?);
                } else if secrets
                    .iter()
                    .filter(|secret| !secret.is_empty())
                    .any(|secret| contains_secret_value(value, secret))
                {
                    return Err(SENSITIVE_PUBLIC_OUTPUT.into());
                }
                // No unknown property, including any credential/config field,
                // crosses IPC even when it contains a different secret.
            }
            Ok(Value::Object(projected))
        }
        PublicSchema::Array(element, bound) => {
            let values = value
                .as_array()
                .filter(|values| values.len() <= bound)
                .ok_or(INVALID_PUBLIC_OUTPUT)?;
            Ok(Value::Array(
                values
                    .iter()
                    .map(|value| project_public(*element, value, secrets))
                    .collect::<Result<_, _>>()?,
            ))
        }
        PublicSchema::Text(bound) => {
            let text = value
                .as_str()
                .filter(|text| text.encode_utf16().count() <= bound && !text.contains('\0'))
                .ok_or(INVALID_PUBLIC_OUTPUT)?;
            Ok(Value::String(text.into()))
        }
        PublicSchema::Port => {
            let port = value
                .as_u64()
                .or_else(|| value.as_str().and_then(|text| text.parse::<u64>().ok()));
            if port.is_some_and(|port| (1..=65535).contains(&port)) {
                Ok(value.clone())
            } else {
                Err(INVALID_PUBLIC_OUTPUT.into())
            }
        }
        PublicSchema::Number if value.as_u64().is_some() => Ok(value.clone()),
        PublicSchema::Boolean if value.is_boolean() => Ok(value.clone()),
        _ => Err(INVALID_PUBLIC_OUTPUT.into()),
    }
}
fn public_response(args: &[String], parsed: &Value, secrets: &[&str]) -> Result<Value, String> {
    let has = |flag: &str| args.iter().any(|arg| arg == flag);
    let (schema, required): (PublicSchema, &[&str]) = match args.first().map(String::as_str) {
        Some("backup") if has("--list") => (
            PublicSchema::Object(&[("backups", PublicSchema::Array(&PUBLIC_BACKUP_FILE, 1000))]),
            &["backups"],
        ),
        Some("backup") => (PUBLIC_BACKUP, &["path", "bytes", "manifest"]),
        Some("restore") if has("--list-staged") => (
            PublicSchema::Object(&[("stages", PublicSchema::Array(&PUBLIC_STAGE, 50_000))]),
            &["stages"],
        ),
        Some("restore") if has("--discard-staged") => (
            PublicSchema::Object(&[("id", PublicSchema::Text(36)), ("discarded", PublicSchema::Boolean)]),
            &["id", "discarded"],
        ),
        Some("restore") if has("--inspect") || has("--prepare") || has("--native-preflight") => {
            (PUBLIC_STAGE, &["manifest", "admins", "legacyDatabaseOnly"])
        }
        Some("restore") => (
            PUBLIC_APPLY,
            &[
                "transactionId",
                "journalPath",
                "destination",
                "mode",
                "started",
                "status",
                "legacyDatabaseOnly",
            ],
        ),
        _ => return Err(INVALID_PUBLIC_OUTPUT.into()),
    };
    let projected = project_public(schema, parsed, secrets)?;
    if required.iter().any(|key| projected.get(key).is_none()) {
        return Err(INVALID_PUBLIC_OUTPUT.into());
    }
    Ok(projected)
}

fn contains_secret_value(value: &Value, secret: &str) -> bool {
    match value {
        Value::String(text) => text == secret || (secret.len() >= 8 && text.contains(secret)),
        Value::Array(items) => items.iter().any(|v| contains_secret_value(v, secret)),
        Value::Object(items) => items.values().any(|v| contains_secret_value(v, secret)),
        _ => false,
    }
}

fn stage_args(staged: &str) -> Result<Vec<String>, String> {
    if staged.len() != 36
        || !staged.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
    {
        return Err("Enter the prepared restore's UUID.".into());
    }
    Ok(vec!["restore".into(), "--staged".into(), staged.into()])
}

#[tauri::command(async)]
pub fn desktop_backup(app: AppHandle, output: String, password: String) -> Result<Value, String> {
    let _guard = control::ActionGuard::try_new().ok_or("Another server action is running.")?;
    if !Path::new(&output).is_absolute() {
        return Err("Choose an absolute archive destination.".into());
    }
    let argv = executable(&app)?;
    let mut args = vec!["backup".into(), "--output".into(), output, "--json".into()];
    let secret = if password.is_empty() {
        None
    } else {
        Some(SecretFile::new(&password)?)
    };
    if let Some(secret) = &secret {
        args.push("--encrypt".into());
        secret.flag(&mut args, "--password-file");
    }
    json_command(&argv, args, &[&password])
}

#[tauri::command(async)]
pub fn desktop_restore_inspect(
    app: AppHandle,
    archive: String,
    staged: String,
    password: String,
) -> Result<Value, String> {
    let argv = executable(&app)?;
    let mut args = if staged.is_empty() {
        vec!["restore".into(), archive]
    } else {
        stage_args(&staged)?
    };
    args.extend(["--inspect".into(), "--json".into()]);
    let secret = if password.is_empty() || !staged.is_empty() {
        None
    } else {
        Some(SecretFile::new(&password)?)
    };
    if let Some(secret) = &secret {
        secret.flag(&mut args, "--password-file");
    }
    json_command(&argv, args, &[&password])
}

#[tauri::command(async)]
pub fn desktop_backup_list(app: AppHandle) -> Result<Value, String> {
    json_command(
        &executable(&app)?,
        vec!["backup".into(), "--list".into(), "--json".into()],
        &[],
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareOptions {
    archive: String,
    password: String,
    mode: String,
    data_dir: String,
    database_path: String,
    config_dir: String,
    base_url: String,
    host: String,
    port: String,
    trusted_origins: String,
    recover_admin: String,
    temporary_password: String,
}

#[tauri::command(async)]
pub fn desktop_restore_prepare(app: AppHandle, options: PrepareOptions) -> Result<Value, String> {
    let _guard = control::ActionGuard::try_new().ok_or("Another server action is running.")?;
    let argv = executable(&app)?;
    if !["same-machine", "migration"].contains(&options.mode.as_str()) {
        return Err("Choose a restore mode.".into());
    }
    let mut args = vec![
        "restore".into(),
        options.archive,
        "--prepare".into(),
        "--no-start".into(),
        "--json".into(),
        "--mode".into(),
        options.mode,
    ];
    for (flag, value) in [
        ("--data-dir", options.data_dir),
        ("--database-path", options.database_path),
        ("--config-dir", options.config_dir),
        ("--base-url", options.base_url),
        ("--host", options.host),
        ("--port", options.port),
        ("--trusted-origins", options.trusted_origins),
    ] {
        if !value.is_empty() {
            args.extend([flag.into(), value]);
        }
    }
    let password = if options.password.is_empty() {
        None
    } else {
        Some(SecretFile::new(&options.password)?)
    };
    if let Some(secret) = &password {
        secret.flag(&mut args, "--password-file");
    }
    let temporary = if options.recover_admin.is_empty() {
        None
    } else {
        args.extend(["--recover-admin".into(), options.recover_admin]);
        Some(SecretFile::temporary(&options.temporary_password)?)
    };
    if let Some(secret) = &temporary {
        secret.flag(&mut args, "--temporary-password-file");
    }
    json_command(&argv, args, &[&options.password, &options.temporary_password])
}

#[tauri::command(async)]
pub fn desktop_restore_discard(app: AppHandle, staged: String) -> Result<(), String> {
    let _guard = control::ActionGuard::try_new().ok_or("Another server action is running.")?;
    stage_args(&staged)?;
    json_command(
        &executable(&app)?,
        vec!["restore".into(), "--discard-staged".into(), staged, "--json".into()],
        &[],
    )?;
    Ok(())
}

/// A pause owns only this app's child. Any error before replacement resumes
/// its previous supervision; a completed no-start deliberately stays stopped.
struct PausedChild<'a> {
    supervisor: &'a supervisor::Supervisor,
    previous: Option<std::sync::Arc<dyn supervisor::Spawner>>,
    resume: bool,
}
impl Drop for PausedChild<'_> {
    fn drop(&mut self) {
        if self.resume {
            if let Some(spawner) = self.previous.take() {
                self.supervisor.start(spawner);
            }
        }
    }
}

#[tauri::command(async)]
pub fn desktop_restore_apply(
    app: AppHandle,
    staged: String,
    confirmed: bool,
    force: bool,
    start: bool,
) -> Result<Value, String> {
    let _guard = control::ActionGuard::try_new().ok_or("Another server action is running.")?;
    if !confirmed {
        return Err("Confirm replacement of the displayed destination before restoring.".into());
    }
    let argv = executable(&app)?;
    let mut inspection = stage_args(&staged)?;
    inspection.extend(["--inspect".into(), "--json".into()]);
    let stage = json_command(&argv, inspection, &[])?;
    if stage.get("prepared").and_then(Value::as_bool) != Some(true) {
        return Err("This restore is not prepared.".into());
    }
    let restore_location = RestoreLocation::from_inspection(&stage)?;
    let transaction_id = stage
        .get("transactionId")
        .and_then(Value::as_str)
        .ok_or("Prepared restore has no reserved transaction identifier.")?;
    if transaction_id != staged {
        return Err("Prepared restore transaction identity does not match its stage.".into());
    }
    let journal_path = PathBuf::from(
        stage
            .get("journalPath")
            .and_then(Value::as_str)
            .ok_or("Prepared restore has no journal destination.")?,
    );
    let settings = app.state::<SettingsState>();
    let prior_outcome = reconcile_selection(&app)?;
    if prior_outcome == SelectionOutcome::Pending || selection_blocks_boot() {
        return Err("A native restore is pending. Start or recover that restore before applying another.".into());
    }
    // This read-only proof runs before even the app-owned child's stop. The
    // applying command repeats it so a manager change cannot bypass the guard.
    let mut preflight = stage_args(&staged)?;
    preflight.extend(["--native-preflight".into(), "--json".into()]);
    json_command(&argv, preflight, &[])?;
    let previous_settings = settings.get();
    let probe = control::probe_now(previous_settings.binary_path.as_deref(), previous_settings.supervision);
    let service_mode = probe.supervision == Supervision::Service && control::service_installed_json(&settings);
    if service_mode {
        let service_binary = server_bin::candidates(None)
            .into_iter()
            .find(|(source, _)| *source == server_bin::ServerSource::Service)
            .ok_or("Cannot resolve the installed service executable; no server was stopped.")?;
        let mut help = service_binary.1;
        help.push("--help".into());
        if !run(&help, Duration::from_secs(10)).stdout.contains("--prepare") {
            return Err("The installed service needs an update before it can confirm restore boot. Update the server before restoring.".into());
        }
    }
    if std::env::var_os("SUBSHELL_SERVER_BIN").is_some()
        && probe.server.as_ref().is_some_and(|server| server.argv != argv)
    {
        return Err("The explicit server binary does not support restore boot confirmation. Update SUBSHELL_SERVER_BIN before restoring.".into());
    }
    let previous_location = match protected_read(&location_file().ok_or("Cannot locate desktop settings.")?)? {
        Some(bytes) => Some(decode_location(&bytes).ok_or("Invalid prior native restore location.")?),
        None => None,
    };
    let previous_config_dir = previous_location
        .as_ref()
        .map(|location| location.config_dir.clone())
        .or_else(|| std::env::var_os("SUBSHELL_SERVER_CONFIG_DIR").map(PathBuf::from))
        .or_else(|| {
            probe
                .status
                .as_ref()
                .and_then(|status| status.pointer("/configEnv/path"))
                .and_then(Value::as_str)
                .and_then(|path| Path::new(path).parent().map(Path::to_path_buf))
        });
    let next_binary = if !service_mode
        && server_bin::resolve(previous_settings.binary_path.as_deref())
            .as_ref()
            .is_none_or(|server| server.argv != argv)
    {
        argv.first().cloned()
    } else {
        previous_settings.binary_path.clone()
    };
    let mut transaction = SelectionTransaction {
        version: 1,
        transaction_id: transaction_id.to_string(),
        receipt_path: journal_path.with_file_name("restore-result.json"),
        journal_path,
        previous: NativeSelection {
            location: previous_location,
            config_dir: previous_config_dir,
            binary_path: previous_settings.binary_path,
            supervision: previous_settings.supervision,
        },
        next: NativeSelection {
            config_dir: Some(restore_location.config_dir.clone()),
            location: Some(restore_location),
            binary_path: next_binary,
            supervision: if service_mode {
                Supervision::Service
            } else {
                Supervision::App
            },
        },
        phase: SelectionPhase::Applying,
        start_requested: start,
    };
    let sup = app.state::<supervisor::Supervisor>();
    let previous = sup.spawner();
    let was_running = sup.snapshot().desired_running;
    if was_running && !force {
        return Err(
            "Stopping the app server may interrupt active panes. Confirm pane interruption before restoring.".into(),
        );
    }
    // Publish both choices and the reserved engine identity BEFORE any stop or
    // application. A crash on either side of the CLI response is recoverable.
    write_selection(&selection_file()?, &transaction)?;
    *PRIOR_ENVIRONMENT.lock().unwrap_or_else(|e| e.into_inner()) =
        Some((transaction.transaction_id.clone(), EnvironmentSelection::capture()));
    let mut paused = PausedChild {
        supervisor: &sup,
        previous,
        resume: was_running,
    };
    if let Some(spawner) = &paused.previous {
        if !sup.stop(spawner.as_ref()) {
            remove_durable(&selection_file()?)?;
            return Err("The app's server did not stop; nothing was restored.".into());
        }
    }
    let mut args = stage_args(&staged)?;
    args.extend([
        "--native".into(),
        "--yes".into(),
        "--json".into(),
        if service_mode && start { "--start" } else { "--no-start" }.into(),
    ]);
    if force {
        args.push("--force".into());
    }
    let mut result = match json_command(&argv, args, &[]) {
        Ok(result) => result,
        Err(error) => {
            // Only a known pre-application failure can resume the old child.
            // A matching receipt/journal instead governs durable recovery.
            if !transaction.journal_path.exists()
                && !matches!(
                    engine_outcome(&transaction),
                    Ok(SelectionOutcome::Completed | SelectionOutcome::RolledBack)
                )
            {
                remove_durable(&selection_file()?)?;
                return Err(error);
            }
            paused.resume = false;
            return match reconcile_selection(&app) {
                Ok(SelectionOutcome::RolledBack) => {
                    paused.resume = was_running;
                    Err(format!("{error} Its previous native selection was restored."))
                }
                Err(recovery) => Err(format!("{error} {recovery}")),
                _ => Err(format!(
                    "{error} The native restore remains recorded; the app server stays stopped."
                )),
            };
        }
    };
    paused.resume = false;
    if result.get("transactionId").and_then(Value::as_str) != Some(transaction.transaction_id.as_str()) {
        return Err("Applied restore returned an unexpected transaction identity. The native transaction remains pending and the app server stays stopped.".into());
    }
    transaction.phase = SelectionPhase::PendingBoot;
    write_selection(&selection_file()?, &transaction)
        .map_err(|error| format!("Restore was applied; its native selection remains pending: {error}"))?;
    if finish_applied_selection(&mut paused, was_running, reconcile_selection(&app))? == SelectionOutcome::Completed {
        result["status"] = "completed".into();
    }
    if !service_mode && start {
        let spawner = control::server_spawner(&app)?;
        if selection_blocks_boot() {
            sup.start_once(spawner);
        } else {
            sup.start(spawner);
        }
        finish_restore_attempt(&mut paused, was_running, finish_selection_start(&app))?;
        result["status"] = "completed".into();
        result["started"] = true.into();
    }
    let refreshed = control::probe_now(settings.get().binary_path.as_deref(), settings.get().supervision);
    control::mark_onboarded(refreshed.next, &settings);
    Ok(result)
}

fn wait_receipt(path: &Path, transaction: &str, bound: Duration) -> Result<(), String> {
    let deadline = Instant::now() + bound;
    loop {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(receipt) = serde_json::from_str::<Value>(&text) {
                if receipt.get("transactionId").and_then(Value::as_str) == Some(transaction) {
                    match receipt.get("outcome").and_then(Value::as_str) {
                        Some("completed") => return Ok(()),
                        Some("rolled-back") => {
                            return Err("The restored server could not boot. Its previous state was restored.".into())
                        }
                        _ => {}
                    }
                }
            }
        }
        if Instant::now() >= deadline {
            return Err("The restored server has not confirmed a successful boot. The restore transaction remains pending; open Status before retrying.".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// Trusted per-app boot selection. A legacy archive deliberately leaves
/// config.env unchanged, so its exact database/data paths must survive a later
/// ordinary Start and a cold app reopen independently of that file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RestoreLocation {
    pub config_dir: PathBuf,
    pub database_path: PathBuf,
    pub data_dir: PathBuf,
    pub legacy_database_only: bool,
}

/// Mirrors the CLI's supported archive configuration contract. The unit test
/// pins this list against the server source to catch a future policy addition.
const RESTORED_CONFIG_KEYS: &[&str] = &[
    "BETTER_AUTH_SECRET",
    "SERVER_PORT",
    "HOST",
    "APP_BASE_URL",
    "TRUSTED_ORIGINS",
    "DATABASE_PATH",
    "SUBSHELL_SERVER_DATA_DIR",
    "SUBSHELL_LOG_RETENTION_DAYS",
    "SUBSHELL_DB_BACKUPS_KEEP",
    "SUBSHELL_RELEASE_URL",
    "SUBSHELL_PLUGIN_REGISTRY_URL",
    "NODE_ENV",
    "SUBSHELL_FS_ROOT",
    "SUBSHELL_DEBUG_LOGGING",
    "SUBSHELL_TERMINAL_REPLAY_LINES",
];

fn controlled_restore_key(key: &str) -> bool {
    RESTORED_CONFIG_KEYS.contains(&key)
        || key.starts_with("SUBSHELL_SUPERVISOR")
        || [
            "SUBSHELL_SERVER_CONFIG_DIR",
            "SUBSHELL_TEST_MODE",
            "SUBSHELL_EMERGENCY_PASSWORD",
        ]
        .contains(&key)
}

impl RestoreLocation {
    fn from_inspection(stage: &Value) -> Result<Self, String> {
        let destination = stage
            .get("destination")
            .ok_or("Prepared restore has no validated destination.")?;
        let path = |key: &str| -> Result<PathBuf, String> {
            let value = destination
                .get(key)
                .and_then(Value::as_str)
                .ok_or("Prepared restore destination is incomplete.")?;
            let path = PathBuf::from(value);
            if !path.is_absolute() {
                return Err("Prepared restore destination must be absolute.".into());
            }
            Ok(path)
        };
        let config_path = path("configPath")?;
        Ok(Self {
            config_dir: config_path
                .parent()
                .ok_or("Invalid restore configuration destination.")?
                .to_path_buf(),
            database_path: path("databasePath")?,
            data_dir: path("dataDir")?,
            legacy_database_only: stage
                .get("legacyDatabaseOnly")
                .and_then(Value::as_bool)
                .ok_or("Prepared restore has no archive type.")?,
        })
    }
    fn valid(&self) -> bool {
        safe_absolute(&self.config_dir) && safe_absolute(&self.database_path) && safe_absolute(&self.data_dir)
    }
    fn environment_values(&self) -> Vec<(&'static str, &std::ffi::OsStr)> {
        let mut values = vec![("SUBSHELL_SERVER_CONFIG_DIR", self.config_dir.as_os_str())];
        if self.legacy_database_only {
            values.extend([
                ("DATABASE_PATH", self.database_path.as_os_str()),
                ("SUBSHELL_SERVER_DATA_DIR", self.data_dir.as_os_str()),
            ]);
        }
        values
    }
}

/// Apply the restore policy to every actual child command, including a later
/// ordinary Start. Re-read config.env in the restored cwd; never copy auth or
/// address values into desktop metadata and never inherit their stale values.
pub(crate) fn configure_restored_child(command: &mut std::process::Command, location: &RestoreLocation) {
    for key in RESTORED_CONFIG_KEYS {
        command.env_remove(key);
    }
    for key in [
        "SUBSHELL_SUPERVISOR",
        "SUBSHELL_SUPERVISOR_PID",
        "SUBSHELL_SUPERVISOR_LOG",
        "SUBSHELL_TEST_MODE",
        "SUBSHELL_EMERGENCY_PASSWORD",
    ] {
        command.env_remove(key);
    }
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("SUBSHELL_SUPERVISOR") {
            command.env_remove(key);
        }
    }
    for (key, value) in location.environment_values() {
        command.env(key, value);
    }
}

/// Probe/CLI queries must describe the same restored instance as the child.
/// This also clears a previous legacy selection when selecting a full archive.
fn activate_location(location: &RestoreLocation) {
    let keys: Vec<_> = std::env::vars_os()
        .filter(|(key, _)| controlled_restore_key(&key.to_string_lossy()))
        .map(|(key, _)| key)
        .collect();
    for key in keys {
        std::env::remove_var(key);
    }
    for (key, value) in location.environment_values() {
        std::env::set_var(key, value);
    }
}

struct EnvironmentSelection(Vec<(String, Option<std::ffi::OsString>)>);
impl EnvironmentSelection {
    fn capture() -> Self {
        let mut keys: Vec<String> = RESTORED_CONFIG_KEYS.iter().map(|key| (*key).to_string()).collect();
        keys.extend(
            [
                "SUBSHELL_SERVER_CONFIG_DIR",
                "SUBSHELL_TEST_MODE",
                "SUBSHELL_EMERGENCY_PASSWORD",
                "SUBSHELL_SUPERVISOR",
                "SUBSHELL_SUPERVISOR_PID",
                "SUBSHELL_SUPERVISOR_LOG",
            ]
            .into_iter()
            .map(String::from),
        );
        keys.extend(
            std::env::vars_os()
                .filter(|(key, _)| key.to_string_lossy().starts_with("SUBSHELL_SUPERVISOR"))
                .map(|(key, _)| key.to_string_lossy().into_owned()),
        );
        keys.sort();
        keys.dedup();
        Self(
            keys.into_iter()
                .map(|key| {
                    let value = std::env::var_os(&key);
                    (key, value)
                })
                .collect(),
        )
    }
    fn restore(&self) {
        for (key, value) in &self.0 {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

fn location_file() -> Option<PathBuf> {
    SETTINGS_PATHS.file()?.parent().map(|p| p.join("restore-location.json"))
}
fn decode_location(text: &[u8]) -> Option<RestoreLocation> {
    let value: RestoreLocation = serde_json::from_slice(text).ok()?;
    value.valid().then_some(value)
}
pub(crate) fn restored_location() -> Option<RestoreLocation> {
    decode_location(&std::fs::read(location_file()?).ok()?)
}
fn write_private_json(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Cannot locate desktop settings.")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let metadata = std::fs::symlink_metadata(parent).map_err(|e| e.to_string())?;
    if !metadata.is_dir() {
        return Err("Desktop restore metadata directory is not a real directory.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != current_uid() {
            return Err("Desktop restore metadata directory belongs to another user.".into());
        }
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    let temporary = path.with_extension(format!(
        "pending-{}-{}",
        std::process::id(),
        SECRET_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut writer = options.open(&temporary).map_err(|e| e.to_string())?;
        writer.write_all(bytes).map_err(|e| e.to_string())?;
        writer.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&temporary, path).map_err(|e| e.to_string())?;
        sync_parent(path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}
fn write_location(path: &Path, location: &RestoreLocation) -> Result<(), String> {
    if !location.valid() {
        return Err("Invalid restore location.".into());
    }
    write_private_json(path, &serde_json::to_vec(location).map_err(|e| e.to_string())?)
}
pub(crate) fn load_location() {
    INITIAL_ENVIRONMENT.get_or_init(EnvironmentSelection::capture);
    if let Some(location) = restored_location() {
        activate_location(&location);
    }
}

/// Only non-secret boot choices cross the durable boundary. The original
/// process environment is captured before activation and never serialized.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeSelection {
    location: Option<RestoreLocation>,
    config_dir: Option<PathBuf>,
    binary_path: Option<String>,
    supervision: Supervision,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum SelectionPhase {
    Applying,
    PendingBoot,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SelectionTransaction {
    version: u8,
    transaction_id: String,
    journal_path: PathBuf,
    receipt_path: PathBuf,
    previous: NativeSelection,
    next: NativeSelection,
    phase: SelectionPhase,
    start_requested: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SelectionOutcome {
    None,
    Pending,
    Completed,
    RolledBack,
}
static INITIAL_ENVIRONMENT: std::sync::OnceLock<EnvironmentSelection> = std::sync::OnceLock::new();
static PRIOR_ENVIRONMENT: std::sync::Mutex<Option<(String, EnvironmentSelection)>> = std::sync::Mutex::new(None);

fn selection_file() -> Result<PathBuf, String> {
    Ok(location_file()
        .ok_or("Cannot locate desktop settings.")?
        .with_file_name("restore-selection.json"))
}
fn safe_absolute(path: &Path) -> bool {
    path.is_absolute()
        && path.parent().is_some()
        && !path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
}
impl NativeSelection {
    fn valid(&self) -> bool {
        self.location.as_ref().is_none_or(RestoreLocation::valid)
            && self.config_dir.as_ref().is_none_or(|path| safe_absolute(path))
            && self
                .binary_path
                .as_ref()
                .is_none_or(|path| safe_absolute(Path::new(path)))
    }
}
impl SelectionTransaction {
    fn valid(&self) -> bool {
        self.version == 1
            && stage_args(&self.transaction_id).is_ok()
            && self.previous.valid()
            && self.next.valid()
            && safe_absolute(&self.journal_path)
            && safe_absolute(&self.receipt_path)
            && self.next.location.as_ref().is_some_and(|location| {
                self.journal_path == location.config_dir.join("restore-journal.json")
                    && self.receipt_path == location.config_dir.join("restore-result.json")
            })
    }
}

fn protected_read(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(info) => info,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() || metadata.len() > 64 * 1024 {
        return Err("Invalid restore selection metadata.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // The parent is created privately by this app; refuse a foreign or
        // exposed file, including a symlink, instead of trusting its paths.
        if metadata.mode() & 0o077 != 0 || metadata.uid() != current_uid() {
            return Err("Restore selection metadata must be private and owned by this user.".into());
        }
    }
    std::fs::read(path).map(Some).map_err(|error| error.to_string())
}
#[cfg(unix)]
fn current_uid() -> u32 {
    extern "C" {
        fn getuid() -> u32;
    }
    // POSIX getuid has no pointer arguments or failure mode.
    unsafe { getuid() }
}
fn read_selection(path: &Path) -> Result<Option<SelectionTransaction>, String> {
    let Some(bytes) = protected_read(path)? else {
        return Ok(None);
    };
    let transaction: SelectionTransaction =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid restore selection metadata.")?;
    if !transaction.valid() {
        return Err("Invalid restore selection paths or transaction identity.".into());
    }
    Ok(Some(transaction))
}
fn sync_parent(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    std::fs::File::open(path.parent().ok_or("Missing metadata parent.")?)
        .and_then(|file| file.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn remove_durable(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => sync_parent(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
fn write_selection(path: &Path, transaction: &SelectionTransaction) -> Result<(), String> {
    if !transaction.valid() {
        return Err("Invalid native restore transaction.".into());
    }
    write_private_json(path, &serde_json::to_vec(transaction).map_err(|e| e.to_string())?)
}
fn engine_outcome(transaction: &SelectionTransaction) -> Result<SelectionOutcome, String> {
    if let Some(bytes) = protected_read(&transaction.receipt_path)? {
        let receipt: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid restore result receipt.")?;
        if receipt.get("transactionId").and_then(Value::as_str) == Some(transaction.transaction_id.as_str()) {
            return match receipt.get("outcome").and_then(Value::as_str) {
                Some("completed") => Ok(SelectionOutcome::Completed),
                Some("rolled-back") => Ok(SelectionOutcome::RolledBack),
                _ => Err("Invalid matching restore result receipt.".into()),
            };
        }
    }
    if let Some(bytes) = protected_read(&transaction.journal_path)? {
        let journal: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid restore journal identity.")?;
        if journal.get("transactionId").and_then(Value::as_str) == Some(transaction.transaction_id.as_str()) {
            return Ok(SelectionOutcome::Pending);
        }
        return Err(
            "Another restore journal replaced the expected native transaction. The app server stays stopped.".into(),
        );
    }
    Err("The native restore has no matching journal or result receipt. Its selection remains pending and the app server stays stopped.".into())
}
fn apply_selection(
    selection: &NativeSelection,
    transaction: &str,
    previous: bool,
    save_settings: &impl Fn(&NativeSelection) -> Result<(), String>,
    location_path: &Path,
) -> Result<(), String> {
    match &selection.location {
        Some(location) => write_location(location_path, location)?,
        None => remove_durable(location_path)?,
    }
    save_settings(selection)?;
    if let Some(location) = &selection.location {
        activate_location(location);
    } else if previous {
        let environment = PRIOR_ENVIRONMENT.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, snapshot)) = environment.as_ref().filter(|(id, _)| id == transaction) {
            snapshot.restore();
        } else if let Some(environment) = INITIAL_ENVIRONMENT.get() {
            environment.restore();
        }
        if let Some(config_dir) = &selection.config_dir {
            std::env::set_var("SUBSHELL_SERVER_CONFIG_DIR", config_dir);
        }
    }
    Ok(())
}
/// Reconciliation is idempotent. Keep the transaction through every metadata
/// failure so a later probe/reopen can retry without claiming recovery.
fn reconcile_files(
    transaction_path: &Path,
    location_path: &Path,
    save_settings: impl Fn(&NativeSelection) -> Result<(), String>,
    stop: impl FnOnce() -> Result<(), String>,
) -> Result<SelectionOutcome, String> {
    let Some(transaction) = read_selection(transaction_path)? else {
        return Ok(SelectionOutcome::None);
    };
    let outcome = engine_outcome(&transaction)?;
    if outcome == SelectionOutcome::RolledBack {
        stop()?;
    }
    let selected = if outcome == SelectionOutcome::RolledBack {
        &transaction.previous
    } else {
        &transaction.next
    };
    apply_selection(
        selected,
        &transaction.transaction_id,
        outcome == SelectionOutcome::RolledBack,
        &save_settings,
        location_path,
    )?;
    if outcome != SelectionOutcome::Pending {
        remove_durable(transaction_path)?;
        *PRIOR_ENVIRONMENT.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
    Ok(outcome)
}
pub(crate) fn reconcile_selection(app: &AppHandle) -> Result<SelectionOutcome, String> {
    let sup = app.state::<supervisor::Supervisor>();
    // Old location files also fail closed: losing/corrupting the pending
    // transaction must not make an invalid destination look like defaults.
    if let Some(bytes) = protected_read(&location_file().ok_or("Cannot locate desktop settings.")?)? {
        decode_location(&bytes).ok_or("Invalid native restore location metadata.")?;
    }
    let outcome = reconcile_files(
        &selection_file()?,
        &location_file().ok_or("Cannot locate desktop settings.")?,
        |selection| {
            app.state::<SettingsState>().update(|s| {
                s.binary_path = selection.binary_path.clone();
                s.supervision = selection.supervision;
            })?;
            // SettingsState's rename is atomic; complete its durability before
            // removing the receipt-bound selection transaction.
            let file = SETTINGS_PATHS.file().ok_or("Cannot locate desktop settings.")?;
            std::fs::File::open(&file)
                .and_then(|file| file.sync_all())
                .map_err(|error| error.to_string())?;
            sync_parent(&file)
        },
        || {
            if let Some(spawner) = sup.spawner() {
                if !sup.stop(spawner.as_ref()) {
                    return Err("The failed restored child did not stop; prior selection was not restored.".into());
                }
            }
            Ok(())
        },
    );
    match &outcome {
        Ok(SelectionOutcome::Completed) => {
            if let Some(spawner) = sup.spawner() {
                if sup.snapshot().pid.is_some() {
                    sup.start(spawner);
                }
            }
        }
        Err(_) => {
            if let Some(spawner) = sup.spawner() {
                let _ = sup.stop(spawner.as_ref());
            }
        }
        _ => {}
    }
    outcome
}
pub(crate) fn poll_selection(app: &AppHandle) -> Result<SelectionOutcome, String> {
    let Some(_guard) = control::ActionGuard::try_new() else {
        return Ok(SelectionOutcome::None);
    };
    reconcile_selection(app)
}
/// A pending restore is deliberately never auto-started on reopening. Human
/// Start verifies its engine identity and runs a single boot attempt.
pub(crate) fn selection_blocks_boot() -> bool {
    selection_file().map(|path| path.exists()).unwrap_or(true)
}
pub(crate) fn begin_selection_start(app: &AppHandle) -> Result<bool, String> {
    let outcome = reconcile_selection(app)?;
    if outcome == SelectionOutcome::RolledBack {
        return Err("The restored server failed during boot. Its previous native selection was restored; choose Start again to start it.".into());
    }
    let path = selection_file()?;
    let Some(mut transaction) = read_selection(&path)? else {
        return Ok(false);
    };
    transaction.start_requested = true;
    write_selection(&path, &transaction)?;
    Ok(true)
}
/// A server rollback receipt and successful native rollback reconciliation
/// are separate facts. Only the latter authorizes resuming the prior child.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SelectionStartFailure {
    ReconciledRollback,
    Recovery(String),
}
impl std::fmt::Display for SelectionStartFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ReconciledRollback => formatter
                .write_str("The restored server failed during boot. Its previous native selection was restored."),
            Self::Recovery(error) => formatter.write_str(error),
        }
    }
}
fn finish_applied_selection(
    paused: &mut PausedChild<'_>,
    was_running: bool,
    reconciled: Result<SelectionOutcome, String>,
) -> Result<SelectionOutcome, String> {
    match reconciled {
        Ok(SelectionOutcome::RolledBack) => {
            finish_restore_attempt(paused, was_running, Err(SelectionStartFailure::ReconciledRollback))
                .map(|()| SelectionOutcome::RolledBack)
        }
        Err(error) => finish_restore_attempt(paused, was_running, Err(SelectionStartFailure::Recovery(error)))
            .map(|()| SelectionOutcome::None),
        Ok(outcome) => Ok(outcome),
    }
}
fn finish_restore_attempt(
    paused: &mut PausedChild<'_>,
    was_running: bool,
    result: Result<(), SelectionStartFailure>,
) -> Result<(), String> {
    match result {
        Ok(()) => Ok(()),
        Err(SelectionStartFailure::ReconciledRollback) => {
            paused.resume = was_running;
            Err(SelectionStartFailure::ReconciledRollback.to_string())
        }
        Err(error) => {
            paused.resume = false;
            Err(error.to_string())
        }
    }
}
fn classify_selection_start(
    reconciled: Result<SelectionOutcome, String>,
    waited: Result<(), String>,
    stop: impl FnOnce() -> Result<(), String>,
) -> Result<(), SelectionStartFailure> {
    match reconciled {
        Ok(SelectionOutcome::Completed) => Ok(()),
        Ok(SelectionOutcome::RolledBack) => Err(SelectionStartFailure::ReconciledRollback),
        Err(error) => Err(SelectionStartFailure::Recovery(error)),
        _ => {
            stop().map_err(SelectionStartFailure::Recovery)?;
            waited.map_err(SelectionStartFailure::Recovery)?;
            Err(SelectionStartFailure::Recovery(
                "The restored server has not supplied its matching completion receipt.".into(),
            ))
        }
    }
}
pub(crate) fn finish_selection_start(app: &AppHandle) -> Result<(), SelectionStartFailure> {
    let Some(transaction) = read_selection(&selection_file().map_err(SelectionStartFailure::Recovery)?)
        .map_err(SelectionStartFailure::Recovery)?
    else {
        return Ok(());
    };
    let waited = wait_receipt(&transaction.receipt_path, &transaction.transaction_id, BOOT_BOUND);
    classify_selection_start(reconcile_selection(app), waited, || {
        let sup = app.state::<supervisor::Supervisor>();
        if let Some(spawner) = sup.spawner() {
            if !sup.stop(spawner.as_ref()) {
                return Err(
                    "The unconfirmed restored child did not stop; the native selection remains pending.".into(),
                );
            }
        }
        Ok(())
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn password_utf16_bounds_match_ui_and_cli_protected_transport() {
        let cases = [
            ("é".repeat(3000), false),
            ("😀".repeat(2048), false),
            ("😀".repeat(4), true),
        ];
        for (password, temporary) in cases {
            let secret = if temporary {
                SecretFile::temporary(&password)
            } else {
                SecretFile::new(&password)
            }
            .unwrap();
            assert_eq!(std::fs::read_to_string(&secret.0).unwrap(), password);
            assert!(std::fs::metadata(&secret.0).unwrap().len() <= 16_384);
            // Rust-only CI intentionally has no JS node_modules. Enable this
            // additional real CLI interop check in the root Bun environment.
            if std::env::var_os("SUBSHELL_DESKTOP_PASSWORD_CLI_CHECK").is_some() {
                let server = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../api/src");
                let recovery = secret.0.with_extension("sqlite");
                let script = format!(
                    r#"
import {{readPasswordFile}} from {};
import {{prepareBackupAdminRecovery}} from {};
import {{Database}} from "bun:sqlite";
import {{rmSync}} from "node:fs";
const password=readPasswordFile(process.argv[1]);
if(password.length!==Number(process.argv[2])) throw new Error("CLI UTF-16 length mismatch");
if(process.argv[3]==="temporary") {{
  const path=process.argv[4]; const db=new Database(path);
  db.exec("CREATE TABLE user(id TEXT PRIMARY KEY,email TEXT);CREATE TABLE user_meta(user_id TEXT PRIMARY KEY,role TEXT);CREATE TABLE account(id TEXT PRIMARY KEY,accountId TEXT,providerId TEXT,userId TEXT,password TEXT,createdAt TEXT,updatedAt TEXT);CREATE TABLE session(userId TEXT);");
  db.query("INSERT INTO user VALUES(?,?)").run("admin","admin@example.com");
  db.query("INSERT INTO user_meta VALUES(?,?)").run("admin","admin"); db.close();
  await prepareBackupAdminRecovery(path,"admin",password);
  const check=new Database(path);if(!check.query("SELECT password FROM account WHERE userId='admin'").get())throw new Error("Recovery password not prepared");check.close();rmSync(path);
}}
console.log("native password interoperable");
"#,
                    serde_json::to_string(&server.join("commands/backup-password.ts")).unwrap(),
                    serde_json::to_string(&server.join("services/backup-admin-recovery.ts")).unwrap()
                );
                let output = std::process::Command::new("bun")
                    .current_dir(server.parent().unwrap())
                    .args([
                        "--eval",
                        &script,
                        &secret.0.to_string_lossy(),
                        &password.encode_utf16().count().to_string(),
                        if temporary { "temporary" } else { "archive" },
                        &recovery.to_string_lossy(),
                    ])
                    .output()
                    .expect("root interop check needs Bun");
                assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
                assert!(String::from_utf8_lossy(&output.stdout).contains("native password interoperable"));
            }
        }
        for password in [
            "é".repeat(4097),
            "😀".repeat(2049),
            "line\rbreak".into(),
            "line\nbreak".into(),
            "nul\0value".into(),
        ] {
            assert!(SecretFile::new(&password).is_err());
        }
        assert!(SecretFile::temporary(&"😀".repeat(3)).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn public_schema_accepts_password_collisions_and_withholds_unknown_secret_echoes() {
        let (root, _) = location_fixture(false);
        let output_file = root.join("cli-output.json");
        let argv = vec![
            "/bin/sh".into(),
            "-c".into(),
            "cat \"$1\"".into(),
            "fixture".into(),
            output_file.to_string_lossy().into_owned(),
        ];
        let manifest = serde_json::json!({"sourcePaths":{"databasePath":"/backup/instance.db","dataDir":"/backup/data","configPath":"/backup/config/config.env"},"format":"subshell-instance","version":1,"serverVersion":"1.3.4","startedAt":"2026-10-02T00:00:00Z","completedAt":"2026-10-02T00:00:01Z","consistency":"sqlite-snapshot-logs-over-interval","migrations":["0001-init"],"entries":[{"path":"database/instance.db","bytes":8192,"sha256":"a".repeat(64)}],"exclusions":["external agent credentials"]});
        let backup = serde_json::json!({"path":"/tmp/database.subshell","bytes":1024,"manifest":manifest,"credentials":{"auth":"different-secret-never-forwarded"}});
        std::fs::write(&output_file, serde_json::to_vec(&backup).unwrap()).unwrap();
        for password in ["database", "subshell-instance", "external agent credentials"] {
            let result = json_command(&argv, vec!["backup".into()], &[password]).unwrap();
            assert_eq!(result["manifest"], manifest);
            assert!(result.get("credentials").is_none());
            assert!(!result.to_string().contains("different-secret-never-forwarded"));
        }
        // Public administrator names are also allowed to equal the password.
        let inspection = serde_json::json!({"manifest":manifest,"admins":[{"id":"admin","name":"database","email":"admin@example.com"}],"legacyDatabaseOnly":false});
        std::fs::write(&output_file, serde_json::to_vec(&inspection).unwrap()).unwrap();
        assert_eq!(
            json_command(&argv, vec!["restore".into(), "--inspect".into()], &["database"]).unwrap(),
            inspection
        );
        let mut echoed = backup.clone();
        echoed["detail"] = "The archive password is database".into();
        std::fs::write(&output_file, serde_json::to_vec(&echoed).unwrap()).unwrap();
        let error = json_command(&argv, vec!["backup".into()], &["database"]).unwrap_err();
        assert_eq!(error, SENSITIVE_PUBLIC_OUTPUT);
        assert!(!error.contains("database"));
        let mut nested = backup.clone();
        nested["manifest"]["entries"][0]["password"] = "database".into();
        std::fs::write(&output_file, serde_json::to_vec(&nested).unwrap()).unwrap();
        assert_eq!(
            json_command(&argv, vec!["backup".into()], &["database"]).unwrap_err(),
            SENSITIVE_PUBLIC_OUTPUT
        );
        let mut malformed = backup.clone();
        malformed["bytes"] = "untrusted string".into();
        std::fs::write(&output_file, serde_json::to_vec(&malformed).unwrap()).unwrap();
        assert_eq!(
            json_command(&argv, vec!["backup".into()], &["database"]).unwrap_err(),
            INVALID_PUBLIC_OUTPUT
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    fn selection_fixture() -> (PathBuf, PathBuf, PathBuf, SelectionTransaction) {
        let (root, next) = location_fixture(true);
        let previous = RestoreLocation {
            config_dir: root.join("prior-config"),
            database_path: root.join("prior.sqlite"),
            data_dir: root.join("prior-data"),
            legacy_database_only: false,
        };
        let transaction = SelectionTransaction {
            version: 1,
            transaction_id: "61616161-6161-4161-8161-616161616161".into(),
            journal_path: next.config_dir.join("restore-journal.json"),
            receipt_path: next.config_dir.join("restore-result.json"),
            previous: NativeSelection {
                config_dir: Some(previous.config_dir.clone()),
                location: Some(previous),
                binary_path: Some(root.join("old-server").to_string_lossy().into_owned()),
                supervision: Supervision::Service,
            },
            next: NativeSelection {
                config_dir: Some(next.config_dir.clone()),
                location: Some(next),
                binary_path: Some(root.join("new-server").to_string_lossy().into_owned()),
                supervision: Supervision::App,
            },
            phase: SelectionPhase::PendingBoot,
            start_requested: false,
        };
        let record = root.join("desktop/restore-selection.json");
        let location = root.join("desktop/restore-location.json");
        write_selection(&record, &transaction).unwrap();
        (root, record, location, transaction)
    }
    fn receipt_fixture(transaction: &SelectionTransaction, id: &str, outcome: &str) {
        write_private_json(
            &transaction.receipt_path,
            &serde_json::to_vec(
                &serde_json::json!({"transactionId":id,"outcome":outcome,"completedAt":"2026-10-02T01:00:00Z"}),
            )
            .unwrap(),
        )
        .unwrap();
        remove_durable(&transaction.journal_path).unwrap();
    }
    #[test]
    fn selection_transactions_survive_no_start_later_failure_and_cold_reopen_in_isolated_process() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "backup_restore::tests::selection_transaction_fixture",
                "--nocapture",
            ])
            .env("SUBSHELL_DESKTOP_RESTORE_SELECTION_FIXTURE", "1")
            .env("BETTER_AUTH_SECRET", "parent-secret-that-must-never-be-persisted")
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert!(String::from_utf8(output.stdout).unwrap().contains("1 passed"));
    }
    #[test]
    fn selection_transaction_fixture() {
        if std::env::var_os("SUBSHELL_DESKTOP_RESTORE_SELECTION_FIXTURE").is_none() {
            return;
        }
        INITIAL_ENVIRONMENT.get_or_init(EnvironmentSelection::capture);
        let (root, record, location, transaction) = selection_fixture();
        let selected = root.join("desktop/test-settings.json");
        let save = |selection: &NativeSelection| write_private_json(&selected, &serde_json::to_vec(selection).unwrap());
        let pending = serde_json::json!({"transactionId": transaction.transaction_id, "phase":"pending-boot"});
        write_private_json(&transaction.journal_path, &serde_json::to_vec(&pending).unwrap()).unwrap();
        assert_eq!(
            reconcile_files(&record, &location, save, || panic!("pending must not stop")),
            Ok(SelectionOutcome::Pending)
        );
        assert!(
            record.exists(),
            "no-start must retain prior selection until actual boot proof"
        );
        let reopened = read_selection(&record).unwrap().unwrap();
        assert!(!reopened.start_requested, "reopening cannot opt into Start");
        assert_eq!(
            decode_location(&std::fs::read(&location).unwrap()),
            transaction.next.location
        );
        let next: NativeSelection = serde_json::from_slice(&std::fs::read(&selected).unwrap()).unwrap();
        assert_eq!(next.binary_path, transaction.next.binary_path);
        assert_eq!(next.supervision, Supervision::App);
        assert_eq!(
            std::env::var_os("DATABASE_PATH"),
            Some(
                transaction
                    .next
                    .location
                    .as_ref()
                    .unwrap()
                    .database_path
                    .clone()
                    .into_os_string()
            )
        );
        let serialized = std::fs::read_to_string(&record).unwrap();
        for secret in [
            "BETTER_AUTH_SECRET",
            "parent-secret-that-must-never-be-persisted",
            "password",
            "environment",
        ] {
            assert!(!serialized.contains(secret));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&record).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(
                std::fs::metadata(record.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        // The initial apply stack is gone. A later/cold Start's failed boot
        // provides the exact receipt and recovery reconstructs previous state.
        receipt_fixture(&transaction, &transaction.transaction_id, "rolled-back");
        let stopped = std::cell::Cell::new(false);
        assert_eq!(
            reconcile_files(&record, &location, save, || {
                stopped.set(true);
                Ok(())
            }),
            Ok(SelectionOutcome::RolledBack)
        );
        assert!(stopped.get());
        assert!(!record.exists());
        assert_eq!(
            decode_location(&std::fs::read(&location).unwrap()),
            transaction.previous.location
        );
        let prior: NativeSelection = serde_json::from_slice(&std::fs::read(&selected).unwrap()).unwrap();
        assert_eq!(prior.binary_path, transaction.previous.binary_path);
        assert_eq!(prior.supervision, Supervision::Service);
        assert_eq!(
            std::env::var_os("SUBSHELL_SERVER_CONFIG_DIR"),
            Some(transaction.previous.config_dir.clone().unwrap().into_os_string())
        );
        assert!(std::env::var_os("DATABASE_PATH").is_none());
        // Completed cold receipt confirms next selection and only then clears.
        write_selection(&record, &transaction).unwrap();
        receipt_fixture(&transaction, &transaction.transaction_id, "completed");
        assert_eq!(
            reconcile_files(&record, &location, save, || panic!("completion must not stop")),
            Ok(SelectionOutcome::Completed)
        );
        assert!(!record.exists());
        assert_eq!(
            decode_location(&std::fs::read(&location).unwrap()),
            transaction.next.location
        );
        // A stale receipt and missing journal cannot confirm or change choices.
        write_selection(&record, &transaction).unwrap();
        receipt_fixture(&transaction, "71717171-7171-4171-8171-717171717171", "completed");
        assert!(reconcile_files(
            &record,
            &location,
            |_| panic!("stale receipt must not persist"),
            || panic!("stale receipt must not recover")
        )
        .is_err());
        assert!(record.exists());
        remove_durable(&transaction.receipt_path).unwrap();
        assert!(engine_outcome(&transaction).is_err());
        // Crash after engine application but before CLI returned: Applying
        // phase plus a matching pending journal selects next without success.
        let mut interrupted = transaction.clone();
        interrupted.phase = SelectionPhase::Applying;
        write_selection(&record, &interrupted).unwrap();
        write_private_json(&transaction.journal_path, &serde_json::to_vec(&pending).unwrap()).unwrap();
        assert_eq!(
            reconcile_files(&record, &location, save, || panic!()),
            Ok(SelectionOutcome::Pending)
        );
        assert!(record.exists());
        // Recovery persistence failure cannot claim the prior selection was
        // restored. Keep the record to retry; failed child must already stop.
        receipt_fixture(&transaction, &transaction.transaction_id, "rolled-back");
        assert!(reconcile_files(
            &record,
            &location,
            |_| Err("injected settings disk failure".into()),
            || {
                stopped.set(true);
                Ok(())
            }
        )
        .is_err());
        assert!(record.exists());
        assert!(reconcile_files(&record, &location, save, || Err("injected child stop failure".into())).is_err());
        assert!(record.exists());
        assert_eq!(
            reconcile_files(&record, &location, save, || Ok(())),
            Ok(SelectionOutcome::RolledBack)
        );
        // Immediate apply wrapper: an engine rollback receipt alone cannot
        // resume an ordinary prior spawner inheriting the still-active B env.
        struct CountingPriorSpawner(std::sync::atomic::AtomicUsize);
        impl supervisor::Spawner for CountingPriorSpawner {
            fn spawn(&self) -> std::io::Result<Box<dyn supervisor::ChildHandle>> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Err(std::io::Error::other("prior ordinary spawner was resumed"))
            }
            fn terminate(&self, _: u32) {}
            fn kill(&self, _: u32) {}
        }
        let mut wrapper_transaction = transaction.clone();
        wrapper_transaction.previous.location = None;
        for fail_stop in [false, true] {
            write_selection(&record, &wrapper_transaction).unwrap();
            receipt_fixture(&transaction, &transaction.transaction_id, "rolled-back");
            activate_location(transaction.next.location.as_ref().unwrap());
            let prior = std::sync::Arc::new(CountingPriorSpawner(std::sync::atomic::AtomicUsize::new(0)));
            let sup = supervisor::Supervisor::with_timings(Duration::from_secs(60), Duration::from_millis(50));
            {
                let mut paused = PausedChild {
                    supervisor: &sup,
                    previous: Some(prior.clone()),
                    resume: true,
                };
                let reconciliation = reconcile_files(
                    &record,
                    &location,
                    |_| Err("injected immediate rollback settings failure".into()),
                    || {
                        if fail_stop {
                            Err("injected immediate failed-child stop failure".into())
                        } else {
                            Ok(())
                        }
                    },
                );
                let finished = classify_selection_start(reconciliation, Err("engine reported rollback".into()), || {
                    panic!("failed reconciliation is already authoritative")
                });
                assert!(finish_restore_attempt(&mut paused, true, finished).is_err());
            }
            assert!(
                !sup.snapshot().desired_running,
                "failed native rollback must not resume prior supervision"
            );
            assert_eq!(
                prior.0.load(Ordering::SeqCst),
                0,
                "prior spawner must not inherit still-active B and spawn"
            );
            assert!(
                record.exists(),
                "failed native rollback metadata must survive the wrapper"
            );
        }
        {
            let sup = supervisor::Supervisor::with_timings(Duration::from_secs(60), Duration::from_millis(50));
            let mut paused = PausedChild {
                supervisor: &sup,
                previous: None,
                resume: false,
            };
            assert!(finish_applied_selection(&mut paused, true, Ok(SelectionOutcome::RolledBack)).is_err());
            assert!(
                paused.resume,
                "only successful native rollback may restore previous desire"
            );
            assert_eq!(
                finish_applied_selection(&mut paused, false, Ok(SelectionOutcome::Completed)),
                Ok(SelectionOutcome::Completed)
            );
        }
        // A previous selection without a restore-location record re-adopts
        // only initial in-memory auth/env plus the original config policy.
        let mut initial = transaction.clone();
        initial.previous.location = None;
        write_selection(&record, &initial).unwrap();
        receipt_fixture(&initial, &initial.transaction_id, "rolled-back");
        assert_eq!(
            reconcile_files(&record, &location, save, || Ok(())),
            Ok(SelectionOutcome::RolledBack)
        );
        assert!(!location.exists());
        assert_eq!(
            std::env::var("BETTER_AUTH_SECRET").unwrap(),
            "parent-secret-that-must-never-be-persisted"
        );
        assert_eq!(
            std::env::var_os("SUBSHELL_SERVER_CONFIG_DIR"),
            Some(initial.previous.config_dir.unwrap().into_os_string())
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn invalid_native_selection_is_not_trusted_or_cleared() {
        let (root, record, _, mut transaction) = selection_fixture();
        transaction.next.binary_path = Some("relative-server".into());
        assert!(write_selection(&record, &transaction).is_err());
        write_private_json(&record, &serde_json::to_vec(&transaction).unwrap()).unwrap();
        assert!(read_selection(&record).is_err());
        assert!(record.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    fn location_fixture(legacy: bool) -> (PathBuf, RestoreLocation) {
        let root = std::env::temp_dir().join(format!(
            "subshell-native-restore-env-{}-{}",
            std::process::id(),
            SECRET_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let config_dir = root.join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        let location = RestoreLocation {
            config_dir,
            database_path: root.join("selected.sqlite"),
            data_dir: root.join("selected-data"),
            legacy_database_only: legacy,
        };
        (root, location)
    }
    #[cfg(unix)]
    #[test]
    fn full_restore_child_clears_parent_auth_address_and_destination_overrides() {
        let (root, location) = location_fixture(false);
        std::fs::write(location.config_dir.join("config.env"),"DATABASE_PATH=restored.sqlite\nSUBSHELL_SERVER_DATA_DIR=restored-data\nBETTER_AUTH_SECRET=restored-auth-value\nHOST=127.0.0.1\nSERVER_PORT=3199\nAPP_BASE_URL=http://restored.example\n").unwrap();
        let mut child = std::process::Command::new("/bin/sh");
        child.current_dir(&location.config_dir).args(["-c",r#"[ "${DATABASE_PATH+x}" != x ] && [ "${SUBSHELL_SERVER_DATA_DIR+x}" != x ] && [ "${BETTER_AUTH_SECRET+x}" != x ] && [ "${HOST+x}" != x ] && [ "${SERVER_PORT+x}" != x ] && [ "${APP_BASE_URL+x}" != x ] && [ "${SUBSHELL_TEST_MODE+x}" != x ] && [ "${SUBSHELL_EMERGENCY_PASSWORD+x}" != x ] && [ "${SUBSHELL_SUPERVISOR+x}" != x ] || exit 11; set -a; . ./config.env; printf '%s|%s|%s|%s|%s|%s' "$DATABASE_PATH" "$SUBSHELL_SERVER_DATA_DIR" "$BETTER_AUTH_SECRET" "$HOST" "$SERVER_PORT" "$APP_BASE_URL""#]);
        for key in RESTORED_CONFIG_KEYS {
            child.env(key, "poisoned-parent");
        }
        for key in [
            "SUBSHELL_TEST_MODE",
            "SUBSHELL_EMERGENCY_PASSWORD",
            "SUBSHELL_SUPERVISOR",
        ] {
            child.env(key, "poisoned-parent");
        }
        configure_restored_child(&mut child, &location);
        let output = child.output().unwrap();
        assert!(
            output.status.success(),
            "restored child refused stale input, code {:?}",
            output.status.code()
        );
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            "restored.sqlite|restored-data|restored-auth-value|127.0.0.1|3199|http://restored.example"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn legacy_no_start_selection_survives_later_start_and_cold_reopen() {
        let (root, location) = location_fixture(true);
        let metadata = root.join("restore-location.json");
        // This is the exact persistence used by Start=false. It changes no
        // config.env and supplies both concrete paths to every future spawner.
        write_location(&metadata, &location).unwrap();
        assert!(!location.config_dir.join("config.env").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&metadata).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        for _ordinary_or_cold_start in 0..2 {
            let reloaded = decode_location(&std::fs::read(&metadata).unwrap()).unwrap();
            assert_eq!(reloaded, location);
            let spawner=supervisor::ServerSpawner {argv:vec!["/bin/sh".into(),"-c".into(),"printf '%s|%s|%s|%s' \"$DATABASE_PATH\" \"$SUBSHELL_SERVER_DATA_DIR\" \"$SUBSHELL_SERVER_CONFIG_DIR\" \"$SUBSHELL_SUPERVISOR\"".into()],cwd:reloaded.config_dir.clone(),console_log:root.join("console.log"),own_pid:std::process::id(),restore_location:Some(reloaded)};
            let output = spawner.command().unwrap().output().unwrap();
            assert!(output.status.success());
            assert_eq!(
                String::from_utf8(output.stdout).unwrap(),
                format!(
                    "{}|{}|{}|subshell-desktop-server",
                    location.database_path.display(),
                    location.data_dir.display(),
                    location.config_dir.display()
                )
            );
        }
        // Rollback restores the previous persisted selection exactly.
        let previous = std::fs::read(&metadata).unwrap();
        let mut replacement = location.clone();
        replacement.database_path = root.join("different.sqlite");
        replacement.legacy_database_only = false;
        write_location(&metadata, &replacement).unwrap();
        std::fs::write(&metadata, previous).unwrap();
        assert_eq!(decode_location(&std::fs::read(&metadata).unwrap()).unwrap(), location);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn supported_restore_environment_matches_cli_contract() {
        let source = include_str!("../../../api/src/services/backups/config.ts");
        let array = source
            .split("export const BACKUP_CONFIG_KEYS = [")
            .nth(1)
            .unwrap()
            .split("] as const")
            .next()
            .unwrap();
        let keys: Vec<&str> = array
            .lines()
            .filter_map(|line| line.trim().strip_prefix('"').and_then(|value| value.split('"').next()))
            .collect();
        assert_eq!(RESTORED_CONFIG_KEYS, keys.as_slice());
    }
    #[test]
    fn rollback_environment_fixture() {
        if std::env::var("SUBSHELL_DESKTOP_RESTORE_ENV_FIXTURE").as_deref() != Ok("1") {
            return;
        }
        let previous = EnvironmentSelection::capture();
        let location = RestoreLocation {
            config_dir: "/tmp/fixture-restored-config".into(),
            database_path: "/tmp/fixture-restored-db".into(),
            data_dir: "/tmp/fixture-restored-data".into(),
            legacy_database_only: true,
        };
        activate_location(&location);
        assert_eq!(std::env::var("DATABASE_PATH").unwrap(), "/tmp/fixture-restored-db");
        assert!(std::env::var_os("BETTER_AUTH_SECRET").is_none());
        previous.restore();
        assert_eq!(std::env::var("DATABASE_PATH").unwrap(), "original-database");
        assert_eq!(std::env::var("BETTER_AUTH_SECRET").unwrap(), "original-auth");
        assert_eq!(std::env::var("SERVER_PORT").unwrap(), "3101");
        assert_eq!(
            std::env::var("SUBSHELL_SERVER_CONFIG_DIR").unwrap(),
            "/tmp/original-config"
        );
        assert!(std::env::var_os("SUBSHELL_SERVER_DATA_DIR").is_none());
    }
    #[test]
    fn rollback_restores_prior_native_environment_in_an_isolated_process() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "backup_restore::tests::rollback_environment_fixture",
                "--nocapture",
            ])
            .env("SUBSHELL_DESKTOP_RESTORE_ENV_FIXTURE", "1")
            .env("DATABASE_PATH", "original-database")
            .env("BETTER_AUTH_SECRET", "original-auth")
            .env("SERVER_PORT", "3101")
            .env("SUBSHELL_SERVER_CONFIG_DIR", "/tmp/original-config")
            .env_remove("SUBSHELL_SERVER_DATA_DIR")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "isolated rollback environment assertions failed"
        );
        assert!(String::from_utf8(output.stdout).unwrap().contains("1 passed"));
    }
    struct UnavailableSpawner;
    impl supervisor::Spawner for UnavailableSpawner {
        fn spawn(&self) -> std::io::Result<Box<dyn supervisor::ChildHandle>> {
            Err(std::io::Error::other("fixture does not spawn"))
        }
        fn terminate(&self, _: u32) {}
        fn kill(&self, _: u32) {}
    }
    #[test]
    fn pause_restores_requested_supervision_on_failure_and_no_start_stays_stopped() {
        let sup = supervisor::Supervisor::with_timings(Duration::from_secs(60), Duration::from_millis(100));
        let spawner: std::sync::Arc<dyn supervisor::Spawner> = std::sync::Arc::new(UnavailableSpawner);
        sup.start(spawner.clone());
        assert!(sup.snapshot().desired_running);
        assert!(sup.stop(spawner.as_ref()));
        {
            let _pause = PausedChild {
                supervisor: &sup,
                previous: Some(spawner.clone()),
                resume: true,
            };
        }
        assert!(
            sup.snapshot().desired_running,
            "an exception resumes even during a respawn gap"
        );
        assert!(sup.stop(spawner.as_ref()));
        {
            let _pause = PausedChild {
                supervisor: &sup,
                previous: Some(spawner.clone()),
                resume: false,
            };
        }
        assert!(!sup.snapshot().desired_running, "explicit no-start stays stopped");
    }
    #[test]
    fn password_transport_is_private_removed_and_never_an_argument() {
        let transport = SecretFile::new("correct horse battery staple").unwrap();
        let path = transport.0.clone();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "correct horse battery staple");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let mut args = vec![];
        transport.flag(&mut args, "--password-file");
        assert!(!args.iter().any(|a| a.contains("correct horse")));
        drop(transport);
        assert!(!path.exists());
        assert!(SecretFile::new("line\nbreak").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn a_failing_cli_cannot_echo_password_transport_back_to_the_page() {
        let secret = SecretFile::new("private-password-value").unwrap();
        let argv = vec![
            "/bin/sh".into(),
            "-c".into(),
            "cat \"$1\" >&2; exit 1".into(),
            "fixture".into(),
        ];
        let error = json_command(
            &argv,
            vec![secret.0.to_string_lossy().into_owned()],
            &["private-password-value"],
        )
        .unwrap_err();
        assert!(error.contains("[redacted]"));
        assert!(!error.contains("private-password-value"));
        assert!(!contains_secret_value(&serde_json::json!({"path":"a-file"}), "a"));
        assert!(contains_secret_value(
            &serde_json::json!({"detail":"exposed private-password-value"}),
            "private-password-value"
        ));
    }
    #[test]
    fn stages_are_opaque_and_receipts_match_transaction_and_outcome() {
        assert!(stage_args("/tmp/anything").is_err());
        assert!(stage_args("00000000-0000-0000-0000-000000000000").is_ok());
        let file = std::env::temp_dir().join(format!("subshell-desktop-receipt-test-{}", std::process::id()));
        std::fs::write(&file, r#"{"transactionId":"other","outcome":"completed"}"#).unwrap();
        assert!(wait_receipt(&file, "owned", Duration::ZERO).is_err());
        std::fs::write(&file, r#"{"transactionId":"owned","outcome":"rolled-back"}"#).unwrap();
        assert!(wait_receipt(&file, "owned", Duration::ZERO)
            .unwrap_err()
            .contains("previous state"));
        std::fs::write(&file, r#"{"transactionId":"owned","outcome":"completed"}"#).unwrap();
        assert!(wait_receipt(&file, "owned", Duration::ZERO).is_ok());
        std::fs::remove_file(file).unwrap();
    }
}
