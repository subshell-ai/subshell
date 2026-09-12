//! The two windows, and why they are two.
//!
//! `wizard` is ours: a bundled local page — the ASSISTANT — that must render
//! with the server DOWN, and the only surface allowed to drive the CLI. It
//! keeps the `wizard` label because that label is an identifier (it keys the
//! capability file, the window-state store and every `get_webview_window`
//! lookup), while the page it carries is now first run, recovery, update and
//! reset. `main` shows the
//! server's own SPA, loaded from the server's own HTTP origin — not from a
//! bundled copy — because `apps/server/web` is hard same-origin: relative
//! `apiFetch` with `credentials: "include"`, an auth client with no `baseURL`,
//! and a WebSocket URL built from `window.location.host`. A `tauri://` page
//! could not carry the `SameSite=Lax` session cookie to any of them.

use std::sync::atomic::{AtomicBool, Ordering};

use subshell_desktop_core::zoom::assistant_frame;
use tauri::{AppHandle, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::control::is_loopback;

/// Below this the SPA renders its PHONE drawer — `useIsWide()` is
/// `matchMedia("(min-width: 1024px)")` and `WORKSPACE_TILING_MIN_WIDTH` is
/// 1024. Tauri's own 800x600 default would ship the desktop app in the exact
/// chrome the desktop app exists to replace, so this is a floor, not a hint.
const MIN_WIDTH: f64 = 1024.0;
const MIN_HEIGHT: f64 = 640.0;

/// The floor at a given text size.
///
/// The breakpoint the floor exists to clear is a CSS one, and zoom is what
/// divides physical pixels into CSS pixels — so at 150% a 1024px window is a
/// 683px viewport and the SPA drops to its phone drawer inside a window that
/// is, by the numbers, plenty wide. Scaling the floor is what keeps
/// `MIN_WIDTH`'s promise true at every size.
fn floor_at(level: f64) -> LogicalSize<f64> {
    LogicalSize::new(MIN_WIDTH * level, MIN_HEIGHT * level)
}

/// The floor, never larger than the display can show.
///
/// The scaled floor is what keeps the CSS-pixel breakpoint true, but it is
/// also a size `refit` SETS — so on a 1366x768 panel at 200% the unclamped
/// version would grow the window to 2048x1280 from its existing top-left and
/// pin `min_inner_size` there, leaving a window bigger than the screen and no
/// way back but dragging. The assistant frame has always clamped to the work
/// area; this is the same clamp for the same reason.
///
/// Clamping means the phone drawer can appear at a large text size on a small
/// display. That is the honest outcome: there genuinely is no 1024-CSS-pixel
/// viewport available there, and a window off the edge of the screen is the
/// worse of the two.
fn clamped_floor(level: f64, work_area: Option<(f64, f64)>) -> LogicalSize<f64> {
    let floor = floor_at(level);
    match work_area {
        Some((w, h)) if w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0 => {
            LogicalSize::new(floor.width.min(w), floor.height.min(h))
        }
        _ => floor,
    }
}

/// The primary monitor's usable area in logical pixels, if one answers.
fn work_area(app: &AppHandle) -> Option<(f64, f64)> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let size = monitor.work_area().size.to_logical::<f64>(monitor.scale_factor());
    Some((size.width, size.height))
}

/// Re-fit the geometry that depends on the text size, after it changes.
///
/// Applying a zoom level is not the whole job: the assistant is a fixed frame
/// that has to GROW with its text (it cannot be resized to compensate), and
/// the dashboard's floor is a CSS-pixel promise that only holds if it scales.
/// A window that is now under its new floor is grown to it — a floor the
/// window already violates is not a floor.
pub fn refit(app: &AppHandle, level: f64) {
    if let Some(w) = app.get_webview_window("wizard") {
        let (width, height) = assistant_frame(level, work_area(app));
        let _ = w.set_size(LogicalSize::new(width, height));
        // Re-centred because the frame is centred by construction and has just
        // changed size around a fixed top-left corner.
        let _ = w.center();
    }
    if let Some(w) = app.get_webview_window("main") {
        let floor = clamped_floor(level, work_area(app));
        let _ = w.set_min_size(Some(floor));
        if let (Ok(scale), Ok(size)) = (w.scale_factor(), w.inner_size()) {
            let size = size.to_logical::<f64>(scale);
            if size.width < floor.width || size.height < floor.height {
                let _ = w.set_size(LogicalSize::new(
                    size.width.max(floor.width),
                    size.height.max(floor.height),
                ));
            }
        }
    }
}

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
    user_agent_for(&version, platform, crate::control::bundled_version().as_deref())
}

/// The pure body of [`user_agent`], for the test.
///
/// `b=` is the server version this app BUNDLES (spec 2026-09-12 § 5.4). Only
/// the app knows it, and the SPA's Service page needs it to offer an update;
/// it is an optional group so a build that ships no server, Subshell Client
/// (which carries no marker at all) and every older shell all stay valid
/// against the same regex. `p=1` — the protocol number — is unchanged by it.
pub fn user_agent_for(version: &str, platform: &str, bundled: Option<&str>) -> String {
    match bundled {
        Some(b) => format!("SubshellDesktop/{version} ({platform}; p=1; b={b})"),
        None => format!("SubshellDesktop/{version} ({platform}; p=1)"),
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

/// Create (or focus) the assistant.
///
/// One-press-then-focus: `raise` on an existing window, never a second
/// creation, and it CLOSES nothing — the dashboard and the assistant are two
/// windows a person may legitimately have open at once now that the
/// assistant is also the recovery and update surface.
///
/// The title follows `onboarded` rather than being fixed, because the window
/// is no longer only a setup flow: "Set Up Subshell Server" is right for a
/// machine that has never finished setup and wrong for one whose server has
/// merely stopped.
pub fn open_assistant(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window("wizard") {
        raise(&w);
        return Ok(w);
    }
    let onboarded = app
        .state::<subshell_desktop_core::settings::SettingsState>()
        .get()
        .onboarded;
    let title = if onboarded {
        "Subshell Server"
    } else {
        "Set Up Subshell Server"
    };
    // A setup assistant is a fixed frame (spec 2026-09-11 § 4): 1024 wide
    // because that is MIN_WIDTH, the dashboard's own floor, which is what
    // lets `open_main` take this window's geometry and appear in its place.
    // Both are scaled by the same text size, so that stays true at every one.
    // The frame is clamped to the display rather than fixed — see
    // `subshell_desktop_core::zoom::assistant_frame`.
    let level = crate::zoom::level(app);
    let (width, height) = assistant_frame(level, work_area(app));
    WebviewWindowBuilder::new(app, "wizard", WebviewUrl::App("wizard.html".into()))
        .title(title)
        .inner_size(width, height)
        .resizable(false)
        .center()
        .build()
        .map_err(|e| format!("could not open the assistant window: {e}"))
        .inspect(|w| {
            let _ = w.set_zoom(level);
        })
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

    let level = crate::zoom::level(app);
    let floor = clamped_floor(level, work_area(app));
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
        .min_inner_size(floor.width, floor.height)
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

    // On the built window, not the builder: zoom is a webview property, and
    // the SPA has to come up at the size the user chose rather than resize
    // under them once it has painted.
    let _ = window.set_zoom(level);

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
    let ready = app.state::<ShellReady>().0.clone();
    std::thread::spawn(move || {
        std::thread::sleep(READY_GRACE);
        if !ready.load(Ordering::SeqCst) {
            raise(&fallback);
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
    Ok(())
}

#[cfg(test)]
mod tests {
    /// The unscaled width the floor is built from, for the clamp test.
    const FLOOR_W: f64 = super::MIN_WIDTH;
    #[test]
    fn user_agent_carries_the_bundled_server_version_when_there_is_one() {
        assert_eq!(
            super::user_agent_for("0.2.0", "macos", Some("0.3.0")),
            "SubshellDesktop/0.2.0 (macos; p=1; b=0.3.0)"
        );
        assert_eq!(
            super::user_agent_for("0.2.0", "linux", None),
            "SubshellDesktop/0.2.0 (linux; p=1)"
        );
    }

    #[test]
    fn min_width_matches_the_spa_tiling_breakpoint() {
        // WORKSPACE_TILING_MIN_WIDTH in apps/server/web/src/lib/breakpoints.ts.
        assert_eq!(super::MIN_WIDTH as u32, 1024);
    }

    // `open_main` inherits the assistant's geometry so the dashboard appears
    // in its place, which only works while the two agree on their width. They
    // are scaled by the same text size, so it is the UNSCALED pair that has to
    // match — and they live in two crates now, which is exactly when a pair
    // like this drifts.
    #[test]
    fn the_assistant_is_as_wide_as_the_dashboards_floor() {
        assert_eq!(subshell_desktop_core::zoom::ASSISTANT_WIDTH, super::MIN_WIDTH);
    }

    // The floor exists to clear a CSS-pixel breakpoint, and zoom is what turns
    // physical pixels into CSS pixels: an unscaled floor would let a 1024px
    // window at 150% render the SPA's PHONE drawer.
    /// The floor is a size `refit` SETS, so an unclamped one at a large text
    /// size grows the window past the edges of a small display and pins
    /// `min_inner_size` there — recoverable only by dragging. The assistant
    /// frame has always clamped; this is the same clamp.
    #[test]
    fn the_floor_never_outgrows_the_display() {
        // 1366x768 at 200%: the unclamped floor would be 2048x1280.
        let clamped = super::clamped_floor(2.0, Some((1366.0, 768.0)));
        assert_eq!((clamped.width, clamped.height), (1366.0, 768.0));
        // A roomy display leaves the scaled floor exactly as it was.
        let roomy = super::clamped_floor(1.5, Some((3000.0, 2000.0)));
        assert_eq!(roomy.width, FLOOR_W * 1.5);
        // No monitor answered: the scaled floor stands rather than a guess.
        assert_eq!(super::clamped_floor(1.5, None).width, FLOOR_W * 1.5);
    }

    #[test]
    fn the_floor_scales_with_the_text_size() {
        let floor = super::floor_at(1.5);
        assert_eq!(floor.width, super::MIN_WIDTH * 1.5);
        assert_eq!(floor.height, super::MIN_HEIGHT * 1.5);
        assert_eq!(super::floor_at(1.0).width, super::MIN_WIDTH);
    }
}
