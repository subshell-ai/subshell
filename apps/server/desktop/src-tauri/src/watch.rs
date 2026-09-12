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
    // Compared as ORIGINS, not as strings: the window reports a full URL with
    // whatever path the SPA has routed to, and `Probe::origin` reports a bare
    // scheme/host/port.
    let same = tauri::Url::parse(current).ok().map(|u| u.origin()) == tauri::Url::parse(&next).ok().map(|u| u.origin());
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
        let probe = crate::control::probe_now(settings.get().binary_path.as_deref());
        let current = window.url().ok().map(|u| u.to_string());
        if let Some(next) = origin_changed(current.as_deref(), &probe) {
            // `open_main`'s existing-window branch navigates and re-raises;
            // it also re-validates the origin as loopback, which is the gate
            // that must not be bypassed just because this side built the URL.
            if let Err(e) = crate::windows::open_main(&app, &next) {
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
