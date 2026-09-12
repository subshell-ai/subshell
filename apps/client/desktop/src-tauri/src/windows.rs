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

use std::sync::{Arc, Mutex};

use subshell_desktop_core::tray::tray_support;
use subshell_desktop_core::zoom::assistant_frame;
use tauri::{AppHandle, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

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

/// The origin the plane window is allowed to be on.
///
/// Shared with the window's navigation handler rather than captured by value,
/// because the allowed origin is not a constant: switching planes is a
/// first-class flow, and a handler holding the origin the window was BUILT with
/// would refuse the switch — leaving the old plane on screen while the command
/// that asked for it reported success.
///
/// It is still a pin. Only [`open_plane`] writes it, only ever to a validated
/// http(s) origin, and only immediately before navigating there — so a
/// redirect, an href in rendered content, or an injected script still cannot
/// walk this window off the plane the user chose.
/// Held as the origin's ASCII SERIALIZATION rather than as `url::Origin`, which
/// tauri does not re-export. Equivalent for the http(s) tuple origins this ever
/// stores, and safe against the opaque ones it never does: those serialize to
/// `"null"`, which matches nothing here.
pub struct PlanePin(Arc<Mutex<Option<String>>>);

impl PlanePin {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }

    fn set(&self, url: &tauri::Url) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(url.origin().ascii_serialization());
    }
}

/// Below this the SPA renders its PHONE drawer — `useIsWide()` is
/// `matchMedia("(min-width: 1024px)")` and `WORKSPACE_TILING_MIN_WIDTH` is
/// 1024. Tauri's own 800x600 default would ship a desktop app in the exact
/// chrome a desktop app exists to replace, so this is a floor, not a hint.
const PLANE_MIN_WIDTH: f64 = 1024.0;
const PLANE_MIN_HEIGHT: f64 = 640.0;

/// The plane window's floor at a given text size.
///
/// The breakpoint the floor exists to clear is a CSS one, and zoom is what
/// divides physical pixels into CSS pixels — so at 150% a 1024px window is a
/// 683px viewport and the SPA drops to its phone drawer inside a window that
/// is, by the numbers, plenty wide. Scaling the floor is what keeps
/// `PLANE_MIN_WIDTH`'s promise true at every size.
fn floor_at(level: f64) -> LogicalSize<f64> {
    LogicalSize::new(PLANE_MIN_WIDTH * level, PLANE_MIN_HEIGHT * level)
}

/// The primary monitor's usable area in logical pixels, if one answers.
fn work_area(app: &AppHandle) -> Option<(f64, f64)> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let size = monitor.work_area().size.to_logical::<f64>(monitor.scale_factor());
    Some((size.width, size.height))
}

/// Re-fit the geometry that depends on the text size, after it changes.
///
/// Applying a zoom level is not the whole job: the node window is a fixed
/// frame that has to GROW with its text (it is not resizable, so it cannot be
/// opened up to compensate), and the plane window's floor is a CSS-pixel
/// promise that only holds if it scales. A window already under its new floor
/// is grown to it — a floor the window violates is not a floor.
pub fn refit(app: &AppHandle, level: f64) {
    if let Some(w) = app.get_webview_window(NODE_LABEL) {
        let (width, height) = assistant_frame(level, work_area(app));
        let _ = w.set_size(LogicalSize::new(width, height));
        // Re-centred because the frame is centred by construction and has just
        // changed size around a fixed top-left corner.
        let _ = w.center();
    }
    if let Some(w) = app.get_webview_window(PLANE_LABEL) {
        let floor = floor_at(level);
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

/// Create (or focus) the node window.
pub fn open_node(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(NODE_LABEL) {
        show(&w);
        return Ok(w);
    }
    // The assistant frame (spec 2026-09-11 § 3.1, adopted here by spec
    // 2026-09-12 § 6.4): the same 1024x720 Subshell Server's assistant uses,
    // because the two are one product and a person who has seen one should
    // recognise the other. FIXED rather than a minimum — every screen is a
    // 560px column centred in the region with a 72px bar under it, drawn to
    // that arithmetic — which is exactly why it SCALES with the text size
    // instead of leaving bigger text less room to say the same thing, and why
    // it is clamped to the display: a non-resizable window whose bottom edge
    // is past the work area takes its bar with it.
    let level = crate::zoom::level(app);
    let (width, height) = assistant_frame(level, work_area(app));
    WebviewWindowBuilder::new(app, NODE_LABEL, WebviewUrl::App("index.html".into()))
        // "Node", not "this machine": the two windows sit side by side in a
        // screenshot and in the window list, where "this machine" does not say
        // WHICH of them it means — and the word this app uses for a machine
        // that runs agents is "node".
        .title("Subshell Client — Node")
        .inner_size(width, height)
        .resizable(false)
        .center()
        .build()
        .map_err(|e| format!("could not open the node window: {e}"))
        .inspect(|w| {
            let _ = w.set_zoom(level);
        })
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
/// - **Navigation is pinned to the plane it is pointed at**, so a redirect or
///   an href in rendered content cannot walk this window somewhere else. The
///   pin follows a deliberate plane switch rather than being fixed at build
///   time — see [`PlanePin`].
pub fn open_plane(app: &AppHandle, origin: &str) -> Result<WebviewWindow, String> {
    let url: tauri::Url = origin
        .parse()
        .map_err(|e| format!("'{origin}' is not a usable control-plane URL: {e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("refusing to open a '{}' URL: {origin}", url.scheme()));
    }

    let pin = app.state::<PlanePin>();

    if let Some(w) = app.get_webview_window(PLANE_LABEL) {
        // The user may have pointed the app at a different plane since this
        // window opened. Focusing a window still showing the old one looks
        // like the switch did nothing; navigating it is the whole fix.
        if w.url().map(|u| u.origin() != url.origin()).unwrap_or(false) {
            // BEFORE the navigate, never after: the pin gates this very
            // navigation. `navigate()` reaches the platform webview's own load,
            // which consults the navigation delegate exactly as a link click
            // does — so a pin still naming the OLD plane refuses the switch,
            // silently, while the command that asked for it returns Ok.
            pin.set(&url);
            let _ = w.navigate(url);
        }
        show(&w);
        return Ok(w);
    }

    pin.set(&url);
    let allowed = pin.0.clone();
    let level = crate::zoom::level(app);
    let floor = floor_at(level);
    WebviewWindowBuilder::new(app, PLANE_LABEL, WebviewUrl::External(url))
        .on_navigation(move |u| {
            allowed
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
                .is_some_and(|origin| &u.origin().ascii_serialization() == origin)
        })
        .title("Subshell Client")
        .inner_size(1280.0, 860.0)
        .min_inner_size(floor.width, floor.height)
        // Tauri's native file-drop handler otherwise SWALLOWS HTML5 drag
        // events, which would silently break both drag-a-subshell-into-a-
        // workspace (the `application/x-subshell-id` payload) and the
        // terminal's own file-drop uploads.
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| format!("could not open the control-plane window: {e}"))
        .inspect(|w| {
            // On the built window, not the builder: zoom is a webview property,
            // and the plane's page has to come up at the size the user chose
            // rather than resize under them once it has painted.
            let _ = w.set_zoom(level);
        })
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

/// Whether the node window has any route back OTHER than the tray.
///
/// macOS always does: the menu bar is a system bar, it is always drawn, and
/// `menu.rs` puts "This machine…" on it. Linux has no menu bar (a GTK one is
/// per-window chrome inside the window you are trying to reach), and the plane
/// window cannot offer a route either — it is remote content granted nothing,
/// so it has no way to ask this app for anything.
///
/// That leaves the tray, which on a desktop with no StatusNotifier host is
/// SILENTLY INVISIBLE. So where the probe says no tray, the node window has to
/// be put on screen rather than merely be reachable in principle — otherwise
/// enrolment, agent installation and service control are unreachable on a stock
/// GNOME, which is the single most likely Linux desktop this app meets.
fn node_window_has_a_route_home() -> bool {
    cfg!(target_os = "macos") || tray_support().supported()
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
///
/// Where nothing else can reach the node window, this RE-CREATES it first.
/// `tray.rs` says relaunching is the way back from an invisible tray, and
/// `single-instance` routes a relaunch here — so this is the function that has
/// to make that true. Without it a user who closed the node window on a
/// tray-less desktop could relaunch forever and only ever get the plane back.
pub fn focus_any(app: &AppHandle) {
    if !node_window_has_a_route_home() && app.get_webview_window(NODE_LABEL).is_none() {
        let _ = open_node(app);
    }
    if let Some(w) = app.get_webview_window(PLANE_LABEL) {
        show(&w);
        return;
    }
    focus_node(app);
}

/// Put the app on screen at startup, given the plane address it has (if any).
///
/// The plane window is what a client's job is, so it leads. The node window
/// opens too when nothing else could reach it later — see
/// [`node_window_has_a_route_home`] — and opens FIRST so the plane lands on top
/// of it rather than under it.
pub fn open_at_startup(app: &AppHandle, plane: Option<&str>) -> Result<(), String> {
    let Some(url) = plane else {
        open_node(app)?;
        return Ok(());
    };
    if !node_window_has_a_route_home() {
        open_node(app)?;
    }
    // Not fatal. A plane that will not open (a URL that has stopped resolving,
    // a webview that failed to build) must still leave a usable app rather than
    // none — so fall back to the window that always works.
    if let Err(err) = open_plane(app, url) {
        eprintln!("subshell-client: could not open the control plane at {url}: {err}");
        open_node(app)?;
    }
    Ok(())
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

    // The pin is the plane window's whole navigation guard, so the two
    // properties that make it a guard are worth stating: it starts CLOSED (a
    // window whose pin was never set allows nothing), and it matches by exact
    // origin rather than by prefix or suffix.
    #[test]
    fn an_unset_pin_allows_nothing() {
        let pin = PlanePin::new();
        assert!(pin.0.lock().unwrap().is_none());
    }

    #[test]
    fn the_pin_holds_the_origin_and_not_the_path() {
        let pin = PlanePin::new();
        pin.set(&"https://subshell.example.com/nodes?x=1".parse().unwrap());
        let held = pin.0.lock().unwrap().clone().unwrap();
        assert_eq!(held, "https://subshell.example.com");
        // A neighbouring host that merely SHARES A PREFIX is a different
        // origin, which is the case a `starts_with` comparison would wave past.
        let evil: tauri::Url = "https://subshell.example.com.attacker.test/".parse().unwrap();
        assert_ne!(evil.origin().ascii_serialization(), held);
        // So is the same host on another scheme or port.
        for other in ["http://subshell.example.com/", "https://subshell.example.com:8443/"] {
            let u: tauri::Url = other.parse().unwrap();
            assert_ne!(u.origin().ascii_serialization(), held, "{other}");
        }
    }

    // An opaque origin (`data:`, `about:`) serializes to "null", and the pin
    // only ever holds an http(s) origin — so it can never be matched by one.
    #[test]
    fn an_opaque_origin_matches_no_pin() {
        let pin = PlanePin::new();
        pin.set(&"https://subshell.example.com".parse().unwrap());
        let held = pin.0.lock().unwrap().clone().unwrap();
        let data: tauri::Url = "data:text/html,<script>1</script>".parse().unwrap();
        assert_eq!(data.origin().ascii_serialization(), "null");
        assert_ne!(data.origin().ascii_serialization(), held);
    }

    #[test]
    fn plane_min_width_matches_the_spa_tiling_breakpoint() {
        // WORKSPACE_TILING_MIN_WIDTH in apps/server/web/src/lib/breakpoints.ts.
        assert_eq!(PLANE_MIN_WIDTH as u32, 1024);
    }

    // The floor exists to clear a CSS-pixel breakpoint, and zoom is what turns
    // physical pixels into CSS pixels: an unscaled floor would let a 1024px
    // window at 150% render the SPA's PHONE drawer.
    #[test]
    fn the_floor_scales_with_the_text_size() {
        let floor = floor_at(1.5);
        assert_eq!(floor.width, PLANE_MIN_WIDTH * 1.5);
        assert_eq!(floor.height, PLANE_MIN_HEIGHT * 1.5);
        assert_eq!(floor_at(1.0).width, PLANE_MIN_WIDTH);
    }

    // The node window is the SAME frame as Subshell Server's assistant. The
    // two are built in different crates now, so nothing but this says so.
    #[test]
    fn the_node_window_is_the_shared_assistant_frame() {
        use subshell_desktop_core::zoom::{ASSISTANT_HEIGHT, ASSISTANT_WIDTH};
        assert_eq!((ASSISTANT_WIDTH, ASSISTANT_HEIGHT), (1024.0, 720.0));
    }
}
