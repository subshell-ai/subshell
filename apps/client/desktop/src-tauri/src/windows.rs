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
//!   content, and it is granted exactly ONE command —
//!   `desktop_open_in_browser`, which takes a path and can name no host. Every
//!   other command is refused. See [`open_plane`].
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
use tauri_plugin_opener::OpenerExt;

/// The label of the window showing a control plane's own page.
///
/// It is `main` because that is what it is to the user, and because the
/// window-state plugin and the Dock both key off labels.
///
/// `capabilities/main.json` names it and grants it ONE command. That file was
/// an absence until 2026-09-14, and the absence was the security boundary;
/// what replaced it is a boundary of the same kind drawn one level in — the
/// capability's scope is a wildcard, because a plane lives anywhere, so the
/// narrowness has to live in the COMMAND's argument instead. Adding a second
/// permission to that file is a change to the trust model, not a convenience,
/// and `ui/src/__tests__/ipc-acl.test.ts` pins it at one.
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

    /// The origin this window is pinned to, if it has been pointed anywhere.
    ///
    /// Read by `control::desktop_open_in_browser`, which is the whole reason
    /// this is not private: the plane's page may name a PATH, and the host it
    /// is joined onto has to be the one the navigation guard already enforces —
    /// not a second copy of the ladder that could answer differently after a
    /// switch. `None` while nothing has been opened, which the command reports
    /// rather than guessing.
    pub fn get(&self) -> Option<String> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// The marker the plane's SPA reads to know it is inside a shell.
///
/// This window carried NO marker until 2026-09-14, and the reason was sound
/// while it held no capability: the SPA reads the marker and then talks to
/// Tauri, and with nothing granted every one of those calls would have been
/// refused one at a time. It carries one now because the SPA's chrome split in
/// two — `isServerDesktop()` for everything that drives Subshell Server, and
/// `isDesktop()` for the two surfaces that are true of any shell — and this
/// window is granted exactly the one command those two need.
///
/// So the token is what matters: `SubshellClient`, which the SPA maps to
/// `app: "client"` and which switches on nothing else.
pub fn user_agent(app: &AppHandle) -> String {
    let version = app.package_info().version.to_string();
    let platform = if cfg!(target_os = "macos") { "macos" } else { "linux" };
    user_agent_for(&version, platform)
}

/// The pure body of [`user_agent`], for the test.
///
/// No `b=` group, unlike `apps/server/desktop`'s: that group is the SERVER
/// version a shell bundles, and this app bundles a node agent. The SPA's regex
/// leaves it optional, so its absence is a valid marker rather than a
/// truncated one.
pub fn user_agent_for(version: &str, platform: &str) -> String {
    format!("SubshellClient/{version} ({platform}; p=1)")
}

/// The narrowest the plane window may be dragged.
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
const PLANE_MIN_WIDTH: f64 = 360.0;
const PLANE_MIN_HEIGHT: f64 = 240.0;

/// The plane window's floor at a given text size.
///
/// The floor is a promise about the VIEWPORT, and zoom is what divides
/// physical pixels into CSS pixels — so at 150% an unscaled 360px window is a
/// 240px viewport, narrower than anything the SPA lays out for. Scaling the
/// floor is what keeps `PLANE_MIN_WIDTH`'s promise true at every size.
fn floor_at(level: f64) -> LogicalSize<f64> {
    LogicalSize::new(PLANE_MIN_WIDTH * level, PLANE_MIN_HEIGHT * level)
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

/// Create (or focus) the node window.
pub fn open_node(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(NODE_LABEL) {
        show(&w);
        return Ok(w);
    }
    // The assistant frame (spec 2026-09-11 § 3.1, adopted here by spec
    // 2026-09-12 § 6.4): the same frame Subshell Server's assistant uses,
    // because the two are one product and a person who has seen one should
    // recognise the other. FIXED rather than a minimum — every screen is a
    // 560px column centred in the region with a 72px bar under it, drawn to
    // that arithmetic — which is exactly why it SCALES with the text size
    // instead of leaving bigger text less room to say the same thing, and why
    // it is clamped to the display: a non-resizable window whose bottom edge
    // is past the work area takes its bar with it.
    // A page that has not loaded cannot be listening, and the flag must not
    // survive the window whose page set it — a reload otherwise leaves it true
    // and `show_node_screen` emits into the gap again.
    app.state::<PendingScreen>()
        .listening
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let level = crate::zoom::level(app);
    let (width, height) = assistant_frame(level, work_area(app));
    WebviewWindowBuilder::new(app, NODE_LABEL, WebviewUrl::App("index.html".into()))
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
/// - **`capabilities/main.json` names it, and grants it exactly ONE command**
///   (2026-09-14): `desktop_open_in_browser`, which takes a path and joins it
///   onto the origin [`PlanePin`] already holds. A control plane is reachable
///   over a LAN or a VPN, so its origin cannot be enumerated the way
///   `apps/server/desktop` pins loopback — which is why that capability's scope
///   is a wildcard and why the COMMAND, not the scope, has to be the narrow
///   thing. Everything privileged still lives on the bundled node page: no
///   `node_*` verb and no plugin permission is granted here.
/// - **A `SubshellClient/…` user-agent marker**, which is new and paired with
///   that grant. `apps/server/web` reads the marker to know it is in a shell;
///   it branches on the product TOKEN, so this window gets the two
///   shell-agnostic surfaces and none of Subshell Server's chrome — no overlay
///   title bar (this window keeps its own), no update, reset or supervision
///   card. Before the grant existed the marker was deliberately absent, because
///   every call it invited would have been refused one at a time.
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
    let floor = clamped_floor(level, work_area(app));
    WebviewWindowBuilder::new(app, PLANE_LABEL, WebviewUrl::External(url))
        // **Navigation follows the sign-in, the PIN does not** (operator's
        // report, 2026-09-18).
        //
        // This refused any URL whose origin was not the pinned plane's — which
        // is exactly what a proxied sign-in does: an instance behind an OAuth
        // proxy bounces the window to an identity provider on a different
        // origin and back. The window simply would not follow, so such a plane
        // could not be signed into from this app at all.
        //
        // Allowing http(s) costs this window nothing, because the pin is what
        // the one granted command reads, not the current page:
        // `desktop_open_in_browser` joins its path onto `PlanePin`'s origin
        // (`control.rs`), so a page at the identity provider — or anywhere else
        // a redirect chain leads — can still only open a path of the plane this
        // window was OPENED with. Scheme is checked rather than origin so the
        // window cannot be steered into `file:`, a custom handler or anything
        // else the OS would act on.
        .on_navigation(move |u| {
            // `allowed` is kept live so the pin still names the plane for the
            // command above; it deliberately no longer gates the navigation.
            let _pinned = allowed.lock().unwrap_or_else(|e| e.into_inner());
            subshell_desktop_core::browser::browsable_scheme(u.scheme())
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
        .title("Subshell Client")
        .inner_size(1280.0, 860.0)
        .min_inner_size(floor.width, floor.height)
        // See `user_agent_for`. The SPA reads this to offer "Open in browser",
        // which is the one thing this window is granted — and reads the PRODUCT
        // TOKEN, so it takes none of Subshell Server's chrome branches.
        .user_agent(&user_agent(app))
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
/// window cannot offer a route either — it is remote content, and its one
/// grant opens a browser rather than a window of this app.
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

/// Whether a launch lands on this app's own window (spec 2026-09-18 § 2).
///
/// **Always true**, whether or not this client already knows a plane address.
/// The rule it encodes: a client never opens the control plane's dashboard BY
/// ITSELF. A configured client lands on its own client-status screen and the
/// dashboard opens from the button there — so registering this machine is
/// never interrupted by a window belonging to the other half of the app, and a
/// person relaunching a configured client meets the page that can change it
/// rather than the one that cannot.
///
/// So the address is not read, and the parameter is here anyway: it is the
/// fact the rule is ABOUT ("this client is already pointed somewhere"), and a
/// decision that could not see it would need a new signature before the rule
/// could be reversed at all. That reversal is meant to be this body plus its
/// test going red, which is the whole reason a constant answer is written as a
/// function.
///
/// A predicate rather than an enum, deliberately: the enum this replaced
/// carried a `Plane` variant nothing constructed, which needed the only
/// UNCONDITIONAL `#[allow(dead_code)]` in any of the three desktop crates (the
/// two that remain are `cfg_attr(not(target_os = "macos"), …)` on code a
/// platform really does not compile, which is a different thing) and read as a
/// live branch no test could reach. The old shape is in git if it is wanted.
pub fn startup_leads_with_node(_plane: Option<&str>) -> bool {
    true
}

/// Put the app on screen at startup, given the plane address it has (if any).
///
/// The node window comes up FIRST and unconditionally — see
/// [`startup_leads_with_node`] for the rule and why it replaced the
/// plane-first shape this had until 2026-09-18, in which a settled address
/// meant the dashboard led and the setup carried on in the window behind it.
///
/// Opening it unconditionally SUBSUMES the two guards that shape needed, which
/// is why neither survives here rather than sitting as a branch nothing takes:
/// the [`node_window_has_a_route_home`] check, which forced the node window on
/// screen where no tray would ever draw an icon to reach it (it is on screen
/// now on every desktop, which is strictly more than that check bought), and
/// the fall back to it when a plane failed to open (no startup path can leave
/// this app with no window any more). `focus_any` still asks the tray
/// question, because that is the path where a node window may be GONE.
pub fn open_at_startup(app: &AppHandle, plane: Option<&str>) -> Result<(), String> {
    debug_assert!(startup_leads_with_node(plane));
    open_node(app)?;
    Ok(())
}

/// Raise the node window and ask its page to show a particular screen.
///
/// The page decides what to do with the name: it is one of the assistant's
/// own screen ids, and an id this build does not know is ignored rather than
/// being an error — which is what lets a menu item and a page ship
/// independently.
///
/// Emitted AFTER the window exists, and to that window alone: a broadcast
/// would also reach the plane's page, which is remote content this app grants
/// nothing and tells nothing.
pub fn show_node_screen(app: &AppHandle, screen: &str) {
    // STASH FIRST. `open_node` CREATES the window when it is absent, and an
    // emit to a window that is still loading reaches nothing: the page's
    // `listen()` registers over IPC after its module evaluates, Tauri queues
    // no events for a window with no listener, and the request is simply lost.
    //
    // Measured in the sibling app on 2026-09-12 and written up in
    // `apps/server/desktop/src-tauri/src/reset.rs` — pressing Reset on the
    // dashboard opened the assistant on the wrong screen because the request
    // was emitted before the page existed. This is the same shape, and here it
    // would land on the tray's About item: on a tray-capable Linux desktop
    // that is the ONLY route to About, so losing it loses the feature.
    //
    // A live window is told directly, because it has no page load to wait for.
    // Whichever path gets there takes the stash, so a request is applied once.
    // "Is a page LISTENING", not "does a window exist" — the same distinction
    // the pull was added to make, which the emit path here was still deciding
    // by proxy. Two About clicks in quick succession are enough: the first
    // stashes and starts building, the second sees a window and `take()`s the
    // stash into a page that has not registered a listener, so the pull that
    // follows finds nothing and About never opens. The flag below is set by
    // the pull itself — the one event that proves a page got far enough to
    // ask — and cleared when a window is built, so a reload cannot leave it
    // lying true.
    let state = app.state::<PendingScreen>();
    *state.screen.lock().unwrap_or_else(|e| e.into_inner()) = Some(screen.to_string());
    let listening = state.listening.load(std::sync::atomic::Ordering::SeqCst);
    let Ok(window) = open_node(app) else { return };
    show(&window);
    if listening {
        if let Some(pending) = take_pending_screen(app) {
            use tauri::Emitter;
            let _ = window.emit("desktop-screen", pending);
        }
    }
}

/// The screen a window that is still coming up was opened FOR.
///
/// Managed state rather than an argument, because the two deliverers are a
/// menu click and a page boot and they do not meet: one writes it, the other
/// asks for it (`node_pending_screen`).
pub struct PendingScreen {
    pub screen: std::sync::Mutex<Option<String>>,
    /// Whether a page has proved it is listening, by pulling at least once.
    ///
    /// The only fact that separates "a window exists" from "a window can hear
    /// an event", which is what the emit path in `show_node_screen` needs.
    /// Set by the pull (`node_pending_screen`), cleared when a window is
    /// built, so a reload cannot leave it lying true.
    pub listening: std::sync::atomic::AtomicBool,
}

impl PendingScreen {
    pub fn new() -> Self {
        Self {
            screen: std::sync::Mutex::new(None),
            listening: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

/// Take the pending screen, exactly once.
pub fn take_pending_screen(app: &AppHandle) -> Option<String> {
    app.state::<PendingScreen>()
        .screen
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
}

/// Record that a page asked — the proof `show_node_screen` emits on.
pub fn mark_page_listening(app: &AppHandle) {
    app.state::<PendingScreen>()
        .listening
        .store(true, std::sync::atomic::Ordering::SeqCst);
}

fn show(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

#[cfg(test)]
mod tests {
    /// The unscaled width the floor is built from, for the clamp test.
    const FLOOR_W: f64 = super::PLANE_MIN_WIDTH;
    use super::*;

    // The label is what `capabilities/node.json` names. A window built under
    // any other label is granted nothing, and the failure is silent: the page
    // renders and every command it calls is refused.
    #[test]
    fn the_node_label_is_the_one_the_capability_grants() {
        assert_eq!(NODE_LABEL, "node");
    }

    // The plane window's label must NOT be the one `node.json` names. If these
    // two ever became one string, the control plane's own page would inherit
    // the whole CLI surface — which is a different thing from the one command
    // `main.json` grants it, and the failure this pin exists for.
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

    // The floor is deliberately WELL BELOW the SPA's tiling breakpoint
    // (WORKSPACE_TILING_MIN_WIDTH in apps/server/web/src/lib/breakpoints.ts):
    // the plane window may be shrunk into its narrow chrome, which is what lets
    // it be parked in a corner. Pinned so that a later "fix" does not quietly
    // restore the 1024 floor it replaced.
    #[test]
    fn the_floor_is_a_third_of_the_spa_tiling_breakpoint() {
        let floor = floor_at(1.0);
        assert_eq!(floor.width as u32, 360);
        assert_eq!(floor.height as u32, 240);
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
        assert_eq!((laptop.width, laptop.height), (FLOOR_W * 2.0, PLANE_MIN_HEIGHT * 2.0));
        // A roomy display leaves the scaled floor exactly as it was.
        let roomy = super::clamped_floor(1.5, Some((3000.0, 2000.0)));
        assert_eq!(roomy.width, FLOOR_W * 1.5);
        // No monitor answered: the scaled floor stands rather than a guess.
        assert_eq!(super::clamped_floor(1.5, None).width, FLOOR_W * 1.5);
    }

    #[test]
    fn the_floor_scales_with_the_text_size() {
        let floor = floor_at(1.5);
        assert_eq!(floor.width, PLANE_MIN_WIDTH * 1.5);
        assert_eq!(floor.height, PLANE_MIN_HEIGHT * 1.5);
        assert_eq!(floor_at(1.0).width, PLANE_MIN_WIDTH);
    }

    /// A page that has not asked is not listening, and the flag says so.
    ///
    /// The emit path in `show_node_screen` used to read window EXISTENCE,
    /// which is true the instant the builder returns and long before any
    /// `listen()` has registered — so a second About click while the first
    /// window was still loading took the stash and emitted it into nothing.
    /// This is the value that replaced the proxy; only the pull sets it, and
    /// building a window clears it so a reload cannot leave it lying true.
    #[test]
    fn a_window_is_not_a_listening_page() {
        use std::sync::atomic::Ordering;
        let state = super::PendingScreen::new();
        assert!(!state.listening.load(Ordering::SeqCst), "nothing has asked yet");
        state.listening.store(true, Ordering::SeqCst);
        assert!(state.listening.load(Ordering::SeqCst));
        // What `open_node` does when it builds: the new page has not asked.
        state.listening.store(false, Ordering::SeqCst);
        assert!(!state.listening.load(Ordering::SeqCst));
    }

    /// The marker the plane's SPA reads to know it is inside a shell.
    ///
    /// Pinned against the regex in `apps/server/web/src/lib/desktop.ts`, which
    /// is the only consumer and lives in another language: a marker this app
    /// formats differently is not an error anywhere — the SPA simply renders
    /// as a browser, and "Open in browser" is silently absent.
    ///
    /// `SubshellClient`, not `SubshellDesktop`: the SPA branches on the product
    /// token, and reusing the server app's would switch on that app's chrome —
    /// the overlay title bar (which needs `desktop_shell_ready`, granted here
    /// to nothing) and the update, reset and supervision cards (which drive a
    /// `subshell-server` this app does not manage).
    ///
    /// There is NO `b=` group and never can be: that is the server version the
    /// shell BUNDLES, and this app bundles a node agent.
    #[test]
    fn the_user_agent_names_this_app_and_bundles_no_server() {
        assert_eq!(
            super::user_agent_for("0.3.0", "macos"),
            "SubshellClient/0.3.0 (macos; p=1)"
        );
        assert_eq!(
            super::user_agent_for("1.0.0", "linux"),
            "SubshellClient/1.0.0 (linux; p=1)"
        );
        for platform in ["macos", "linux"] {
            let ua = super::user_agent_for("0.3.0", platform);
            assert!(!ua.contains("SubshellDesktop"), "{ua}");
            assert!(!ua.contains("b="), "{ua}");
        }
    }

    // The node window is the SAME frame as Subshell Server's assistant. The
    // two are built in different crates now, so nothing but this says so.
    //
    // The literal pair is a TRIPWIRE, not a second source of truth: a change
    // to the shared frame is meant to fail here, so that whoever makes it
    // looks at THIS window's screens before agreeing to it. That is what it
    // did on 2026-09-14, when the frame was cut to 720x620 for the server's
    // setup screens — this app's widest fixed element is a `w-[360px]`
    // column, so it fits with room to spare, and the pair moves.
    #[test]
    fn the_node_window_is_the_shared_assistant_frame() {
        use subshell_desktop_core::zoom::{ASSISTANT_HEIGHT, ASSISTANT_WIDTH};
        assert_eq!((ASSISTANT_WIDTH, ASSISTANT_HEIGHT), (720.0, 620.0));
    }

    // The product rule, and the only place it is written down (spec
    // 2026-09-18 § 2): **a client never opens the control plane's dashboard by
    // itself.** A configured client lands on the node window's client-status
    // screen and presses a button to get the dashboard; an unconfigured one
    // always landed there. So a KNOWN address changes nothing, which is
    // exactly what this app did the opposite of until 2026-09-18 — it led with
    // the dashboard and left the setup running in the window behind it.
    //
    // A constant answer is worth a function and a test because the reversal is
    // a product decision someone will make again: it has to be this body plus
    // this assertion going red, not a hunt through the window code.
    #[test]
    fn startup_lands_on_the_node_window_whether_or_not_a_plane_is_known() {
        assert!(startup_leads_with_node(Some("https://plane.example.com")));
        assert!(startup_leads_with_node(None));
    }
}
