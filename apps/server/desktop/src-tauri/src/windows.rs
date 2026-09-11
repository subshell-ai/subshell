//! The two windows, and why they are two.
//!
//! `console` is ours: a bundled local page that must render with the server
//! DOWN, and the only surface allowed to drive the CLI. `main` shows the
//! server's own SPA, loaded from the server's own HTTP origin — not from a
//! bundled copy — because `apps/server/web` is hard same-origin: relative
//! `apiFetch` with `credentials: "include"`, an auth client with no `baseURL`,
//! and a WebSocket URL built from `window.location.host`. A `tauri://` page
//! could not carry the `SameSite=Lax` session cookie to any of them.

use std::sync::atomic::{AtomicBool, Ordering};

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

/// Put the console out of the way once the dashboard is on screen.
///
/// MINIMIZED, never hidden. A hidden window is reachable only through the
/// tray, and on Linux the tray icon is drawn only where a StatusNotifier host
/// is registered — a stock GNOME has none, and there the icon is SILENTLY
/// invisible. Hiding the console there would strand it exactly as
/// `close_to_tray` would, which is why that feature is gated on a probe.
/// Minimizing keeps it in the window list, so it comes back without a tray,
/// without this app, and without any of that machinery being correct.
///
/// Only ever called once the dashboard is actually VISIBLE. The dashboard is
/// created hidden and shown by the title-bar handshake, so tucking at creation
/// time would leave nothing at all on screen until the page answered.
pub fn tuck_console(app: &AppHandle) {
    if let Some(console) = app.get_webview_window("console") {
        let _ = console.minimize();
    }
}

/// Bring a window to the FRONT, not merely out of hiding.
///
/// `show` + `unminimize` + `set_focus` was repeated at every call site and is
/// not enough on Linux: a Wayland compositor refuses an activation request
/// from a surface that is not already active, so `set_focus` returns Ok and
/// nothing moves. That is invisible when one window exists and a bug the
/// moment two do, which is this app's normal shape: clicking "Manage server"
/// while the 1280x860 dashboard is in front brought the console back
/// underneath it, so nothing appeared to happen.
///
/// A momentary always-on-top is what forces the stack change. It is cleared
/// from a short-lived thread rather than on the next line, because a
/// compositor that coalesces the two never raises the window at all, and
/// clearing it is what stops the console from being pinned over everything
/// afterwards. The delay is invisible and the thread cannot outlive the app by
/// more than it.
pub fn raise(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    #[cfg(target_os = "linux")]
    {
        let _ = window.set_always_on_top(true);
        let pinned = window.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(150));
            let _ = pinned.set_always_on_top(false);
            let _ = pinned.set_focus();
        });
    }
}

/// Create (or focus) the console window.
pub fn open_console(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window("console") {
        raise(&w);
        return Ok(w);
    }
    WebviewWindowBuilder::new(app, "console", WebviewUrl::App("index.html".into()))
        .title("Subshell Server")
        .inner_size(720.0, 620.0)
        .min_inner_size(560.0, 480.0)
        .resizable(true)
        .on_page_load(|window, _| {
            // A console created under a screen request delivers it once the
            // page exists; a request while one was live is emitted directly
            // by reset::arm_and_raise.
            if let Some(stash) = window.app_handle().try_state::<crate::reset::Stash>() {
                if let Some(screen) = stash.screen.lock().unwrap().take() {
                    use tauri::Emitter;
                    let _ = window.emit("desktop-screen", screen.as_str());
                }
            }
        })
        .build()
        .map_err(|e| format!("could not open the console window: {e}"))
}

/// Create (or focus) the first-run wizard.
///
/// Same one-press-then-focus contract as the console: `raise` on an existing
/// window, never a second creation. Resolves `wizard.html` through
/// `WebviewUrl::App` exactly like the console resolves `index.html` - dev
/// against the Vite server, prod against the bundle, no branch here.
pub fn open_wizard(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window("wizard") {
        raise(&w);
        return Ok(w);
    }
    // A setup assistant is a fixed frame (spec 2026-09-11 § 4): 1024 wide
    // because that is MIN_WIDTH, the dashboard's own floor, which is what
    // lets `open_main` take this window's geometry and appear in its place.
    WebviewWindowBuilder::new(app, "wizard", WebviewUrl::App("wizard.html".into()))
        .title("Set Up Subshell Server")
        .inner_size(MIN_WIDTH, 720.0)
        .resizable(false)
        .center()
        .build()
        .map_err(|e| format!("could not open the setup window: {e}"))
}

/// Raise whichever window MANAGES this machine: the wizard while the setup
/// has never finished, the console after. Every opener (tray, menu, the SPA's
/// pill through `desktop_open_console`) comes through here, so a machine can
/// never have its manage surface decided twice in two places - the branch is
/// one read of the flag the probe writes.
pub fn open_manage_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let onboarded = app
        .state::<subshell_desktop_core::settings::SettingsState>()
        .get()
        .onboarded;
    if onboarded {
        let w = open_console(app)?;
        // Raising the console retires the wizard, the same rule the
        // dashboard applies in open_main_now: there is ONE manage window,
        // and the Done screen's second button ("Go to status page") is this
        // path with the wizard still standing. The page holds no
        // window-close permission by design; the shell closes what it just
        // superseded.
        if let Some(z) = app.get_webview_window("wizard") {
            let _ = z.close();
        }
        return Ok(w);
    }
    open_wizard(app)
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
        raise(&w);
        tuck_console(app);
        return Ok(());
    }

    // When the assistant is on screen, the dashboard appears exactly where it
    // was, at the same size, and the assistant closes underneath: one window
    // changing screen, not two windows trading places (spec § 4). Logical
    // units, because the builder takes logical and the window reports physical.
    let inherited = app.get_webview_window("wizard").and_then(|w| {
        let scale = w.scale_factor().ok()?;
        let pos = w.outer_position().ok()?.to_logical::<f64>(scale);
        let size = w.inner_size().ok()?.to_logical::<f64>(scale);
        Some((pos, size))
    });

    let allowed = url.origin();
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        // The page is the SERVER's, and this window holds Tauri globals. A
        // navigation away from the server's own origin — a redirect, an href
        // in rendered content, an injected script — must not carry those
        // anywhere else. Same-origin navigation is the SPA doing its job.
        .on_navigation(move |u| u.origin() == allowed)
        // The app's own name, which the console window carries too: they are
        // two windows of one app, and this one's title is hidden under the
        // Overlay title bar the handshake below negotiates.
        .title("Subshell Server")
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

    let builder = match inherited {
        Some((pos, size)) => builder.position(pos.x, pos.y).inner_size(size.width, size.height),
        None => builder.inner_size(1280.0, 860.0),
    };

    let window = builder
        .build()
        .map_err(|e| format!("could not open the main window: {e}"))?;

    // Whatever the compositor or a previous session left behind, a dashboard
    // that opens maximized is not what was asked for. Cleared on CREATION
    // only: a user who maximizes it during a session keeps that, because the
    // focus path above does not run this.
    let _ = window.unmaximize();
    let _ = window.set_fullscreen(false);

    // An SPA that never answers — an older server, or a page that failed to
    // boot — must still get a window. Showing it decorated is the safe
    // outcome: the user sees the app, with an ordinary title bar.
    //
    // Gated on the handshake flag rather than on visibility: by the time this
    // fires the user may have closed the window to the tray, and a thread that
    // re-opened it six seconds later would be a window that will not stay shut.
    let fallback = window.clone();
    let handle = app.clone();
    let ready = app.state::<ShellReady>().0.clone();
    std::thread::spawn(move || {
        std::thread::sleep(READY_GRACE);
        if !ready.load(Ordering::SeqCst) {
            raise(&fallback);
            tuck_console(&handle);
        }
    });
    Ok(())
}

/// Whether the page has completed the title-bar handshake.
///
/// Managed state rather than a local flag because two things read it: the
/// fallback thread (which must not re-show a tray-hidden window) and
/// {@link shell_ready} itself (which must be idempotent — the SPA can remount).
pub struct ShellReady(pub std::sync::Arc<AtomicBool>);

impl ShellReady {
    pub fn new() -> Self {
        Self(std::sync::Arc::new(AtomicBool::new(false)))
    }
}

/// How long to wait for the page to say it can draw its own chrome.
const READY_GRACE: std::time::Duration = std::time::Duration::from_secs(6);

/// The page has rendered desktop chrome: take the title bar away and show it.
///
/// Called from the SPA's shell root, so it fires on EVERY route — including
/// `/login` and `/setup`, which render no sidebar and are exactly where a first
/// launch lands. An old SPA never calls it at all, which is the point.
///
/// Idempotent: the SPA can remount (a hard navigation at sign-out, a route
/// change), and a second call must not yank a window the user has since closed
/// to the tray back onto the screen.
pub fn shell_ready(app: &AppHandle, overlay: bool) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("no main window to ready".into());
    };
    if app.state::<ShellReady>().0.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    if overlay {
        // Traffic lights then float over the sidebar's top strip, which is why
        // the rail reserves room for them and starts an OS drag on pointer-down.
        let _ = window.set_title_bar_style(tauri::TitleBarStyle::Overlay);
        // An Overlay title bar is transparent, not absent — the TITLE is still
        // drawn, over the page's own content.
        let _ = window.set_title("");
    }
    #[cfg(not(target_os = "macos"))]
    let _ = overlay;
    raise(&window);
    // The dashboard is on screen now, so the console can step back.
    tuck_console(app);
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn min_width_matches_the_spa_tiling_breakpoint() {
        // WORKSPACE_TILING_MIN_WIDTH in apps/server/web/src/lib/breakpoints.ts.
        assert_eq!(super::MIN_WIDTH as u32, 1024);
    }
}
