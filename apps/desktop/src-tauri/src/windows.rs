//! The two windows, and why they are two.
//!
//! `console` is ours: a bundled local page that must render with the server
//! DOWN, and the only surface allowed to drive the CLI. `main` shows the
//! server's own SPA, loaded from the server's own HTTP origin — not from a
//! bundled copy — because `apps/frontend` is hard same-origin: relative
//! `apiFetch` with `credentials: "include"`, an auth client with no `baseURL`,
//! and a WebSocket URL built from `window.location.host`. A `tauri://` page
//! could not carry the `SameSite=Lax` session cookie to any of them.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::control::is_loopback;

/// Below this the SPA renders its PHONE drawer — `useIsWide()` is
/// `matchMedia("(min-width: 1024px)")` and `WORKSPACE_TILING_MIN_WIDTH` is
/// 1024. Tauri's own 800x600 default would ship the desktop app in the exact
/// chrome the desktop app exists to replace, so this is a floor, not a hint.
const MIN_WIDTH: f64 = 1024.0;
const MIN_HEIGHT: f64 = 640.0;

/// The marker the SPA reads to know it is running in the desktop shell.
///
/// A user-agent suffix rather than an injected script: it is present on the
/// FIRST request, readable synchronously before React mounts (so there is no
/// flash of web chrome), needs no IPC, and survives the hard
/// `window.location.href` navigations at `app-sidebar.tsx` sign-out and
/// `login.tsx`. An `onPageStarted` init script on a remote origin is not
/// guaranteed to run before the page's own scripts.
pub fn user_agent(app: &AppHandle) -> String {
    let version = app.package_info().version.to_string();
    let platform = if cfg!(target_os = "macos") { "macos" } else { "linux" };
    format!("SubshellDesktop/{version} ({platform}; p=1)")
}

/// Create (or focus) the console window.
pub fn open_console(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window("console") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(w);
    }
    WebviewWindowBuilder::new(app, "console", WebviewUrl::App("index.html".into()))
        .title("Subshell Server")
        .inner_size(720.0, 620.0)
        .min_inner_size(560.0, 480.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("could not open the console window: {e}"))
}

/// Create (or focus) the window that shows the server's SPA at `origin`.
pub fn open_main(app: &AppHandle, origin: &str) -> Result<(), String> {
    let url: tauri::Url = origin
        .parse()
        .map_err(|e| format!("the server reported an unusable base URL '{origin}': {e}"))?;
    // Belt and braces over `Probe::origin`, which already builds this from a
    // validated port and a loopback host: this window carries privileged
    // globals, so the last thing between a config value and pointing it at an
    // arbitrary host should be a refusal, not a comment.
    if !url.host_str().map(is_loopback).unwrap_or(false) {
        return Err(format!("refusing to open a non-loopback origin: {origin}"));
    }

    if let Some(w) = app.get_webview_window("main") {
        // The server may have been reconfigured to another port since this
        // window opened. Focusing a window pointed at a dead origin looks like
        // the app is broken; navigating it is the whole fix.
        if w.url().map(|u| u.origin() != url.origin()).unwrap_or(false) {
            let _ = w.navigate(url);
        }
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }

    let allowed = url.origin();
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        // Created HIDDEN and shown by `shell_ready` (or by the fallback below).
        // The chrome-less title bar cannot be chosen before the page loads: an
        // SPA that predates the desktop chrome under an Overlay title bar is an
        // UNMOVABLE window, and the only thing that knows whether this SPA has
        // it is the SPA. So the window negotiates instead of guessing.
        .visible(false)
        // The page is the SERVER's, and this window holds Tauri globals. A
        // navigation away from the server's own origin — a redirect, an href
        // in rendered content, an injected script — must not carry those
        // anywhere else. Same-origin navigation is the SPA doing its job.
        .on_navigation(move |u| u.origin() == allowed)
        .title("Subshell")
        .inner_size(1280.0, 860.0)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .user_agent(&user_agent(app))
        // Tauri's native file-drop handler otherwise SWALLOWS HTML5 drag
        // events, which would silently break both drag-a-subshell-into-a-
        // workspace (the `application/x-subshell-id` payload) and the
        // terminal's own file-drop uploads.
        .disable_drag_drop_handler()
        // Created HIDDEN and shown by `shell_ready` (or by the fallback
        // below). The chrome-less title bar cannot be chosen before the page
        // loads: an SPA that predates the desktop chrome under an Overlay
        // title bar is an UNMOVABLE window, and the only thing that knows
        // whether this SPA has that chrome is the SPA. So the window
        // negotiates rather than guessing — no version constant to keep in
        // step with a release it cannot see.
        .visible(false);

    let window = builder
        .build()
        .map_err(|e| format!("could not open the main window: {e}"))?;

    // An SPA that never answers — an older server, or a page that failed to
    // boot — must still get a window. Showing it decorated is the safe
    // outcome: the user sees the app, with an ordinary title bar.
    let fallback = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(READY_GRACE);
        if !fallback.is_visible().unwrap_or(true) {
            let _ = fallback.show();
            let _ = fallback.set_focus();
        }
    });
    Ok(())
}

/// How long to wait for the page to say it can draw its own chrome.
const READY_GRACE: std::time::Duration = std::time::Duration::from_secs(6);

/// The page has rendered desktop chrome: take the title bar away and show it.
///
/// Called once by the SPA's desktop sidebar. An old SPA never calls it, which
/// is exactly the point.
pub fn shell_ready(app: &AppHandle, overlay: bool) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("no main window to ready".into());
    };
    #[cfg(target_os = "macos")]
    if overlay {
        // Traffic lights then float over the sidebar's top strip, which is why
        // the rail reserves room for them and starts an OS drag on pointer-down.
        let _ = window.set_title_bar_style(tauri::TitleBarStyle::Overlay);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = overlay;
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn min_width_matches_the_spa_tiling_breakpoint() {
        // WORKSPACE_TILING_MIN_WIDTH in apps/frontend/src/lib/breakpoints.ts.
        assert_eq!(super::MIN_WIDTH as u32, 1024);
    }
}
