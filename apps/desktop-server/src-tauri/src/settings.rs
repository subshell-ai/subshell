//! Per-user desktop settings, in one small JSON file.
//!
//! Deliberately not `tauri-plugin-store`: there are three fields, the console
//! page reaches them through commands anyway, and a plugin that hands the
//! WEBVIEW a general read/write store is a wider surface than three scalars
//! need — the `main` window's page comes from the server, not from us.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

use crate::shell_env::home_dir;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// An explicit `subshell-server` chosen by the user; outranks every discovery rung but the env override.
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
    fn path() -> Option<PathBuf> {
        let home = home_dir()?;
        Some(if cfg!(target_os = "macos") {
            PathBuf::from(home).join("Library/Application Support/dev.subshell.desktop/settings.json")
        } else {
            PathBuf::from(home).join(".config/subshell-desktop/settings.json")
        })
    }

    pub fn load() -> Self {
        // `#[serde(default)]` already gives an absent file and an absent field
        // the same answer, which is what the Linux default below relies on.
        Self::path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::path().ok_or_else(|| "no HOME to save settings into".to_string())?;
        let dir = path.parent().ok_or_else(|| "settings path has no parent".to_string())?;
        std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, text).map_err(|e| format!("could not write {}: {e}", path.display()))
    }
}

/// Managed app state.
pub struct SettingsState(pub Mutex<Settings>);

impl SettingsState {
    pub fn new() -> Self {
        Self(Mutex::new(Settings::load()))
    }
    /// Recovers from a poisoned lock rather than discarding the settings.
    ///
    /// `unwrap_or_default()` here would silently forget the user's chosen
    /// server binary the first time any thread panicked while holding this —
    /// and `Settings` is plain data with no invariant a panic could have left
    /// half-applied, so the value is still good.
    pub fn get(&self) -> Settings {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
