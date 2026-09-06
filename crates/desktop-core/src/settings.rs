//! Per-user desktop settings, in one small JSON file.
//!
//! Deliberately not `tauri-plugin-store`: there are three fields, the console
//! page reaches them through commands anyway, and a plugin that hands the
//! WEBVIEW a general read/write store is a wider surface than three scalars
//! need — the window showing a server's page comes from that server, not from
//! us.
//!
//! The one thing that is NOT shared between the two desktop apps is where the
//! file lives. That is carried in [`SettingsPaths`] rather than baked in,
//! because the path is the part a shipped app's users already have on disk: an
//! app that starts reading a different file has silently forgotten every
//! preference they ever set, with nothing to explain it.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

use crate::shell_env::home_dir;

/// One app's identity on disk — where its settings file goes.
///
/// macOS keys the directory by bundle id (`dev.subshell.desktop`), Linux by an
/// XDG-ish directory name (`subshell-desktop`). Two apps sharing either string
/// would share (and overwrite) one file.
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// An explicit binary chosen by the user; outranks every discovery rung but the env override.
    pub server_bin_path: Option<String>,
    /// Whether closing the window hides it to the tray instead of quitting.
    ///
    /// Defaults OFF on Linux: a stock GNOME has no AppIndicator host, so the
    /// tray icon is silently invisible and closing-to-tray would make the app
    /// unreachable with no error to explain it.
    pub close_to_tray: bool,
    /// Reserved for Phase 4; persisted now so the file shape does not change later.
    pub open_at_login: bool,
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
        let dir = path.parent().ok_or_else(|| "settings path has no parent".to_string())?;
        std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, text).map_err(|e| format!("could not write {}: {e}", path.display()))
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

    // On a fresh Linux install the tray may not exist at all; close-to-tray
    // must never be the default there or the window becomes unreachable.
    #[test]
    fn close_to_tray_defaults_off() {
        assert!(!Settings::default().close_to_tray);
    }

    #[test]
    fn round_trips_through_json() {
        let s = Settings {
            server_bin_path: Some("/x/subshell-server".into()),
            close_to_tray: true,
            open_at_login: false,
        };
        let back: Settings = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back.server_bin_path.as_deref(), Some("/x/subshell-server"));
        assert!(back.close_to_tray);
    }

    // Unknown keys from a newer build must not wipe the file.
    #[test]
    fn tolerates_unknown_and_missing_keys() {
        let s: Settings = serde_json::from_str(r#"{"closeToTray":true,"somethingNew":42}"#).unwrap();
        assert!(s.close_to_tray);
        assert!(s.server_bin_path.is_none());
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
}
