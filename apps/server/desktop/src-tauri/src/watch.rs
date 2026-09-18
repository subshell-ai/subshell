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
//! It never raises the assistant. A server that goes away while the dashboard
//! is open shows the SPA's own offline banner, and the person reaches
//! recovery through the pill, the tray or the Dock — all of which go through
//! `control::open_home`. A thread that raised a window on its own would take
//! the screen from whatever someone was doing, five seconds after a service
//! restart they started themselves.

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::control::{Probe, ProbeStep, ACTION_IN_FLIGHT};

/// The console page's own interval, kept: faster than a person reaches for a
/// button and slower than a service manager changes its mind. Each tick is a
/// few short CLI spawns, and the expensive parts (the login-shell PATH probe,
/// the bundled binary's version) are memoized once per process.
const PERIOD: Duration = Duration::from_secs(5);

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
    let next = probe.origin()?;
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
    std::thread::spawn(move || loop {
        std::thread::sleep(PERIOD);
        // A native action owns the machine's state while it runs and ends in
        // its own probe. A tick landing mid-chain would read a transition as
        // the answer.
        if ACTION_IN_FLIGHT.load(Ordering::SeqCst) {
            continue;
        }
        // Nothing to re-point: skip the spawns entirely rather than probing
        // for an answer no one is waiting on. This is what keeps a machine
        // sitting on the assistant from paying for a poll it does not use —
        // that page runs its own.
        let Some(window) = app.get_webview_window("main") else {
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
}
