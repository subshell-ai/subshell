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
//! - **The flag is set by a COMMITTED page load, never by a page and never by
//!   a request.** It is recomputed for every document the window commits to,
//!   so a redirect chain that ends somewhere else cannot leave it true — and a
//!   navigation that is merely ASKED FOR moves nothing, which is what stops an
//!   untrusted page arming all seven commands by aiming at a loopback port
//!   that will not answer.
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
    /// Whether a refusal has already been printed for the page now loaded.
    ///
    /// A refused page can call `invoke()` in a loop, and one line per call
    /// fills this app's stderr — which on Linux is the journal (review,
    /// 2026-09-18). So the line is worth printing once per page and worthless
    /// after that: it says which address is untrusted, and that does not
    /// change until something commits. Reset by [`MainTrust::evaluate`], i.e.
    /// by the next page.
    warned: AtomicBool,
}

impl MainTrust {
    pub const fn new() -> Self {
        Self {
            base: Mutex::new(None),
            trusted: AtomicBool::new(false),
            warned: AtomicBool::new(false),
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
        // A new page gets a new sentence; see `warned`.
        self.warned.store(false, Ordering::SeqCst);
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
        self.warned.store(false, Ordering::SeqCst);
    }

    /// Whether this refusal is the first since the page changed — and record
    /// that it has been made. See [`warned`](Self::warned).
    fn first_refusal(&self) -> bool {
        !self.warned.swap(true, Ordering::SeqCst)
    }

    /// The navigation handler's whole decision: refuse anything the OS would
    /// act on, allow every http(s) URL — and **touch the flag not at all**.
    ///
    /// **This handler runs at REQUEST time, which is why it may not arm
    /// anything** (found in review, 2026-09-18). It was calling `evaluate`
    /// here, and that was a privilege escalation with two spellings:
    ///
    /// - A page on an untrusted origin runs `location.href =
    ///   "http://127.0.0.1:1/"`. The scheme passes, the flag went TRUE, the
    ///   connection is refused and the document never changes — so the
    ///   attacker's page kept running with all seven commands armed, including
    ///   `desktop_set_supervision` and the reset screen.
    /// - wry calls this handler for SUBFRAME loads too, with no frame filter
    ///   on either backend (`wkwebview/navigation.rs`, `webkitgtk/mod.rs`), so
    ///   an `<iframe src="http://127.0.0.1:1/">` armed it without the top frame
    ///   moving at all.
    ///
    /// So arming belongs to [`MainTrust::committed`], which is driven by
    /// `PageLoadEvent::Started`. Verified in wry 0.55.1 that `Started` is
    /// raised from `didCommitNavigation:` on macOS and `LoadEvent::Committed`
    /// on GTK — both main-frame-only and both at COMMIT, which is exactly the
    /// two properties this handler lacks.
    ///
    /// **Clearing here was considered and rejected**, and the reason is
    /// sharper than "it would be inconvenient". Once the flag is written only
    /// at commit, it describes the document ON SCREEN exactly: between a
    /// request and its commit, what is loaded is still whatever committed
    /// last, and the flag still matches it. Clearing early would make the flag
    /// pessimistic about a page that legitimately earned it — disarming a
    /// trusted SPA the moment it loaded a third-party iframe, or for good if
    /// it asked for a URL that never arrived — and would buy nothing, since a
    /// navigation that fails cannot arm anything either.
    pub fn allow_navigation(&self, url: &Url) -> bool {
        browsable_scheme(url.scheme())
    }

    /// Recompute the flag for a page the window has actually COMMITTED to.
    ///
    /// The one arming path, and the reason the guard means anything: a
    /// document that is on screen is the one whose origin should decide what
    /// this window may do.
    pub fn committed(&self, url: &Url) {
        self.evaluate(url);
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
        let label = invoke.message.webview_ref().label().to_string();
        if refuses(&label, window_state().is_trusted()) {
            if window_state().first_refusal() {
                // Named on stderr because the page's own console is the SPA's,
                // and a refusal nobody can see reads as an app that hangs.
                // Once per page — see `MainTrust::warned`.
                eprintln!(
                    "subshell: refused {} — the dashboard window is on an untrusted address",
                    invoke.message.command()
                );
            }
            invoke.resolver.reject(REFUSAL);
            return true;
        }
        handler(invoke)
    }
}

/// The guard's whole decision, split out so it can be tested.
///
/// Building a real `Invoke` to exercise [`guarding`] is not worth it, but the
/// two properties that decide whether the guard fires at all — the label check
/// and the assistant's exemption — were pinned only by a string match in
/// `ipc-acl.test.ts` (review, 2026-09-18). They are a branch; a branch gets a
/// test.
fn refuses(label: &str, trusted: bool) -> bool {
    label == MAIN && !trusted
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        raw.parse().expect("test url")
    }

    /// The guard fires for the dashboard window and for nothing else. The
    /// assistant is a bundled page this repo ships and is the surface that
    /// repairs a machine whose server is unreachable — refusing it because the
    /// OTHER window wandered onto a sign-in page would be a new way to strand
    /// someone.
    #[test]
    fn only_the_dashboard_window_is_guarded_and_only_while_untrusted() {
        assert!(refuses(MAIN, false), "an untrusted dashboard page is refused");
        assert!(!refuses(MAIN, true), "a trusted dashboard page is not");
        assert!(!refuses("wizard", false), "the assistant is never subject to the flag");
        assert!(!refuses("wizard", true));
    }

    /// One line per PAGE, not one per call: a refused page can loop `invoke()`,
    /// and on Linux this app's stderr is the journal.
    #[test]
    fn a_refused_page_is_named_once_and_the_next_page_is_named_again() {
        let trust = MainTrust::new();
        assert!(trust.first_refusal(), "the first refusal prints");
        assert!(!trust.first_refusal(), "a second one for the same page does not");
        assert!(!trust.first_refusal());

        trust.evaluate(&url("http://127.0.0.1:3080/"));
        assert!(trust.first_refusal(), "a new page earns a new sentence");

        trust.clear();
        assert!(trust.first_refusal(), "and so does a window that went away");
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
    fn the_flag_follows_the_page_the_window_committed_to() {
        let trust = MainTrust::new();
        trust.set_base(Some("https://plane.example.com".into()));
        assert!(!trust.is_trusted(), "nothing is trusted before a page loads");

        trust.committed(&url("https://plane.example.com/login"));
        assert!(trust.is_trusted());

        // The sign-in bounce: an identity provider on a third origin. The
        // window follows — that is the whole point of § 15 — and loses the
        // commands while it is there.
        trust.committed(&url("https://idp.example.com/authorize"));
        assert!(!trust.is_trusted());

        // And back, which is what makes a proxied sign-in work at all.
        trust.committed(&url("https://plane.example.com/api/auth/callback"));
        assert!(trust.is_trusted());
    }

    /// **A navigation that is merely REQUESTED arms nothing** — the escalation
    /// this guard shipped with for one commit (review, 2026-09-18).
    ///
    /// A page on an untrusted origin sets `location.href` to a loopback URL
    /// that cannot connect. The scheme passes, so the navigation is allowed;
    /// the load then fails and the document never changes. While the flag was
    /// written here, that page kept running with all seven commands armed.
    /// Only a COMMIT may arm, and a failed load produces none.
    #[test]
    fn an_allowed_navigation_that_never_commits_arms_nothing() {
        let trust = MainTrust::new();
        trust.set_base(Some("https://plane.example.com".into()));
        trust.committed(&url("https://evil.example.com/"));
        assert!(!trust.is_trusted());

        // The attack: aim at something trusted, never arrive.
        assert!(trust.allow_navigation(&url("http://127.0.0.1:1/")));
        assert!(
            !trust.is_trusted(),
            "a navigation request must not arm the guard; only a committed load may"
        );
    }

    /// The other spelling of the same defect: wry calls the navigation handler
    /// for SUBFRAME loads with no frame filter on either backend, so an
    /// `<iframe src="http://127.0.0.1:1/">` armed it without the top frame
    /// moving. It must also not DISARM a legitimate page that embeds a
    /// third-party frame, which is why the handler writes nothing at all.
    #[test]
    fn a_subframe_navigation_neither_arms_nor_disarms() {
        let trust = MainTrust::new();
        trust.set_base(Some("https://plane.example.com".into()));
        trust.committed(&url("https://plane.example.com/"));

        assert!(trust.allow_navigation(&url("http://127.0.0.1:1/")));
        assert!(
            trust.is_trusted(),
            "an embedded frame does not disarm the page around it"
        );

        assert!(trust.allow_navigation(&url("https://ads.example.com/frame")));
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
