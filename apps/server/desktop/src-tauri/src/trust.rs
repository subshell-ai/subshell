//! Which page may hold the dashboard window's seven commands.
//!
//! **The boundary used to be the capability's SCOPE** — `capabilities/main.json`
//! named `http://localhost:*` and `http://127.0.0.1:*`, Tauri refused every
//! command from any other origin, and nothing else had to be true. That scope
//! is a static file and an instance's address is a config value, so the two
//! could never be reconciled: a control plane behind an OAuth proxy could not
//! be shown in this app at all, because a proxied sign-in bounces the window to
//! an identity provider on a third origin and back, and `on_navigation` refused
//! to follow. The operator's call on 2026-09-18 (spec 2026-09-18 § 15) was to
//! allow it and keep the seven commands.
//!
//! So the scope becomes a wildcard and **this module becomes the boundary**.
//! One predicate answers both halves of it, which is the property worth
//! holding on to: [`MainTrust::trusts`] decides where `open_main` may POINT the
//! window, and the same call decides whether a page that got somewhere by
//! itself may invoke anything. Trusted means this machine's loopback (either
//! spelling, any port, http — exactly what the old scope named) or the
//! instance's configured `APP_BASE_URL` origin. An identity provider's page can
//! sign you in; it cannot restart your server, switch your supervisor, raise
//! the reset screen or post a notification in this app's name.
//!
//! Three rules hold it up, and each is load-bearing:
//!
//! - **The flag is set by the navigation handler, never by a page.** It is
//!   recomputed for every URL the window commits to, so a redirect chain that
//!   ends somewhere else cannot leave it true.
//! - **Navigation still refuses a non-http(s) scheme.** The window must not be
//!   steerable into `file:`, a custom handler, or anything else the OS would
//!   act on — an untrusted PAGE is the thing this module models, and handing
//!   the OS a URL is outside what any guard here could undo.
//! - **The guard runs at the invoke handler**, in front of every app command,
//!   keyed on the calling webview's label. That is what makes it uniform over
//!   all seven without touching a single signature: three of the seven take no
//!   argument or no handle at all (`desktop_permissions` takes nothing), so a
//!   per-command check would have had to widen the very signatures
//!   `ipc-acl.test.ts` pins.
//!
//! What it does NOT cover, said plainly: a page on the instance's own address
//! now holds everything a loopback page held, and that address may be reachable
//! from a network rather than only from this machine. That is the operator's
//! decision, and `docs/security.md` § 11.11 carries the accounting.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use subshell_desktop_core::browser::browsable_scheme;
use tauri::Url;

/// The window this guard is about. The assistant (`wizard`) is a bundled page
/// this repo ships and is never subject to it — it is the surface that repairs
/// a machine whose server is unreachable, and refusing it because some OTHER
/// window wandered onto a sign-in page would be a new way to strand someone.
pub const MAIN: &str = "main";

/// What a refused command answers. It names the rule rather than the origin:
/// the page would only be quoting itself back, and the person who needs this
/// sentence is reading a console in a window that is mid-sign-in.
pub const REFUSAL: &str = "This page is not on an address Subshell Server trusts, so it cannot drive this app.";

/// The dashboard window's trust state: which origin the instance configured,
/// and whether the page currently loaded is one of the two trusted ones.
///
/// A struct with an instance in a `static`, rather than free statics, for one
/// reason that has bitten this crate before: cargo runs tests in parallel
/// inside one binary, so process-wide state one test writes is read by another
/// on a different thread (`control.rs`'s `dev_spa_origin` carries the same
/// scar). Every test below drives its own [`MainTrust`]; the app drives
/// [`window_state`].
pub struct MainTrust {
    /// The instance's configured `APP_BASE_URL` origin, as the probe last
    /// reported it. `None` on a machine that configured none — which leaves
    /// loopback as the only trusted origin, i.e. exactly the old behaviour.
    ///
    /// Live rather than captured: an admin can move `APP_BASE_URL` from the
    /// Service page while this app runs, and a navigation handler holding a
    /// snapshot from window-open time would refuse the address the instance
    /// now answers on.
    base: Mutex<Option<String>>,
    /// Whether the URL the window last committed to is trusted. False until a
    /// window is opened, and false again when one is destroyed: a command is
    /// answered because a trusted page asked, never because none did.
    trusted: AtomicBool,
}

impl MainTrust {
    pub const fn new() -> Self {
        Self {
            base: Mutex::new(None),
            trusted: AtomicBool::new(false),
        }
    }

    /// Record the instance's configured base URL origin.
    ///
    /// Called by `open_main` with `Probe::base_origin()` and refreshed by the
    /// watch thread, so the answer this guard uses is the machine's current
    /// configuration rather than whatever it was when the window opened.
    pub fn set_base(&self, origin: Option<String>) {
        *self.base.lock().unwrap_or_else(|e| e.into_inner()) = origin;
    }

    /// The recorded base URL origin.
    pub fn base(&self) -> Option<String> {
        self.base.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// **The whole boundary, in one predicate.**
    ///
    /// `base` is passed IN rather than read from `self` so that `open_main`
    /// can decide with the probe's fresh answer in the same breath it records
    /// it, and so the decision is testable with no state at all.
    ///
    /// Loopback is http-only and any port — the two spellings the capability
    /// scope used to name, unchanged, because that is what `Probe::origin`
    /// builds and widening it here would trust an origin nothing can produce.
    /// The base URL may be https, and is compared as an ORIGIN: scheme, host
    /// and port together, never a suffix or a host match, because
    /// `https://plane.example.com` and `http://plane.example.com:8443` are
    /// different servers.
    pub fn trusts(&self, url: &Url, base: Option<&str>) -> bool {
        // An opaque origin (a non-special scheme) compares equal to nothing,
        // including itself — so this is a refusal before the comparison rather
        // than a subtlety inside it.
        if !url.origin().is_tuple() {
            return false;
        }
        if url.scheme() == "http" && url.host_str().map(crate::control::is_loopback).unwrap_or(false) {
            return true;
        }
        let Some(base) = base else {
            return false;
        };
        let Ok(base) = base.parse::<Url>() else {
            return false;
        };
        browsable_scheme(base.scheme()) && base.origin().is_tuple() && base.origin() == url.origin()
    }

    /// Recompute the flag for a URL the window is committing to, and answer it.
    ///
    /// The ONLY writer of the flag besides [`clear`](Self::clear). Reads the
    /// recorded base, because this runs from the navigation handler where no
    /// probe is at hand.
    pub fn evaluate(&self, url: &Url) -> bool {
        let trusted = self.trusts(url, self.base().as_deref());
        self.trusted.store(trusted, Ordering::SeqCst);
        trusted
    }

    /// Whether the page now in the window may invoke this app's commands.
    pub fn is_trusted(&self) -> bool {
        self.trusted.load(Ordering::SeqCst)
    }

    /// Forget any trust. Called when the window is destroyed and before one is
    /// pointed anywhere, so the flag can never outlive the page that earned it.
    pub fn clear(&self) {
        self.trusted.store(false, Ordering::SeqCst);
    }

    /// The navigation handler's whole decision: refuse anything the OS would
    /// act on, allow every http(s) URL, and recompute the flag for what the
    /// window is about to show.
    ///
    /// A REFUSED navigation leaves the flag alone deliberately — the page did
    /// not move, so neither should what it is trusted with.
    pub fn allow_navigation(&self, url: &Url) -> bool {
        if !browsable_scheme(url.scheme()) {
            return false;
        }
        self.evaluate(url);
        true
    }
}

/// The app's one instance.
static MAIN_TRUST: MainTrust = MainTrust::new();

/// The dashboard window's trust state.
pub fn window_state() -> &'static MainTrust {
    &MAIN_TRUST
}

/// Wrap the generated command handler in the trust guard.
///
/// **Uniform on every app command, not only the risky ones.** Six of `main`'s
/// seven reads are harmless individually — but a rule with exceptions is a rule
/// the next person has to re-derive from the exception list, and the ACL is
/// what decides WHICH commands this window has at all. Here we only decide
/// whether the page asking is one we point the window at.
///
/// It sits at the invoke handler rather than inside each command because that
/// is the one place the CALLING webview is known without changing a signature:
/// Tauri identifies the caller through an injected `Webview` argument, and
/// three of the seven are pinned to taking no argument at all precisely so they
/// cannot be aimed. Plugin commands do not pass through here (Tauri routes
/// `plugin:…` to `extend_api` first), so `core:window:allow-start-dragging`
/// keeps working on an untrusted page — a window nobody can move is a worse
/// outcome than one showing a page that can do nothing else.
pub fn guarding<R, F>(handler: F) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static
where
    R: tauri::Runtime,
    F: Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
{
    move |invoke| {
        let from_main = invoke.message.webview_ref().label() == MAIN;
        if from_main && !window_state().is_trusted() {
            // Named on stderr because the page's own console is the SPA's, and
            // a refusal nobody can see reads as an app that hangs.
            eprintln!(
                "subshell: refused {} — the dashboard window is on an untrusted address",
                invoke.message.command()
            );
            invoke.resolver.reject(REFUSAL);
            return true;
        }
        handler(invoke)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        raw.parse().expect("test url")
    }

    /// Loopback is trusted with no configured base at all — a machine that
    /// never set `APP_BASE_URL` behaves exactly as it did before § 15.
    #[test]
    fn loopback_is_trusted_on_any_port_without_a_base() {
        let trust = MainTrust::new();
        for raw in [
            "http://localhost:3080/",
            "http://127.0.0.1:3080/settings/service",
            "http://127.0.0.1:5174/",
        ] {
            assert!(trust.trusts(&url(raw), None), "{raw} must be trusted");
        }
    }

    /// The scope this replaced named `http://` loopback only, and `Probe::origin`
    /// builds nothing else — so widening to https here would trust an origin
    /// this app cannot produce.
    #[test]
    fn loopback_over_tls_is_not_the_loopback_this_app_points_at() {
        let trust = MainTrust::new();
        assert!(!trust.trusts(&url("https://localhost:3080/"), None));
        // Unless it IS the configured base, which is a different reason.
        assert!(trust.trusts(&url("https://localhost:3080/"), Some("https://localhost:3080")));
    }

    /// The second trusted origin, and only as an exact origin.
    #[test]
    fn the_configured_base_url_is_the_second_trusted_origin() {
        let trust = MainTrust::new();
        let base = Some("https://plane.example.com");
        assert!(trust.trusts(&url("https://plane.example.com/subshells"), base));
        // Scheme, port and host each make it a different server.
        assert!(!trust.trusts(&url("http://plane.example.com/"), base));
        assert!(!trust.trusts(&url("https://plane.example.com:8443/"), base));
        assert!(!trust.trusts(&url("https://plane.example.com.evil.test/"), base));
        assert!(!trust.trusts(&url("https://evil.test/"), base));
        // And without a base it is nobody: an instance that configured none
        // trusts loopback alone.
        assert!(!trust.trusts(&url("https://plane.example.com/"), None));
    }

    /// `open_main` refuses a THIRD origin — the app never points the window
    /// anywhere untrusted, which is what leaves "a page did it" as the only
    /// way to get there.
    #[test]
    fn a_third_origin_is_refused_however_it_is_spelled() {
        let trust = MainTrust::new();
        let base = Some("https://plane.example.com");
        for raw in [
            "https://idp.example.com/authorize?client_id=x",
            "http://192.168.1.44:3080/",
            "http://localhost.evil.test/",
            "file:///etc/passwd",
            "data:text/html,<script>fetch('/')</script>",
        ] {
            assert!(!trust.trusts(&url(raw), base), "{raw} must be refused");
        }
    }

    /// A base that is not an http(s) origin buys nothing: a hand-edited
    /// config.env can put anything in that field.
    #[test]
    fn an_unusable_base_trusts_nothing_extra() {
        let trust = MainTrust::new();
        for base in ["", "not a url", "file:///srv", "tailscale://plane", "3080"] {
            assert!(!trust.trusts(&url("https://plane.example.com/"), Some(base)), "{base}");
            // …and loopback is unaffected by it, which is what keeps a broken
            // value from locking the app out of its own server.
            assert!(trust.trusts(&url("http://127.0.0.1:3080/"), Some(base)), "{base}");
        }
    }

    /// The flag follows the page, in both directions, however many times.
    #[test]
    fn the_flag_is_recomputed_on_every_navigation() {
        let trust = MainTrust::new();
        trust.set_base(Some("https://plane.example.com".into()));
        assert!(!trust.is_trusted(), "nothing is trusted before a page loads");

        assert!(trust.allow_navigation(&url("https://plane.example.com/login")));
        assert!(trust.is_trusted());

        // The sign-in bounce: an identity provider on a third origin. The
        // window follows — that is the whole point of § 15 — and loses the
        // commands while it is there.
        assert!(trust.allow_navigation(&url("https://idp.example.com/authorize")));
        assert!(!trust.is_trusted());

        // And back, which is what makes a proxied sign-in work at all.
        assert!(trust.allow_navigation(&url("https://plane.example.com/api/auth/callback")));
        assert!(trust.is_trusted());
    }

    /// Non-http(s) is refused as a NAVIGATION, not merely distrusted: the
    /// window must not be steerable into anything the OS would act on.
    #[test]
    fn navigation_refuses_a_scheme_the_os_would_act_on() {
        let trust = MainTrust::new();
        trust.evaluate(&url("http://127.0.0.1:3080/"));
        assert!(trust.is_trusted());
        for raw in ["file:///etc/passwd", "tauri://localhost/", "mailto:someone@example.com"] {
            assert!(!trust.allow_navigation(&url(raw)), "{raw} must not be navigable");
        }
        // A refused navigation did not happen, so the page — and what it may
        // do — is exactly where it was.
        assert!(trust.is_trusted());
    }

    /// A destroyed window takes its trust with it.
    #[test]
    fn clearing_forgets_the_page_that_earned_it() {
        let trust = MainTrust::new();
        trust.evaluate(&url("http://localhost:3080/"));
        assert!(trust.is_trusted());
        trust.clear();
        assert!(!trust.is_trusted());
    }

    /// The base is live: a page trusted under one configuration is not trusted
    /// under the next.
    #[test]
    fn moving_the_configured_base_moves_what_is_trusted() {
        let trust = MainTrust::new();
        trust.set_base(Some("https://plane.example.com".into()));
        assert!(trust.evaluate(&url("https://plane.example.com/")));
        trust.set_base(Some("https://other.example.com".into()));
        assert!(!trust.evaluate(&url("https://plane.example.com/")));
        // Loopback survives every such change, which is how the app keeps a
        // way back to the server it manages.
        assert!(trust.evaluate(&url("http://127.0.0.1:3080/")));
    }
}
