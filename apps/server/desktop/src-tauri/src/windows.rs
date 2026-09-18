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
use tauri_plugin_opener::OpenerExt;

/// The narrowest the dashboard may be dragged.
///
/// This was 1024x640 — the SPA's `useIsWide()` breakpoint
/// (`matchMedia("(min-width: 1024px)")`, the same number as
/// `WORKSPACE_TILING_MIN_WIDTH`) — so that the desktop app could never render
/// the phone drawer it exists to replace. That bought one thing and cost
/// another: a window that could not be tucked into a corner beside an editor,
/// which is a thing people actually do with a terminal. A third of it is the
/// floor now. The breakpoint has not moved and the narrow chrome below it is a
/// designed layout rather than a degraded one; the app simply no longer
/// refuses to cross it.
const MIN_WIDTH: f64 = 360.0;
const MIN_HEIGHT: f64 = 240.0;

/// The floor at a given text size.
///
/// The floor is a promise about the VIEWPORT, and zoom is what divides
/// physical pixels into CSS pixels — so at 150% an unscaled 360px window is a
/// 240px viewport, narrower than anything the SPA lays out for. Scaling the
/// floor is what keeps `MIN_WIDTH`'s promise true at every size.
fn floor_at(level: f64) -> LogicalSize<f64> {
    LogicalSize::new(MIN_WIDTH * level, MIN_HEIGHT * level)
}

/// The floor, never larger than the display can show.
///
/// The scaled floor is what keeps the CSS-pixel promise true, but it is also a
/// size `refit` SETS — so an unclamped floor taller than the display would grow
/// the window from its existing top-left and pin `min_inner_size` there,
/// leaving a window bigger than the screen and no way back but dragging. The
/// assistant frame has always clamped to the work area; this is the same clamp
/// for the same reason. A 360x240 floor at the top zoom rung is 720x480, so
/// this has room to spare on any display the app runs on — which is the point:
/// nothing here should ever be the reason a window cannot fit.
fn clamped_floor(level: f64, work_area: Option<(f64, f64)>) -> LogicalSize<f64> {
    let floor = floor_at(level);
    match work_area {
        Some((w, h)) if w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0 => {
            LogicalSize::new(floor.width.min(w), floor.height.min(h))
        }
        _ => floor,
    }
}

/// The dashboard's default size, before the text size scales it.
///
/// 1024x768 — the SPA's own `useIsWide()` breakpoint is `min-width: 1024px`,
/// so this is the narrowest default that still opens on the wide layout, and
/// a window that opens exactly as large as it needs to be reads as considered
/// where a 1280x860 one read as "freaking huge" (operator, 2026-09-14).
///
/// **Scaled by the text size at the call site**, for the reason
/// `assistant_frame` is: zoom divides physical pixels into CSS pixels, so an
/// unscaled 1024 window at 110% is a 931px viewport — under the breakpoint,
/// and the first thing a person would see is the phone drawer this app exists
/// to replace.
const MAIN_WIDTH: f64 = 1024.0;
const MAIN_HEIGHT: f64 = 768.0;

/// The dashboard's default size at one text size, never larger than the
/// display — the same clamp, and the same reason, as `assistant_frame`.
fn main_size(level: f64, work_area: Option<(f64, f64)>) -> (f64, f64) {
    let (width, height) = (MAIN_WIDTH * level, MAIN_HEIGHT * level);
    match work_area {
        Some((w, h)) if w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0 => (width.min(w), height.min(h)),
        _ => (width, height),
    }
}

/// Where to put the dashboard so it replaces the assistant IN PLACE.
///
/// The assistant's CENTRE is what carries over, not its top-left and not its
/// size. Size stopped being inheritable when the assistant was cut to its
/// content (720x620, 2026-09-14): the dashboard opening at that size would
/// land under the SPA's own `useIsWide()` breakpoint of 1024 and render the
/// narrow chrome this app exists to replace — on the very first screen after
/// setup. Inheriting the top-left instead would keep one corner still and
/// throw the window down-right, which reads as a new window appearing rather
/// than as this one changing screen.
///
/// Clamped so the result is on the display: a centred 1280-wide window whose
/// assistant sat near an edge would otherwise hang off it, and this window is
/// movable but that is a worse first impression than a nudge.
fn main_origin(
    assistant: Option<(f64, f64, f64, f64)>,
    size: (f64, f64),
    work_area: Option<(f64, f64)>,
) -> Option<(f64, f64)> {
    let (x, y, w, h) = assistant?;
    let (cx, cy) = (x + w / 2.0, y + h / 2.0);
    // Centred on the size ACTUALLY used, which the text size scales — centring
    // on the unscaled constant would offset the window at every zoom but one.
    let (mw, mh) = size;
    let (mut left, mut top) = (cx - mw / 2.0, cy - mh / 2.0);
    if let Some((aw, ah)) = work_area {
        if aw.is_finite() && ah.is_finite() && aw > 0.0 && ah > 0.0 {
            left = left.min(aw - mw).max(0.0);
            top = top.min(ah - mh).max(0.0);
        }
    }
    Some((left, top))
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
    // A setup assistant is a fixed frame (spec 2026-09-11 § 4): 1024 wide,
    // which is what `open_main` inherits when it takes this window's geometry
    // and appears in its place. It sits well above the dashboard's own floor,
    // and both are scaled by the same text size, so that stays true at every
    // one.
    // The frame is clamped to the display rather than fixed — see
    // `subshell_desktop_core::zoom::assistant_frame`.
    let level = crate::zoom::level(app);
    let (width, height) = assistant_frame(level, work_area(app));
    // A window about to load has no page listening YET, whatever the last one
    // proved. Cleared here so `arm_and_raise` cannot emit into it before its
    // page asks (`reset::Stash::page_listening`).
    if let Some(stash) = app.try_state::<crate::reset::Stash>() {
        stash.page_listening.store(false, std::sync::atomic::Ordering::SeqCst);
    }
    WebviewWindowBuilder::new(app, "wizard", WebviewUrl::App("wizard.html".into()))
        .title(title)
        .on_new_window({
            // Tauri DENIES a page's request for a new window (`target="_blank"`,
            // `window.open`) unless a handler answers it, and it denies SILENTLY —
            // every docs link on the served page looked broken (operator,
            // 2026-09-16). The answer: never a second in-app webview (these
            // windows' capabilities were written for one page each), and http(s)
            // handed to the person's own browser, which is both what a browser
            // would have done and strictly safer than hosting the link here.
            // Anything else is dropped, not handed to the OS.
            let opener = app.clone();
            move |url, _features| {
                if subshell_desktop_core::browser::browsable_scheme(url.scheme()) {
                    let _ = opener.opener().open_url(url.as_str(), None::<&str>);
                }
                tauri::webview::NewWindowResponse::Deny
            }
        })
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
///
/// `base_origin` is the instance's configured `APP_BASE_URL` origin, as the
/// caller's probe reported it (`Probe::base_origin`). It is the SECOND origin
/// this app may point the window at (spec 2026-09-18 § 15), and it is passed in
/// rather than read here because both callers already hold a fresh probe —
/// making the address this window may load a fact about the machine right now
/// rather than one cached at startup.
pub fn open_main(app: &AppHandle, origin: &str, base_origin: Option<&str>) -> Result<(), String> {
    let url: tauri::Url = origin
        .parse()
        .map_err(|e| format!("the server reported an unusable base URL '{origin}': {e}"))?;
    // **The app points this window at exactly two origins: loopback and the
    // instance's own configured address.** Whatever a PAGE then does, this is
    // the last thing between a config value and a window that carries
    // privileged globals — and it is the same predicate the commands
    // themselves are guarded by, so "where we may point it" and "what may
    // drive us" cannot drift apart. Navigation away from here is a page's
    // doing, and `crate::trust` covers that case.
    let trust = crate::trust::window_state();
    if !trust.trusts(&url, base_origin) {
        return Err(format!("refusing to open an untrusted origin: {origin}"));
    }
    trust.set_base(base_origin.map(str::to_string));

    if let Some(w) = app.get_webview_window("main") {
        // The server may have been reconfigured to another port since this
        // window opened. Focusing a window pointed at a dead origin looks like
        // the app is broken; navigating it is the whole fix.
        let current = w.url().ok();
        if current.as_ref().map(|u| u.origin() != url.origin()).unwrap_or(false) {
            // **Disarm, and let the COMMIT re-arm** (review, 2026-09-18). This
            // used to `evaluate(&url)` on the grounds that the navigation was
            // ours rather than a page's — but `navigate()` is asynchronous and
            // the page on screen keeps running until the new document commits,
            // or forever if it never does. Arming for the TARGET is the same
            // escalation that was removed from `on_navigation`, reached from
            // the app's side: a window sitting on a third origin (mid proxied
            // sign-in, say) would hold all seven commands the moment someone
            // clicked the tray, for as long as loopback took to answer.
            //
            // Nothing is lost by waiting: `PageLoadEvent::Started` fires
            // before any script in the new page runs, so the SPA's own
            // title-bar handshake is never refused.
            trust.clear();
            let _ = w.navigate(url.clone());
        } else if let Some(current) = current {
            // Nothing to re-point — but the base may have moved under a page
            // that stayed put, and this is the tick that learns it.
            trust.evaluate(&current);
        } else {
            // The window would not say where it is (review, 2026-09-18). An
            // unreadable URL is not evidence of a trusted one, and this branch
            // goes on to RAISE the window — so the flag it keeps would be one
            // nothing re-checked. A commit re-arms it; until then, nothing.
            trust.clear();
        }
        raise(&w);
        return Ok(());
    }

    // When the assistant is on screen the dashboard appears in its place and
    // the assistant closes underneath: one window changing screen, not two
    // windows trading places (spec § 4). What carries over is the CENTRE —
    // see `main_origin` for why the size no longer can. Logical units,
    // because the builder takes logical and the window reports physical.
    let assistant = app.get_webview_window("wizard").and_then(|w| {
        let scale = w.scale_factor().ok()?;
        let pos = w.outer_position().ok()?.to_logical::<f64>(scale);
        let size = w.inner_size().ok()?.to_logical::<f64>(scale);
        Some((pos.x, pos.y, size.width, size.height))
    });
    let size = main_size(crate::zoom::level(app), work_area(app));
    let inherited = main_origin(assistant, size, work_area(app));

    let level = crate::zoom::level(app);
    let floor = clamped_floor(level, work_area(app));
    // **Before the window exists**, for the address THIS SIDE chose — the
    // refusal above already returned for anything untrusted, and no page can be
    // invoking in the meantime, because this branch runs only when no `main`
    // window exists.
    //
    // It does NOT exist to beat the page to the guard (review, 2026-09-18): the
    // old comment claimed a trailing guard "would refuse the SPA's own
    // title-bar handshake on a fast machine", which is not a race that exists.
    // `PageLoadEvent::Started` is raised from `didCommitNavigation:` (macOS)
    // and `LoadEvent::Committed` (GTK), both BEFORE the document's scripts run,
    // so arming always precedes the first `invoke()`. Leaving that claim here
    // would be the precedent for the next eager arm, which is exactly how the
    // one this batch removed came to exist.
    trust.evaluate(&url);
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        // **Navigation follows the sign-in; the PRIVILEGES do not** (operator's
        // decision, spec 2026-09-18 § 15 — the same fix Subshell Client took in
        // `f1c2aa68`, for the same report).
        //
        // This refused any URL whose origin was not the one the window opened
        // with, which is exactly what a proxied sign-in does: an instance
        // behind an OAuth proxy bounces the window to an identity provider on
        // a third origin and back. Such a plane could not be shown in this app
        // at all.
        //
        // What makes allowing it survivable — this window holds seven
        // commands, one of which switches who runs the server — is that the
        // handler RECOMPUTES what the page may do for every URL it commits to
        // (`crate::trust`), so the privileges belong to the address rather than
        // to the window. Scheme is checked rather than origin so the window
        // still cannot be steered into `file:`, a custom handler, or anything
        // else the OS would act on.
        .on_navigation(move |u| crate::trust::window_state().allow_navigation(u))
        // **Arming happens HERE, on a committed main-frame load** (review,
        // 2026-09-18). `on_navigation` runs at request time and fires for
        // subframes, so a page that navigated somewhere trusted-looking and
        // FAILED — or that merely embedded an iframe — could arm the guard
        // while its own document stayed on screen. `PageLoadEvent::Started` is
        // raised from `didCommitNavigation:` (macOS) and `LoadEvent::Committed`
        // (GTK), both main-frame-only and both after the document is really
        // this window's.
        .on_page_load(|_webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                crate::trust::window_state().committed(payload.url());
            }
        })
        .on_new_window({
            // Tauri DENIES a page's request for a new window (`target="_blank"`,
            // `window.open`) unless a handler answers it, and it denies SILENTLY —
            // every docs link on the served page looked broken (operator,
            // 2026-09-16). The answer: never a second in-app webview (these
            // windows' capabilities were written for one page each), and http(s)
            // handed to the person's own browser, which is both what a browser
            // would have done and strictly safer than hosting the link here.
            // Anything else is dropped, not handed to the OS.
            let opener = app.clone();
            move |url, _features| {
                if subshell_desktop_core::browser::browsable_scheme(url.scheme()) {
                    let _ = opener.opener().open_url(url.as_str(), None::<&str>);
                }
                tauri::webview::NewWindowResponse::Deny
            }
        })
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

    let builder = builder.inner_size(size.0, size.1);
    let builder = match inherited {
        Some((left, top)) => builder.position(left, top),
        // No assistant to replace — the OS decides, as it did before.
        None => builder,
    };

    let window = builder.build().map_err(|e| {
        // A window that never opened leaves nothing trusted behind it. Nothing
        // could have invoked through it anyway — the grant is scoped to a
        // window that does not exist — but a true flag with no page is the kind
        // of state nobody thinks to check.
        trust.clear();
        format!("could not open the main window: {e}")
    })?;

    // On the built window, not the builder: zoom is a webview property, and
    // the SPA has to come up at the size the user chose rather than resize
    // under them once it has painted.
    let _ = window.set_zoom(level);

    // The native About panel lives on a menu on both platforms (spec
    // 2026-09-17 § 6): macOS hangs it on the app menu (`menu.rs`); there is
    // no app menu here, so the dashboard carries a one-item menu bar. This
    // window and not the assistant, deliberately — a GTK bar would eat into
    // the assistant's fixed frame, whose layout is drawn to its arithmetic,
    // and on a machine whose server is down the details disclosure still
    // names the app and its version.
    #[cfg(not(target_os = "macos"))]
    if let Ok(menu) = crate::about::window_menu(app) {
        let _ = window.set_menu(menu);
    }

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

    // The floor is deliberately WELL BELOW the SPA's tiling breakpoint
    // (WORKSPACE_TILING_MIN_WIDTH in apps/server/web/src/lib/breakpoints.ts):
    // the dashboard may be shrunk into its narrow chrome, which is what lets
    // this window be parked in a corner. Pinned so that a later "fix" does not
    // quietly restore the 1024 floor it replaced.
    #[test]
    fn the_floor_is_a_third_of_the_spa_tiling_breakpoint() {
        let floor = super::floor_at(1.0);
        assert_eq!(floor.width as u32, 360);
        assert_eq!(floor.height as u32, 240);
    }

    // `open_main` places the dashboard on the assistant's centre, and a
    // frame below the floor is one the window cannot hold. They are scaled by the same text size, so it is the UNSCALED pair
    // that has to clear it — and they live in two crates now, which is exactly
    // when a pair like this drifts.
    /// The dashboard replaces the assistant CENTRED on it, at its own size.
    ///
    /// Inheriting the assistant's SIZE is what this replaced: at 720x620 the
    /// dashboard would open under the SPA's 1024 breakpoint and render narrow
    /// chrome on the first screen after setup.
    #[test]
    fn the_dashboard_takes_the_assistants_centre_not_its_corner() {
        // An assistant at (440, 190) sized 720x620 is centred on (800, 500);
        // a 1280x860 dashboard centred there starts at (160, 70).
        let got = super::main_origin(
            Some((440.0, 190.0, 720.0, 620.0)),
            (1280.0, 860.0),
            Some((2560.0, 1440.0)),
        );
        assert_eq!(got, Some((160.0, 70.0)));
    }

    #[test]
    fn the_dashboard_is_nudged_back_onto_the_display() {
        // An assistant near the top-left would centre a wider window off the
        // screen. Movable is not an excuse for opening half off it.
        let got = super::main_origin(Some((0.0, 0.0, 720.0, 620.0)), (1280.0, 860.0), Some((1440.0, 900.0)));
        assert_eq!(got, Some((0.0, 0.0)));
        // And near the bottom-right, the other edge.
        let got = super::main_origin(
            Some((1400.0, 860.0, 720.0, 620.0)),
            (1280.0, 860.0),
            Some((1440.0, 900.0)),
        );
        assert_eq!(got, Some((160.0, 40.0)));
    }

    /// The default opens on the WIDE layout at every text size.
    ///
    /// 1024 is the SPA's `useIsWide()` breakpoint exactly, and zoom divides
    /// physical pixels into CSS pixels — so an unscaled window at 110% would
    /// be a 931px viewport and the first screen a person saw would be the
    /// phone drawer this app exists to replace.
    #[test]
    fn the_default_size_grows_with_the_text_in_it() {
        let big = Some((3840.0, 2160.0));
        assert_eq!(super::main_size(1.0, big), (1024.0, 768.0));
        assert_eq!(super::main_size(1.1, big), (1024.0 * 1.1, 768.0 * 1.1));
        // The CSS viewport is what the breakpoint reads, and it stays at 1024.
        let (w, _) = super::main_size(1.5, big);
        assert_eq!(w / 1.5, 1024.0);
    }

    #[test]
    fn the_default_size_never_outgrows_the_display() {
        // A 1366x768 laptop cannot show 1024x768 plus chrome at 150%.
        assert_eq!(super::main_size(1.5, Some((1366.0, 768.0))), (1366.0, 768.0));
        assert_eq!(super::main_size(1.0, None), (1024.0, 768.0));
    }

    #[test]
    fn no_assistant_means_no_inherited_position() {
        // Nothing to replace: the OS places it, which is what happened before
        // any of this when the assistant was already closed.
        assert_eq!(super::main_origin(None, (1280.0, 860.0), Some((1440.0, 900.0))), None);
    }

    #[test]
    fn an_unanswerable_display_still_places_the_dashboard() {
        // No monitor, or a nonsense one: centre on the assistant and skip the
        // clamp rather than refusing to place the window at all.
        assert_eq!(
            super::main_origin(Some((440.0, 190.0, 720.0, 620.0)), (1280.0, 860.0), None),
            Some((160.0, 70.0))
        );
        assert_eq!(
            super::main_origin(
                Some((440.0, 190.0, 720.0, 620.0)),
                (1280.0, 860.0),
                Some((f64::NAN, f64::NAN))
            ),
            Some((160.0, 70.0))
        );
    }

    #[test]
    fn the_assistant_clears_the_dashboards_floor() {
        let floor = super::floor_at(1.0);
        assert!(subshell_desktop_core::zoom::ASSISTANT_WIDTH >= floor.width);
        assert!(subshell_desktop_core::zoom::ASSISTANT_HEIGHT >= floor.height);
    }

    // The floor is a promise about the viewport, and zoom is what turns
    // physical pixels into CSS pixels: an unscaled floor would leave a 360px
    // window at 150% laying out in 240 CSS pixels.
    /// The floor is a size `refit` SETS, so an unclamped one at a large text
    /// size grows the window past the edges of a small display and pins
    /// `min_inner_size` there — recoverable only by dragging. The assistant
    /// frame has always clamped; this is the same clamp.
    #[test]
    fn the_floor_never_outgrows_the_display() {
        // A 640x400 work area at 200%: the unclamped floor would be 720x480.
        let clamped = super::clamped_floor(2.0, Some((640.0, 400.0)));
        assert_eq!((clamped.width, clamped.height), (640.0, 400.0));
        // The display a laptop actually has leaves even the top rung alone.
        let laptop = super::clamped_floor(2.0, Some((1366.0, 768.0)));
        assert_eq!((laptop.width, laptop.height), (FLOOR_W * 2.0, super::MIN_HEIGHT * 2.0));
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
