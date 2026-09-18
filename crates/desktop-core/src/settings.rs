//! Per-user desktop settings, in one small JSON file.
//!
//! Deliberately not `tauri-plugin-store`: the field list is short and typed,
//! the console page reaches it through commands anyway, and a plugin that
//! hands the WEBVIEW a general read/write store is a wider surface than a few
//! scalars need — the window showing a server's page comes from that server,
//! not from us.
//!
//! The one thing that is NOT shared between the two desktop apps is where the
//! file lives. That is carried in [`SettingsPaths`] rather than baked in,
//! because the path is the part a shipped app's users already have on disk: an
//! app that starts reading a different file has silently forgotten every
//! preference they ever set, with nothing to explain it.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::shell_env::home_dir;
use crate::zoom::ZOOM_DEFAULT;

/// One app's identity on disk — where its settings file goes.
///
/// macOS keys the directory by bundle id (`dev.subshell.server`), Linux by an
/// XDG-ish directory name (`subshell-desktop-server`). Two apps sharing either
/// string would share (and overwrite) one file.
#[derive(Debug, Clone, Copy)]
pub struct SettingsPaths {
    /// `~/Library/Application Support/<macos_bundle_id>/settings.json`.
    pub macos_bundle_id: &'static str,
    /// `~/.config/<linux_dir>/settings.json`.
    pub linux_dir: &'static str,
}

impl SettingsPaths {
    /// The settings file, or `None` when the environment names no `$HOME`.
    pub fn file(&self) -> Option<PathBuf> {
        let home = home_dir()?;
        Some(if cfg!(target_os = "macos") {
            PathBuf::from(home).join(format!(
                "Library/Application Support/{}/settings.json",
                self.macos_bundle_id
            ))
        } else {
            PathBuf::from(home).join(format!(".config/{}/settings.json", self.linux_dir))
        })
    }
}

/// The unfinished half of an update, as [`Settings::pending_bundled_install`]
/// records it.
///
/// Deliberately small: everything about WHAT to install is re-derived at boot
/// from the probe (the bundled version against the installed one), because a
/// marker that also carried the answer would be a second opinion that could
/// disagree with the machine. What it carries is only what the new process
/// cannot work out for itself.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PendingBundledInstall {
    /// The app version that was running when the person pressed.
    ///
    /// For the audit line and for a human reading the file on a machine that
    /// will not finish — it is the one fact that says WHICH update this was.
    pub from_app_version: String,
    /// RFC 3339, written at the press.
    pub started_at: String,
    /// How many boots have tried and failed. Bounded — see `resume_decision`.
    pub attempts: u32,
    /// The pane-safety override the person accepted in phase 1, if they did.
    ///
    /// The confirm happens before the relaunch and the act it consents to —
    /// a service restart that may close live subshells — happens after it, in
    /// a different process. Re-asking would be asking again for something
    /// already granted, on a screen nobody chose to open; carrying the answer
    /// here is what makes one press mean one act. Narrow by construction: one
    /// boolean, about one restart, cleared with the marker, and worth nothing
    /// to anyone who edits it in — the file's owner can already stop the
    /// service.
    pub forced: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// An explicit binary chosen by the user; outranks every discovery rung but the env override.
    pub binary_path: Option<String>,
    /// Whether closing the window hides it to the tray instead of quitting.
    ///
    /// DEFAULTS ON, and it is only ever HONOURED where
    /// [`crate::tray::tray_support`] says an icon would actually be drawn —
    /// this field is a stored preference, never a capability. On a desktop
    /// with no StatusNotifier host the icon is silently invisible, so hiding
    /// into it would make the app unreachable with no error to explain it;
    /// `crate::tray::effective_close_to_tray` is the clamp that makes the
    /// ON default safe: it turns this off on READ where no tray answered,
    /// the UI shows the switch disabled with the reason, and the setter
    /// refuses `true`. The unreachability hazard is prevented by the clamp,
    /// not by the default.
    pub close_to_tray: bool,
    /// Reserved for Phase 4; persisted now so the file shape does not change later.
    pub open_at_login: bool,
    /// Subshell Client only: the control plane whose UI the app's main window shows.
    ///
    /// Stored here rather than read from the node agent's `config.json` every
    /// time, because a client is not required to be a node — someone who only
    /// watches subshells never enrolls, so there is no config to read. Where
    /// both exist, this one wins: it is the address the user last chose.
    ///
    /// `apps/server/desktop` never sets it. It shares the struct because the
    /// two apps share the file FORMAT, not the file — each keys its own
    /// directory off its own [`SettingsPaths`].
    pub plane_url: Option<String>,
    /// Set once this app has watched a server on this machine reach `ready`.
    /// Decides whether boot opens the wizard or the status console (spec
    /// 2026-09-10 § 4); only `desktop_probe`'s marking writes it true and
    /// only reset writes it false. The struct-level `#[serde(default)]`
    /// gives an absent field the false that pre-wizard files need: an
    /// upgrade without a completed setup re-enters the wizard, which is the
    /// correct direction to fail.
    pub onboarded: bool,
    /// This app's text size, as a webview zoom factor (1.0 = normal).
    ///
    /// Per APP rather than per window: both windows of either app show the
    /// same person the same product, and a size chosen in one that did not
    /// apply to the other would read as the setting not working. The two apps
    /// still differ freely — they share this struct, never the file — which is
    /// right, since the window someone reads all day is the control plane's.
    ///
    /// Always read through [`crate::zoom::clamp_zoom`]: this is a plain file a
    /// person can edit, and a `0` in it is a window nobody can read well
    /// enough to fix from inside the app. The struct-level `#[serde(default)]`
    /// gives an absent field the `1.0` every settings file written before this
    /// existed needs — a zoom of `0.0` is what a bare `f64` default would
    /// have handed them.
    pub zoom: f64,
    /// When this app last asked the release source whether a newer app exists,
    /// as an RFC 3339 timestamp.
    ///
    /// The whole of the launch check's rate limit (spec 2026-09-15 § 7.2):
    /// each app checks ONCE on launch and only when this is more than 24 hours
    /// old. Persisted rather than held in memory because the window it guards
    /// is per LAUNCH — an app someone quits and reopens eight times in an
    /// afternoon would otherwise ask eight times, which is a poll with extra
    /// steps.
    ///
    /// Absent means "never checked", which is what makes a fresh install check
    /// on its first launch.
    pub last_update_check_at: Option<String>,
    /// The newest app version that check found, when it found a newer one.
    ///
    /// Stored beside the timestamp rather than re-derived, because the tray
    /// item it suffixes ("Check for Updates… (0.7.0 available)") is built
    /// before any check runs on a launch that is inside the 24-hour window.
    /// Cleared by a check that finds nothing newer — a suffix naming a version
    /// the person already installed is worse than none.
    pub last_update_version: Option<String>,
    /// An app update has landed and the CLI it bundles is not installed yet.
    ///
    /// The second half of one act, carried across the relaunch that separates
    /// them (spec 2026-09-18 § 5). Each bundle SHIPS the CLI it wraps, so
    /// "update the app" and "update the CLI" are not independent on a desktop
    /// machine — the second is the tail of the first — and the app update ends
    /// in `app.restart()`, so the tail necessarily runs in a process that did
    /// not exist when the person pressed.
    ///
    /// Written BEFORE the relaunch, never after: a crash between the two must
    /// leave a machine that knows what it was doing.
    ///
    /// **No `kind` field.** Each app keys its own `settings.json` by its own
    /// bundle identifier, so the subject is implied by which app is reading —
    /// the server app's marker means its bundled server, the client's means
    /// its bundled agent. The two apps share this struct's FORMAT and never
    /// the file, exactly as `plane_url` and `supervision` do in the other
    /// direction.
    pub pending_bundled_install: Option<PendingBundledInstall>,
    /// Who runs the server on this machine (Subshell Server only).
    ///
    /// A PREFERENCE, and the disk outranks it: a unit or plist that exists
    /// puts the machine in [`Supervision::Service`] whatever this says, and
    /// the probe writes the correction back. Otherwise an operator who
    /// installed a service from the CLI would have the app quietly believing
    /// it owned the process, and stopping it on quit.
    ///
    /// `apps/client/desktop` never sets it; the two apps share this struct's
    /// FORMAT and never the file, exactly as `plane_url` does in the other
    /// direction.
    pub supervision: Supervision,
}

/// Who starts and restarts the control-plane server on this machine.
///
/// The two answers differ in lifetime rather than in capability: a service
/// outlives every window and comes back at login (see the CLI's
/// `service enable`), while the app's own child lives exactly as long as the
/// app does. Running subshells survive either going away — both stop the
/// server's main process only, never its process group, because each local
/// subshell's tmux server is a child of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Supervision {
    /// launchd or systemd owns it. The default, and what an absent field means.
    #[default]
    Service,
    /// The desktop app runs it as a child process.
    App,
}

/// Hand-written because two fields are not zero values, and both are clamped
/// on READ rather than trusted: `close_to_tray` defaults ON (clamped by
/// `crate::tray::effective_close_to_tray` where no tray answers) and `zoom`
/// defaults to normal (clamped by `crate::zoom::clamp_zoom`, for which a bare
/// `f64`'s zero would be an unreadable window). Everything else keeps the
/// derive's zero.
impl Default for Settings {
    fn default() -> Self {
        Self {
            binary_path: None,
            close_to_tray: true,
            open_at_login: false,
            plane_url: None,
            onboarded: false,
            zoom: ZOOM_DEFAULT,
            last_update_check_at: None,
            last_update_version: None,
            pending_bundled_install: None,
            supervision: Supervision::Service,
        }
    }
}

impl Settings {
    pub fn load(paths: &SettingsPaths) -> Self {
        // `#[serde(default)]` already gives an absent file and an absent field
        // the same answer, which is what the Linux default below relies on.
        paths
            .file()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, paths: &SettingsPaths) -> Result<(), String> {
        let path = paths
            .file()
            .ok_or_else(|| "no HOME to save settings into".to_string())?;
        self.save_to(&path)
    }

    /// The write half, separated so its atomicity is testable against a
    /// temp path without relocating HOME (a process-wide variable the whole
    /// test binary shares).
    fn save_to(&self, path: &Path) -> Result<(), String> {
        let dir = path.parent().ok_or_else(|| "settings path has no parent".to_string())?;
        let name = path
            .file_name()
            .ok_or_else(|| "settings path has no file name".to_string())?;
        std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        // Temp + rename, not fs::write: this file became the record (the
        // onboarded flag decides which window opens), and a crash between a
        // truncate and the last byte would leave JSON that `load`'s forgiving
        // parse reads as "no settings" - silently losing the picked binary.
        // The dot prefix keeps the in-flight name out of any listing globbing
        // for settings.json.
        let tmp = dir.join(format!(".{}.tmp-{}", name.to_string_lossy(), std::process::id()));
        std::fs::write(&tmp, &text).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("could not move settings into {}: {e}", path.display())
        })
    }
}

/// Managed app state: the loaded settings, plus the paths they came from.
///
/// The paths travel WITH the state rather than being passed at each call site,
/// so a save can never land in the other app's file.
pub struct SettingsState {
    inner: Mutex<Settings>,
    paths: SettingsPaths,
}

impl SettingsState {
    pub fn new(paths: SettingsPaths) -> Self {
        Self {
            inner: Mutex::new(Settings::load(&paths)),
            paths,
        }
    }

    /// Recovers from a poisoned lock rather than discarding the settings.
    ///
    /// `unwrap_or_default()` here would silently forget the user's chosen
    /// binary the first time any thread panicked while holding this — and
    /// `Settings` is plain data with no invariant a panic could have left
    /// half-applied, so the value is still good.
    pub fn get(&self) -> Settings {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Edit and persist under ONE lock, so two concurrent commands cannot each
    /// write a copy of the settings that is missing the other's change.
    pub fn update(&self, edit: impl FnOnce(&mut Settings)) -> Result<(), String> {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        edit(&mut guard);
        guard.save(&self.paths)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_PATHS: SettingsPaths = SettingsPaths {
        macos_bundle_id: "dev.example.app",
        linux_dir: "example-app",
    };

    // Default ON since 2026-09-07 (user request): the tray-resident controller
    // is the point of these apps. What makes the default safe on a Linux
    // desktop with no StatusNotifier host is NOT an off default but
    // `effective_close_to_tray`, which clamps this off on READ, disables the
    // switch in the UI with the reason, and refuses an explicit `true`.
    #[test]
    fn close_to_tray_defaults_on() {
        assert!(Settings::default().close_to_tray);
    }

    #[test]
    fn round_trips_through_json() {
        let s = Settings {
            binary_path: Some("/x/subshell-server".into()),
            close_to_tray: true,
            open_at_login: false,
            plane_url: Some("https://subshell.example.com".into()),
            onboarded: true,
            zoom: 1.25,
            last_update_check_at: Some("2026-09-15T10:00:00Z".into()),
            last_update_version: Some("0.7.0".into()),
            pending_bundled_install: Some(PendingBundledInstall {
                from_app_version: "0.8.0".into(),
                started_at: "2026-09-18T12:00:00Z".into(),
                attempts: 1,
                forced: true,
            }),
            supervision: Supervision::App,
        };
        let back: Settings = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back.binary_path.as_deref(), Some("/x/subshell-server"));
        assert!(back.close_to_tray);
        assert_eq!(back.plane_url.as_deref(), Some("https://subshell.example.com"));
        assert!(back.onboarded);
        assert_eq!(back.zoom, 1.25);
        assert_eq!(back.last_update_check_at.as_deref(), Some("2026-09-15T10:00:00Z"));
        assert_eq!(back.last_update_version.as_deref(), Some("0.7.0"));
        // The marker survives the file, which is the whole of its job: it is
        // written by one process and read by a DIFFERENT BUILD after a
        // relaunch, so a field that did not round-trip would strand the second
        // half of an update.
        let pending = back.pending_bundled_install.expect("the marker round-trips");
        assert_eq!(pending.from_app_version, "0.8.0");
        assert_eq!(pending.attempts, 1);
        assert!(pending.forced);
    }

    // Every settings file written before this existed has no marker, and must
    // read as "nothing was interrupted" rather than failing the whole load —
    // which would take the app's binary path and tray preference with it.
    #[test]
    fn an_absent_marker_reads_as_nothing_pending() {
        let s: Settings = serde_json::from_str(r#"{"closeToTray":true,"onboarded":true}"#).unwrap();
        assert_eq!(s.pending_bundled_install, None);
    }

    // A settings file written before the launch update check existed must read
    // as "never checked", so an upgraded app asks once rather than waiting a
    // day for a timestamp that is not there.
    #[test]
    fn an_absent_update_check_reads_as_never() {
        let s: Settings = serde_json::from_str(r#"{"closeToTray":true,"onboarded":true}"#).unwrap();
        assert_eq!(s.last_update_check_at, None);
        assert_eq!(s.last_update_version, None);
    }

    // A settings file written before text size existed must open at normal
    // size, not at the `0.0` a bare f64 default would give it.
    #[test]
    fn zoom_defaults_to_normal_and_reads_old_files() {
        assert_eq!(Settings::default().zoom, ZOOM_DEFAULT);
        let s: Settings = serde_json::from_str(r#"{"closeToTray":true,"onboarded":true}"#).unwrap();
        assert_eq!(s.zoom, ZOOM_DEFAULT);
    }

    // Unknown keys from a newer build must not wipe the file.
    #[test]
    fn tolerates_unknown_and_missing_keys() {
        let s: Settings = serde_json::from_str(r#"{"closeToTray":true,"somethingNew":42}"#).unwrap();
        assert!(s.close_to_tray);
        assert!(s.binary_path.is_none());
    }

    // The parameterization is only worth anything if the identity it is given
    // is the identity that reaches the path.
    #[test]
    fn the_file_is_keyed_by_the_identity_it_is_given() {
        let Some(file) = TEST_PATHS.file() else { return };
        let shown = file.to_string_lossy().into_owned();
        assert!(shown.ends_with("settings.json"), "{shown}");
        if cfg!(target_os = "macos") {
            assert!(
                shown.contains("/Library/Application Support/dev.example.app/"),
                "{shown}"
            );
        } else {
            assert!(shown.contains("/.config/example-app/"), "{shown}");
        }
    }

    // Two apps must not collide, which is the only reason this is a parameter.
    #[test]
    fn different_identities_do_not_share_a_file() {
        let other = SettingsPaths {
            macos_bundle_id: "dev.example.other",
            linux_dir: "example-other",
        };
        let (Some(a), Some(b)) = (TEST_PATHS.file(), other.file()) else {
            return;
        };
        assert_ne!(a, b);
    }

    #[test]
    fn onboarded_defaults_false_and_reads_old_files() {
        // A settings file written before this field existed must read as
        // false: failing toward the wizard is the correct direction.
        let s: Settings = serde_json::from_str(r#"{"closeToTray":true,"binaryPath":"/x/subshell-server"}"#).unwrap();
        assert!(!s.onboarded);
        assert!(!Settings::default().onboarded);
    }

    #[test]
    fn onboarded_round_trips() {
        let s = Settings {
            onboarded: true,
            ..Settings::default()
        };
        let back: Settings = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert!(back.onboarded);
    }

    #[test]
    fn save_to_is_atomic_by_shape_and_leaves_no_litter() {
        // The rename guarantee, exercised on a temp path through the seam
        // save() delegates to - never by mutating HOME, which other tests in
        // this same binary would read racily. After a save the directory
        // holds exactly settings.json: no .tmp a later observer would find.
        let dir = std::env::temp_dir().join(format!("subshell-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("settings.json");
        let s = Settings {
            onboarded: true,
            ..Settings::default()
        };
        s.save_to(&file).expect("save");
        let left: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, vec!["settings.json".to_string()]);
        let back: Settings = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert!(back.onboarded);
        std::fs::remove_dir_all(&dir).ok();
    }
    /// An absent `supervision` is Service — the mode every existing install
    /// is in, so an upgrade must not silently hand the app a server it never
    /// spawned and would stop on quit.
    #[test]
    fn supervision_defaults_to_service_and_round_trips() {
        let old: Settings = serde_json::from_str(r#"{"closeToTray":true,"zoom":1.0}"#).unwrap();
        assert_eq!(old.supervision, Supervision::Service);
        let app: Settings = serde_json::from_str(r#"{"supervision":"app"}"#).unwrap();
        assert_eq!(app.supervision, Supervision::App);
        // kebab-case on the wire, because the file is one a person may read.
        let json = serde_json::to_string(&app).unwrap();
        assert!(json.contains("\"supervision\":\"app\""), "{json}");
        // An unknown value is a parse failure for the WHOLE file, which the
        // loader answers with defaults — the safe direction.
        assert!(serde_json::from_str::<Settings>(r#"{"supervision":"nonsense"}"#).is_err());
    }
}
