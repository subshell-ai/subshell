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
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    let url = origin
        .parse()
        .map_err(|e| format!("the server reported an unusable base URL '{origin}': {e}"))?;

    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Subshell")
        .inner_size(1280.0, 860.0)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .user_agent(&user_agent(app))
        // Tauri's native file-drop handler otherwise SWALLOWS HTML5 drag
        // events, which would silently break both drag-a-subshell-into-a-
        // workspace (the `application/x-subshell-id` payload) and the
        // terminal's own file-drop uploads.
        .disable_drag_drop_handler();

    builder.build().map_err(|e| format!("could not open the main window: {e}"))?;
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
