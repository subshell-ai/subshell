//! The poll that used to live in the console page (spec 2026-09-12 § 5.2).
//!
//! The console re-probed every five seconds because the manager's whole
//! subject is state this app does not own — a service that can be started,
//! stopped or crash from anywhere. Deleting that page does not delete the
//! reason, so the poll moved here, to a thread that runs for as long as the
//! app does and needs no window on screen.
//!
//! One duty, and it is the case the inventory found unhandled: **re-point
//! `main` when the server's origin moved.** A port changed from the SPA's
//! Service page and a restart later, the dashboard is a window fetching a
//! dead port, and nothing was watching for it — the console's poll knew the
//! new origin and had no way to say so, because it was not the window that
//! needed to hear it.
//!
//! It re-points `main`, and — the second duty added 2026-10-03 — it routes a
//! dead `main` to the assistant. The invariant used to be "never raise the
//! assistant": a server that goes away while the dashboard is LOADED shows the
//! SPA's own offline banner, and the person reaches recovery through the pill,
//! the tray or the Dock (`control::open_home`); a thread raising a window on its
//! own would take the screen five seconds after a restart they started. That held
//! while the only not-`Ready` case was a LOADED page that lost its API. It is
//! false for a `main` window whose document never loaded at all — server down
//! before the SPA arrived (a stop underneath an open dashboard, a boot race, a
//! reload while down). There is no SPA to draw a banner, so the window shows the
//! raw webview error "Could not connect to localhost"; tauri exposes no load
//! failure (no `PageLoadEvent` variant for it on either backend), so a probe
//! saying not-`Ready` beside an existing `main` is the only signal there is. The
//! route therefore raises the assistant ONLY for a window that can show nothing
//! else, and only after a debounce plus two exclusions (an in-flight action, a
//! supervisor respawn about to bring the server back) so a loaded-SPA blip is
//! never yanked.

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::control::{Probe, ProbeStep, ACTION_IN_FLIGHT};

/// The console page's own interval, kept: faster than a person reaches for a
/// button and slower than a service manager changes its mind. Each tick is a
/// few short CLI spawns, and the expensive parts (the login-shell PATH probe,
/// the bundled binary's version) are memoized once per process.
const PERIOD: Duration = Duration::from_secs(5);

/// Consecutive not-`Ready` ticks (each ~5s + probe) a dead `main` must survive
/// before the route to the assistant fires. Two: a single tick would land inside
/// an ordinary restart and yank a window that is merely mid-reload.
const ROUTE_AFTER: u8 = 2;

/// Whether a dead `main` window should be routed to the assistant this tick.
///
/// Pure, so the whole rule is testable without a window or a probe. It fires only
/// when there is a `main` window, the server is not `Ready`, no native action owns
/// the machine, the supervisor isn't about to bring the server back (an app-mode
/// crash-respawn leaves the port briefly empty with the SPA still loaded, showing
/// its own banner — `supervisor.rs` never takes `ACTION_IN_FLIGHT`, so this is the
/// one guard against yanking it), and the not-`Ready` state has persisted
/// `ROUTE_AFTER` ticks.
pub fn should_route_offline(
    has_main: bool,
    ready: bool,
    action_in_flight: bool,
    supervisor_respawning: bool,
    consecutive_not_ready: u8,
) -> bool {
    has_main && !ready && !action_in_flight && !supervisor_respawning && consecutive_not_ready >= ROUTE_AFTER
}

/// The origin `main` should navigate to, or `None` to leave it alone.
///
/// Three separate refusals, and each is a case that would otherwise show as a
/// broken window: no window at all (nothing to re-point), a probe that is not
/// `ready` (a stopped server has no origin to offer, and blanking the
/// dashboard mid-restart would replace the SPA's own offline banner with a
/// navigation failure), and an origin that already matches.
pub fn origin_changed(current: Option<&str>, probe: &Probe) -> Option<String> {
    let current = current?;
    if probe.next != ProbeStep::Ready {
        return None;
    }
    // The WINDOW's origin, not the server's: an instance whose base URL is
    // https wants the window there, and a loopback window that predates such a
    // change is one this tick should move (operator's report, 2026-09-19).
    let next = probe.window_origin()?;
    let here = tauri::Url::parse(current).ok()?;
    // **Only a window on LOOPBACK is re-pointed** (review, 2026-09-18). Since
    // the window may leave loopback (spec § 15), it is expected to sit on the
    // instance's own address — or, mid-sign-in, on an identity provider. This
    // check compared against `probe.origin()`, which is always loopback, so
    // every 5 s tick dragged such a window home: a proxied sign-in could never
    // complete, and the window could never rest on the second trusted origin
    // the whole guard exists for.
    //
    // A moved PORT on loopback is the case this function was written for and
    // is still worth repairing — the window would otherwise sit on a dead
    // origin — and it is the only one that can be told from a deliberate
    // departure without asking the page where it meant to be.
    if !here.host_str().map(crate::control::is_loopback).unwrap_or(false) {
        return None;
    }
    // Compared as ORIGINS, not as strings: the window reports a full URL with
    // whatever path the SPA has routed to, and `Probe::origin` reports a bare
    // scheme/host/port.
    let same = Some(here.origin()) == tauri::Url::parse(&next).ok().map(|u| u.origin());
    if same {
        None
    } else {
        Some(next)
    }
}

/// Start the watch. One thread for the life of the app; it holds only an
/// `AppHandle`, so nothing it touches outlives the process.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        // How many ticks a `main` window has been up while the server answered
        // not-`Ready`. Any legitimate reason to leave the window alone (an
        // action in flight, a receipt reconciling, no window, the server ready,
        // a supervisor respawn pending) resets it, so only a CONFIRMED, sustained
        // dead window reaches the route.
        let mut consecutive_not_ready: u8 = 0;
        loop {
            std::thread::sleep(PERIOD);
            // A native action owns the machine's state while it runs and ends in
            // its own probe. A tick landing mid-chain would read a transition as
            // the answer.
            if ACTION_IN_FLIGHT.load(Ordering::SeqCst) {
                consecutive_not_ready = 0;
                continue;
            }
            // Receipts still need reconciliation with every window closed.
            if crate::backup_restore::poll_selection(&app).is_err() {
                consecutive_not_ready = 0;
                continue;
            }
            // Nothing to re-point: skip the spawns entirely rather than probing
            // for an answer no one is waiting on. This is what keeps a machine
            // sitting on the assistant from paying for a poll it does not use —
            // that page runs its own.
            let Some(window) = app.get_webview_window("main") else {
                consecutive_not_ready = 0;
                continue;
            };
            let settings = app.state::<subshell_desktop_core::settings::SettingsState>();
            let probe = crate::control::probe_now(settings.get().binary_path.as_deref(), settings.get().supervision);
            // **The second duty, and it costs one field of a probe already taken.**
            // The instance's configured address is one of the two origins the
            // dashboard window may hold its commands on (spec 2026-09-18 § 15), and
            // an admin can move it from the Service page without moving the PORT —
            // which is the one thing `origin_changed` watches. Without this, the
            // trust state would keep answering for an address the machine no longer
            // has until something happened to re-open the window.
            crate::trust::window_state().set_base(probe.base_origin());
            // **Recording the new base is not applying it** (review, 2026-09-18).
            // The flag is written when a page COMMITS, so a base that moves under
            // a window nobody navigated leaves that page answering for an address
            // the machine no longer has — for as long as it sits there.
            //
            // `revalidate`, NOT a re-read of the window (second review, same day):
            // `WebviewWindow::url()` is WebKit's ACTIVE url, which is the REQUESTED
            // one while a load is in flight — so re-deciding from it would let a
            // page keep `location.href = "http://127.0.0.1:1/"` in a loop and wait
            // for a tick to land inside one of those provisional moments, arming
            // all seven commands for a document that never moved. The guard re-runs
            // over the last COMMITTED address instead.
            crate::trust::window_state().revalidate();
            // **The second duty: a `main` whose server is gone.** The trust work
            // above is for a LIVE server that moved; this is a server that stopped,
            // so the dashboard is (or will be) the webview's own "connection
            // refused" page, which no load event ever surfaces to us. Read the two
            // facts and drive the counter.
            let ready = probe.next == ProbeStep::Ready;
            // An app-mode child that is meant to be up but has no pid is one the
            // supervisor is about to respawn (or is mid-boot): a real gap in the port
            // that is NOT a dead window. `supervisor.rs` never takes ACTION_IN_FLIGHT,
            // so without this the crash-respawn blip would trip the debounce on a
            // loaded SPA showing its own offline banner.
            let supervisor_respawning = {
                let snap = app.state::<crate::supervisor::Supervisor>().snapshot();
                snap.desired_running && snap.pid.is_none()
            };
            consecutive_not_ready = if ready || supervisor_respawning {
                0
            } else {
                consecutive_not_ready.saturating_add(1)
            };
            if should_route_offline(true, ready, false, supervisor_respawning, consecutive_not_ready) {
                consecutive_not_ready = 0;
                // Raise the offline surface FIRST, then remove the dead dashboard.
                // Order is load-bearing: `should_prevent_exit` keys on `main`'s
                // existence, so destroying it before a window is there to take its
                // place could, with close-to-tray off, empty the set and quit the app.
                // `destroy`, never `close`: close-to-tray answers `CloseRequested`
                // with a hide, and a hidden `main` both keeps this thread probing and
                // gets the stale error page re-raised by the next `open_main`.
                match crate::windows::open_assistant(&app) {
                    Ok(_) => {
                        let _ = window.destroy();
                    }
                    Err(e) => eprintln!("subshell: the server is down but the assistant could not open: {e}"),
                }
                continue;
            }
            // **Routing only, never privileges** (review, 2026-09-18). This is the
            // ACTIVE url, so a page can put a value of its choosing here — which
            // buys it nothing but being navigated to a trusted origin, with
            // `open_main` clearing trust before it goes. Anything DECIDING from it
            // must use `trust::MainTrust::committed_url()` instead; this read is
            // one line from the guard and the next reuse of it will not know.
            let current = window.url().ok().map(|u| u.to_string());
            if let Some(next) = origin_changed(current.as_deref(), &probe) {
                // `open_main`'s existing-window branch navigates and re-raises;
                // it also re-validates the origin against the two this app may
                // point at, which is the gate that must not be bypassed just
                // because this side built the URL.
                if let Err(e) = crate::windows::open_main(&app, &next, probe.base_origin().as_deref()) {
                    eprintln!("subshell: could not follow the server to {next}: {e}");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_changed_only_when_ready_and_different() {
        let mut p = Probe {
            next: ProbeStep::Ready,
            ..Probe::default()
        };
        p.status = Some(serde_json::json!({
            "listen": { "portValid": true, "port": 3090 },
            "settings": { "APP_BASE_URL": { "value": "http://localhost:3090" } }
        }));
        assert_eq!(
            origin_changed(Some("http://localhost:3080"), &p),
            Some("http://localhost:3090".to_string())
        );
        assert_eq!(origin_changed(Some("http://localhost:3090"), &p), None);
        // A path on the current URL is not a difference: the SPA routes.
        assert_eq!(origin_changed(Some("http://localhost:3090/settings/service"), &p), None);
        // No window: nothing to re-point.
        assert_eq!(origin_changed(None, &p), None);
        p.next = ProbeStep::Start;
        // Not ready: leave the window alone.
        assert_eq!(origin_changed(Some("http://localhost:3080"), &p), None);
    }

    /// The route-to-offline rule: only a SUSTAINED dead `main`, and never while
    /// something legitimate explains the empty port (a live server, an in-flight
    /// action, a supervisor about to respawn). One not-Ready tick is a reload or
    /// a restart in progress, not a dead window.
    #[test]
    fn offline_route_needs_a_sustained_dead_main() {
        // The one firing cell: main up, not ready, nothing else explains it, debounced.
        assert!(should_route_offline(true, false, false, false, ROUTE_AFTER));
        assert!(should_route_offline(true, false, false, false, ROUTE_AFTER + 5));
        // Not debounced yet: one tick is a reload/restart, not a dead window.
        assert!(!should_route_offline(true, false, false, false, ROUTE_AFTER - 1));
        assert!(!should_route_offline(true, false, false, false, 0));
        // Every legitimate explanation for the empty port suppresses the route.
        assert!(!should_route_offline(true, true, false, false, ROUTE_AFTER + 5)); // server is up
        assert!(!should_route_offline(true, false, true, false, ROUTE_AFTER + 5)); // action in flight
        assert!(!should_route_offline(true, false, false, true, ROUTE_AFTER + 5)); // respawn pending
                                                                                   // No window to route.
        assert!(!should_route_offline(false, false, false, false, ROUTE_AFTER + 5));
    }

    /// **A window that is not on loopback is not one this poll may drag home**
    /// (review, 2026-09-18), and that guard had no test of its own.
    ///
    /// The dashboard window may leave loopback since spec § 15 — a proxied
    /// sign-in bounces it to an identity provider and back — and this poll
    /// re-points a window whose SERVER moved. Without the guard it re-pointed
    /// one whose server had not moved at all, five seconds into a sign-in,
    /// which is the report that made § 15 necessary in the first place.
    #[test]
    fn a_window_that_has_left_loopback_is_left_where_it_is() {
        let mut p = Probe {
            next: ProbeStep::Ready,
            ..Probe::default()
        };
        p.status = Some(serde_json::json!({
            "listen": { "portValid": true, "port": 3090 },
            "settings": { "APP_BASE_URL": { "value": "http://localhost:3090" } }
        }));

        // Mid sign-in at an identity provider: the origin differs from the
        // server's, and that is precisely not this poll's business.
        assert_eq!(origin_changed(Some("https://idp.example.com/authorize"), &p), None);
        // Nor is a plane on the instance's own public address.
        assert_eq!(origin_changed(Some("https://plane.example.com/"), &p), None);
        // Both loopback spellings still are, which is what the poll is FOR —
        // including with a path on them, so the guard cannot be "fixed" into
        // swallowing the case the function exists for (a moved port under an
        // SPA that has routed somewhere).
        assert_eq!(
            origin_changed(Some("http://127.0.0.1:3080"), &p),
            Some("http://localhost:3090".to_string())
        );
        assert_eq!(
            origin_changed(Some("http://localhost:3080/settings/networking"), &p),
            Some("http://localhost:3090".to_string())
        );
    }
}
