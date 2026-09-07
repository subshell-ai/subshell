//! The one window, and why there is only one.
//!
//! `apps/server/desktop` has two because one of them shows a page served by
//! the server it manages — remote content in a window holding Tauri's IPC
//! globals, which is why that app carries an origin pin, a user-agent marker, a
//! navigation guard and a capability split. **A node agent has no web UI at
//! all**: it holds a socket and runs signed commands. So this app's window
//! loads its own bundled page, there is exactly one origin and it is local,
//! and none of that apparatus exists here.
//!
//! That is a property to preserve rather than a coincidence. The moment a
//! second window loads something this bundle did not ship — a webview onto a
//! control plane, say, to let a user mint their own setup key — every one of
//! those guards becomes necessary again, and
//! `src-tauri/permissions/desktop.toml` is what keeps that window from
//! silently inheriting the commands this one has.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// The window's label.
///
/// It is a contract, not a name: `capabilities/main.json` grants this app's
/// commands to the window called `main` and to no other, so a window built
/// under a different label gets an empty capability set — and every `invoke`
/// from its page is refused with nothing in the UI to explain it.
pub const MAIN_LABEL: &str = "main";

/// Small enough for a laptop, big enough for the enrollment form plus the
/// status block underneath it without the two fighting over the fold.
const MIN_WIDTH: f64 = 520.0;
const MIN_HEIGHT: f64 = 560.0;

/// Create (or focus) the app window.
pub fn open_main(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        show(&w);
        return Ok(w);
    }
    WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::App("index.html".into()))
        .title("Subshell Client")
        .inner_size(760.0, 720.0)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .resizable(true)
        .build()
        .map_err(|e| format!("could not open the window: {e}"))
}

/// Bring the window back — from the tray, the Dock, or a second launch.
///
/// Re-creates it when it is gone: on macOS a window closed while close-to-tray
/// is OFF is destroyed rather than hidden, and without this the Dock icon and
/// the tray would both be dead ends for the rest of the session.
pub fn focus_main(app: &AppHandle) {
    match app.get_webview_window(MAIN_LABEL) {
        Some(w) => show(&w),
        None => {
            let _ = open_main(app);
        }
    }
}

fn show(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

#[cfg(test)]
mod tests {
    use super::*;

    // The label is what `capabilities/main.json` names. A window built under
    // any other label is granted nothing, and the failure is silent: the page
    // renders and every command it calls is refused.
    #[test]
    fn the_label_is_the_one_the_capability_grants() {
        assert_eq!(MAIN_LABEL, "main");
    }
}
