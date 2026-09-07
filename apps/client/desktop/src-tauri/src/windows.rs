//! The two windows, and why they are two.
//!
//! Subshell Client is the human interface to a control plane, and the place a
//! machine is registered as a node. Those are two different trust levels, so
//! they are two different windows:
//!
//! - **`main`** shows the control plane's OWN page, loaded from the plane's own
//!   HTTP origin. `apps/server/web` is hard same-origin — relative `apiFetch`
//!   with `credentials: "include"`, an auth client with no `baseURL`, a
//!   WebSocket URL built from `window.location.host` — so a bundled copy could
//!   not carry the `SameSite=Lax` session cookie to any of them. It is remote
//!   content, and it is granted NOTHING: no capability file names this window,
//!   so every command is refused. See [`open_plane`].
//! - **`node`** is ours: a bundled page that must render with the plane
//!   unreachable, and the only surface allowed to drive the `subshell` CLI —
//!   enrol, install the agent, drive the service.
//!
//! **The node window existing IS the "node functionality" toggle.** A client
//! used only to watch subshells never opens it, and there is no separate mode
//! flag for the two halves to disagree about.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// The label of the window showing a control plane's own page.
///
/// It is `main` because that is what it is to the user, and because the
/// window-state plugin and the Dock both key off labels. Nothing grants it a
/// capability — see the module note — and that absence is the security
/// boundary, so a `capabilities/*.json` naming `main` is a change to the trust
/// model, not a convenience.
pub const PLANE_LABEL: &str = "main";

/// The bundled node page's label.
///
/// A contract, not a name: `capabilities/node.json` grants this app's commands
/// to the window called `node` and to no other, so a window built under a
/// different label gets an empty capability set — and every `invoke` from its
/// page is refused with nothing in the UI to explain it.
pub const NODE_LABEL: &str = "node";

/// Small enough for a laptop, big enough for the enrollment form plus the
/// status block underneath it without the two fighting over the fold.
const NODE_MIN_WIDTH: f64 = 520.0;
const NODE_MIN_HEIGHT: f64 = 560.0;

/// Below this the SPA renders its PHONE drawer — `useIsWide()` is
/// `matchMedia("(min-width: 1024px)")` and `WORKSPACE_TILING_MIN_WIDTH` is
/// 1024. Tauri's own 800x600 default would ship a desktop app in the exact
/// chrome a desktop app exists to replace, so this is a floor, not a hint.
const PLANE_MIN_WIDTH: f64 = 1024.0;
const PLANE_MIN_HEIGHT: f64 = 640.0;

/// Create (or focus) the node window.
pub fn open_node(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(NODE_LABEL) {
        show(&w);
        return Ok(w);
    }
    WebviewWindowBuilder::new(app, NODE_LABEL, WebviewUrl::App("index.html".into()))
        .title("Subshell Client — this machine")
        .inner_size(760.0, 720.0)
        .min_inner_size(NODE_MIN_WIDTH, NODE_MIN_HEIGHT)
        .resizable(true)
        .build()
        .map_err(|e| format!("could not open the node window: {e}"))
}

/// Create (or focus) the window showing the control plane at `origin`.
///
/// Three things about this window are deliberate and belong together:
///
/// - **No capability names it**, so the page can invoke nothing. A control
///   plane is reachable over a LAN or a VPN, so its origin cannot be pinned to
///   loopback the way `apps/server/desktop`'s can, and an origin this app
///   cannot enumerate ahead of time must not be handed commands. Everything
///   privileged lives on the bundled node page instead.
/// - **No user-agent marker.** `apps/server/web` decides it is running in a
///   desktop shell by reading a `SubshellDesktop/…` suffix, and then talks to
///   Tauri — asks for an overlay title bar, starts window drags. With no grant
///   here those calls would be refused one by one. Without the marker the SPA
///   renders as it does in a browser, which is correct for a window that is a
///   browser.
/// - **Navigation is pinned to the origin it opened with**, so a redirect or
///   an href in rendered content cannot walk this window somewhere else.
pub fn open_plane(app: &AppHandle, origin: &str) -> Result<WebviewWindow, String> {
    let url: tauri::Url = origin
        .parse()
        .map_err(|e| format!("'{origin}' is not a usable control-plane URL: {e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("refusing to open a '{}' URL: {origin}", url.scheme()));
    }

    if let Some(w) = app.get_webview_window(PLANE_LABEL) {
        // The user may have pointed the app at a different plane since this
        // window opened. Focusing a window still showing the old one looks
        // like the switch did nothing; navigating it is the whole fix.
        if w.url().map(|u| u.origin() != url.origin()).unwrap_or(false) {
            let _ = w.navigate(url);
        }
        show(&w);
        return Ok(w);
    }

    let allowed = url.origin();
    WebviewWindowBuilder::new(app, PLANE_LABEL, WebviewUrl::External(url))
        .on_navigation(move |u| u.origin() == allowed)
        .title("Subshell Client")
        .inner_size(1280.0, 860.0)
        .min_inner_size(PLANE_MIN_WIDTH, PLANE_MIN_HEIGHT)
        // Tauri's native file-drop handler otherwise SWALLOWS HTML5 drag
        // events, which would silently break both drag-a-subshell-into-a-
        // workspace (the `application/x-subshell-id` payload) and the
        // terminal's own file-drop uploads.
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| format!("could not open the control-plane window: {e}"))
}

/// Bring the node window back — from the tray, the Dock, or a second launch.
///
/// Re-creates it when it is gone: on macOS a window closed while close-to-tray
/// is OFF is destroyed rather than hidden, and without this the Dock icon and
/// the tray would both be dead ends for the rest of the session.
pub fn focus_node(app: &AppHandle) {
    match app.get_webview_window(NODE_LABEL) {
        Some(w) => show(&w),
        None => {
            let _ = open_node(app);
        }
    }
}

/// Bring SOMETHING back, for the routes that mean "show me the app" rather
/// than a particular window: the tray's left click, the Dock icon, a second
/// launch.
///
/// Prefers the plane window when it exists, because that is the window a
/// client user spends their time in; falls back to the node window, which can
/// always be re-created. Never opens a plane window that is not already there —
/// re-resolving a URL and dialing a host is not what clicking a Dock icon asked
/// for.
pub fn focus_any(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(PLANE_LABEL) {
        show(&w);
        return;
    }
    focus_node(app);
}

fn show(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

#[cfg(test)]
mod tests {
    use super::*;

    // The label is what `capabilities/node.json` names. A window built under
    // any other label is granted nothing, and the failure is silent: the page
    // renders and every command it calls is refused.
    #[test]
    fn the_node_label_is_the_one_the_capability_grants() {
        assert_eq!(NODE_LABEL, "node");
    }

    // The plane window is granted nothing, so its label must NOT be the one
    // the capability names. If these two ever became one string, the control
    // plane's own page would inherit the whole CLI surface.
    #[test]
    fn the_plane_window_is_not_the_granted_one() {
        assert_ne!(PLANE_LABEL, NODE_LABEL);
    }

    #[test]
    fn plane_min_width_matches_the_spa_tiling_breakpoint() {
        // WORKSPACE_TILING_MIN_WIDTH in apps/server/web/src/lib/breakpoints.ts.
        assert_eq!(PLANE_MIN_WIDTH as u32, 1024);
    }
}
