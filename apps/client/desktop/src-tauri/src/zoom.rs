//! Text size: this app's level, and the windows it applies to.
//!
//! The ladder itself is `subshell_desktop_core::zoom`, which also explains why
//! the level is owned by RUST rather than by the page — the short version is
//! that Tauri's built-in zoom hotkeys are a page script invoking a command,
//! and `set_zoom` called from here never touches the IPC ACL at all.
//!
//! One level for the whole app rather than one per window: the plane window
//! and the node assistant are two screens of one product, and a size chosen on
//! one that did not reach the other would read as the setting being broken.
//!
//! The plane window is the reason this could not have been done the built-in
//! way. It shows a control plane's OWN page, from an origin this app cannot
//! enumerate ahead of time, so the one command it is granted
//! (`desktop_open_in_browser`, a path and nothing else) is the whole of its
//! surface — the webview-zoom command Tauri's polyfill invokes is not on it,
//! and never will be. Driving `set_zoom` from Rust is what lets that window
//! follow the setting without widening that surface by one command.

use subshell_desktop_core::settings::SettingsState;
use subshell_desktop_core::zoom::{clamp_zoom, zoom_in, zoom_out, ZOOM_DEFAULT};
use tauri::{AppHandle, Manager};

/// Menu ids, shared by the macOS menu bar and the tray.
///
/// ONE set for both, and exactly one ROUTE for it: `lib.rs`'s app-level
/// `on_menu_event`. A Tauri menu event is global — that handler receives the
/// tray's items, and the tray's handler receives the menu bar's — so an id
/// matched in both places steps the ladder twice per click. Measured on
/// 2026-09-12: two clicks of Bigger landed on 1.75. Namespaced away from
/// `menu:` and `tray:` so the reverse cannot happen either.
pub const IN_ID: &str = "zoom:in";
pub const OUT_ID: &str = "zoom:out";
pub const RESET_ID: &str = "zoom:reset";

/// This app's text size, always a rung of the ladder.
pub fn level(app: &AppHandle) -> f64 {
    clamp_zoom(app.state::<SettingsState>().get().zoom)
}

/// Apply the current level to every window that exists, and re-fit the
/// geometry that depends on it.
pub fn apply(app: &AppHandle) {
    let level = level(app);
    for window in app.webview_windows().values() {
        let _ = window.set_zoom(level);
    }
    crate::windows::refit(app, level);
}

/// Route a zoom menu id, from either menu.
///
/// Returns whether the id was one of ours, so its ONE caller can hand
/// everything else on to the menu bar's dispatch.
///
/// A failed SAVE is reported and then ignored: the level still applies to this
/// session, because a window nobody can read is a worse answer to a full disk
/// than one that forgets the size at the next launch.
pub fn handle(app: &AppHandle, id: &str) -> bool {
    let current = level(app);
    let next = match id {
        IN_ID => zoom_in(current),
        OUT_ID => zoom_out(current),
        RESET_ID => ZOOM_DEFAULT,
        _ => return false,
    };
    if next != current {
        if let Err(err) = app.state::<SettingsState>().update(|s| s.zoom = next) {
            eprintln!("subshell-client: could not save the text size: {err}");
        }
        apply(app);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    // Namespaced, distinct, and not colliding with either menu's own prefix:
    // menu events are global, so every handler sees every id and a string
    // shared with a `menu:`/`tray:` item would be a menu entry that quietly
    // does two things.
    #[test]
    fn the_zoom_ids_are_namespaced_and_distinct() {
        for id in [IN_ID, OUT_ID, RESET_ID] {
            assert!(id.starts_with("zoom:"), "{id}");
        }
        assert_ne!(IN_ID, OUT_ID);
        assert_ne!(IN_ID, RESET_ID);
        assert_ne!(OUT_ID, RESET_ID);
    }
}
