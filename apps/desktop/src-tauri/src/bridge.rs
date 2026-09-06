//! Getting a native menu item or tray entry to do something in the page.
//!
//! Every action here is ROUTER-level, and that is the whole design: a menu
//! item that navigated by setting `location.href` would do a full document
//! load, unmounting every live terminal, dropping the SSE feed and forcing a
//! history replay on each pane — the exact cost this app exists to avoid.
//!
//! Delivered by `eval` as a `CustomEvent`, NOT through Tauri's event system.
//! The page comes from the server and is treated as remote content with almost
//! no capability grant, and `emit` requires `core:event:allow-listen` on the
//! receiving window. `eval` needs nothing, so the menu bar and the tray keep
//! working even where IPC is refused entirely. The page's half is
//! `apps/frontend/src/lib/desktop.ts`.

use tauri::{AppHandle, Manager};

/// The actions the native chrome can ask the page to perform.
///
/// The string values are the contract with `DesktopAction` in
/// `apps/frontend/src/lib/desktop.ts`; a value the page does not know is
/// ignored there rather than mishandled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopAction {
    NewSubshell,
    NewWorkspace,
    FocusFilter,
    ToggleSidebar,
    GoSubshells,
    GoWorkspaces,
    GoNodes,
    GoSettings,
    GoPreferences,
    SignOut,
}

impl DesktopAction {
    pub fn as_str(self) -> &'static str {
        match self {
            DesktopAction::NewSubshell => "new-subshell",
            DesktopAction::NewWorkspace => "new-workspace",
            DesktopAction::FocusFilter => "focus-filter",
            DesktopAction::ToggleSidebar => "toggle-sidebar",
            DesktopAction::GoSubshells => "go-subshells",
            DesktopAction::GoWorkspaces => "go-workspaces",
            DesktopAction::GoNodes => "go-nodes",
            DesktopAction::GoSettings => "go-settings",
            DesktopAction::GoPreferences => "go-preferences",
            DesktopAction::SignOut => "sign-out",
        }
    }

    /// The menu/tray item id this action is wired to.
    pub fn id(self) -> String {
        format!("action:{}", self.as_str())
    }

    /// Recover an action from a menu event id.
    pub fn from_id(id: &str) -> Option<Self> {
        let name = id.strip_prefix("action:")?;
        ALL.iter().copied().find(|a| a.as_str() == name)
    }
}

/// Every action, for menu construction and for the round-trip test.
pub const ALL: [DesktopAction; 10] = [
    DesktopAction::NewSubshell,
    DesktopAction::NewWorkspace,
    DesktopAction::FocusFilter,
    DesktopAction::ToggleSidebar,
    DesktopAction::GoSubshells,
    DesktopAction::GoWorkspaces,
    DesktopAction::GoNodes,
    DesktopAction::GoSettings,
    DesktopAction::GoPreferences,
    DesktopAction::SignOut,
];

/// Send an action to the page, if the page is there to receive it.
///
/// Silently does nothing when `main` is not open: a menu item that errored
/// because the user has not opened the app window yet would be noise, and the
/// items that matter without it live on the tray instead.
pub fn dispatch(app: &AppHandle, action: DesktopAction) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // The action name is from a closed set of ASCII literals in THIS file, so
    // there is nothing here to escape — but keep it that way: interpolating
    // anything user- or server-derived into an eval string would be an
    // injection into a window holding privileged globals.
    let script = format!(
        "window.dispatchEvent(new CustomEvent('subshell:desktop',{{detail:{{action:'{}'}}}}))",
        action.as_str()
    );
    let _ = window.eval(&script);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_action_round_trips_through_its_menu_id() {
        for action in ALL {
            assert_eq!(DesktopAction::from_id(&action.id()), Some(action));
        }
    }

    #[test]
    fn a_foreign_menu_id_is_not_an_action() {
        assert_eq!(DesktopAction::from_id("quit"), None);
        assert_eq!(DesktopAction::from_id("action:"), None);
        assert_eq!(DesktopAction::from_id("new-subshell"), None);
    }

    // The page ignores an action it does not know, so drift is silent — these
    // strings are the contract with lib/desktop.ts's DesktopAction union.
    #[test]
    fn action_names_are_kebab_case_and_unique() {
        let names: Vec<&str> = ALL.iter().map(|a| a.as_str()).collect();
        for n in &names {
            assert!(
                n.chars().all(|c| c.is_ascii_lowercase() || c == '-'),
                "{n} is not kebab-case"
            );
        }
        let mut sorted = names.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), names.len(), "duplicate action name");
    }

    // Nothing outside this file may reach the eval string.
    #[test]
    fn action_names_carry_nothing_that_needs_escaping() {
        for a in ALL {
            assert!(!a.as_str().contains('\'') && !a.as_str().contains('\\'));
        }
    }
}
