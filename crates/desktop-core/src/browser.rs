//! "Open in browser": turning a page-supplied PATH into a URL this app is
//! willing to hand to the system browser.
//!
//! Both desktop apps grow one command that a REMOTE page may invoke —
//! `desktop_open_in_browser` — and the whole of its safety is that the page
//! names a path and never a host. The origin comes from the window the page is
//! already in (the server app's loopback origin, the client's pinned plane),
//! so the worst a compromised page can do is open a page of the plane the
//! person is already looking at, in their own browser.
//!
//! That promise is only as good as the join, which is why the join lives here
//! rather than twice in two apps. Three refusals carry it, and each has a
//! concrete attack behind it:
//!
//! - **`//evil.test` is not a path.** Resolved against an origin it is a
//!   PROTOCOL-RELATIVE URL, and the opener would dial another host under this
//!   app's name. It is the single most likely thing to be tried here.
//! - **A backslash is not a separator we accept.** The WHATWG URL parser
//!   treats `\` as `/` for special schemes, so `/\evil.test` is `//evil.test`
//!   spelled differently — and a check that only looked for `//` would wave it
//!   through. Refusing the character outright is the only rule that does not
//!   have to model someone else's parser.
//! - **No scheme, no whitespace, no control characters.** `http://…` is a host
//!   the page chose; whitespace and C0/C1 bytes are how a URL is smuggled past
//!   a naive check (a stripped tab, a `%0A` that was never encoded) and are
//!   never legitimate in a path an SPA router produced.
//!
//! Everything else — which origin, whether a window exists — is the app's, and
//! is deliberately not modelled here: this crate does not depend on `tauri`.

/// Join a page-supplied path onto an origin this app chose, or refuse it.
///
/// `origin` is a scheme-plus-authority string the CALLER derived (a window's
/// own `url().origin()`, a pin, a probe) — never anything the page sent.
/// `path` is the page's, and is checked against the rules in the module note.
///
/// The returned string is `origin` with `path` appended verbatim: the path is
/// accepted as-is or refused, never rewritten, because a "sanitizing" join is
/// a second parser to disagree with the browser's.
///
/// ```
/// use subshell_desktop_core::browser::browser_url;
/// assert_eq!(
///     browser_url("http://127.0.0.1:3080", "/subshells/abc?tab=log").unwrap(),
///     "http://127.0.0.1:3080/subshells/abc?tab=log"
/// );
/// assert!(browser_url("http://127.0.0.1:3080", "//evil.test").is_err());
/// ```
pub fn browser_url(origin: &str, path: &str) -> Result<String, String> {
    let origin = origin.trim_end_matches('/');
    if origin.is_empty() {
        return Err("this window has no address to open in a browser yet".to_string());
    }
    validate_path(path)?;
    Ok(format!("{origin}{path}"))
}

/// The path rules, on their own so the refusals are testable one at a time.
///
/// The message is what a person reads, so each names the rule rather than
/// echoing the input — a refused path is either a bug in our own page or
/// something we would rather not quote back into a dialog.
pub fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("no page to open".to_string());
    }
    if !path.starts_with('/') {
        return Err("only a path on this server can be opened in a browser".to_string());
    }
    // Protocol-relative: `//host/x` resolves to another HOST, not another page.
    if path.starts_with("//") {
        return Err("only a path on this server can be opened in a browser".to_string());
    }
    if path.contains("://") {
        return Err("only a path on this server can be opened in a browser".to_string());
    }
    // See the module note: `\` is `/` to the URL parser, so this is the `//`
    // rule again in a spelling no substring check would catch.
    if path.contains('\\') {
        return Err("that page address is not one this app can open".to_string());
    }
    if path.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("that page address is not one this app can open".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "http://127.0.0.1:3080";

    #[test]
    fn joins_an_ordinary_path_onto_the_origin() {
        assert_eq!(browser_url(ORIGIN, "/").unwrap(), "http://127.0.0.1:3080/");
        assert_eq!(
            browser_url(ORIGIN, "/subshells/9f3c-42").unwrap(),
            "http://127.0.0.1:3080/subshells/9f3c-42"
        );
        // A query string is part of the current route and rides along.
        assert_eq!(
            browser_url(ORIGIN, "/workspaces/1?pane=2&view=list").unwrap(),
            "http://127.0.0.1:3080/workspaces/1?pane=2&view=list"
        );
    }

    // The scheme and the PORT are the two halves of the origin that a naive
    // join (host only, default port) would drop — and dropping either sends
    // the browser to a server that is not this one.
    #[test]
    fn the_origins_scheme_and_port_survive_the_join() {
        assert_eq!(
            browser_url("https://plane.example.com:8443", "/nodes").unwrap(),
            "https://plane.example.com:8443/nodes"
        );
        assert!(browser_url("https://plane.example.com:8443", "/nodes")
            .unwrap()
            .starts_with("https://"));
        assert_eq!(
            browser_url("http://localhost:5174", "/settings/service").unwrap(),
            "http://localhost:5174/settings/service"
        );
        // A trailing slash on the origin does not produce `//` in the result,
        // which would be a protocol-relative URL built by US.
        assert_eq!(
            browser_url("http://localhost:3080/", "/nodes").unwrap(),
            "http://localhost:3080/nodes"
        );
    }

    #[test]
    fn refuses_a_protocol_relative_path() {
        for path in ["//evil.test", "//evil.test/subshells", "///evil.test"] {
            assert!(browser_url(ORIGIN, path).is_err(), "{path}");
        }
    }

    #[test]
    fn refuses_anything_carrying_a_scheme() {
        for path in [
            "http://evil.test",
            "https://evil.test/x",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "/redirect?to=http://evil.test",
        ] {
            assert!(browser_url(ORIGIN, path).is_err(), "{path}");
        }
    }

    // `\` is `/` to the WHATWG parser for special schemes, so this is the
    // protocol-relative case wearing a different hat.
    #[test]
    fn refuses_backslashes() {
        for path in ["/\\evil.test", "\\\\evil.test", "/subshells\\..\\x"] {
            assert!(browser_url(ORIGIN, path).is_err(), "{path:?}");
        }
    }

    #[test]
    fn refuses_whitespace_and_control_characters() {
        for path in [
            "/a b",
            "/a\tb",
            "/a\nb",
            "/a\r\nHost: evil.test",
            "/a\u{0000}b",
            "/a\u{007f}b",
        ] {
            assert!(browser_url(ORIGIN, path).is_err(), "{path:?}");
        }
    }

    #[test]
    fn refuses_an_empty_or_relative_path() {
        assert!(browser_url(ORIGIN, "").is_err());
        assert!(browser_url(ORIGIN, "subshells").is_err());
        assert!(browser_url(ORIGIN, "../etc").is_err());
    }

    // The origin is the app's, but an app with no window and no probe has
    // none — and an empty one would build a schemeless string the opener
    // would resolve against nothing.
    #[test]
    fn refuses_an_empty_origin() {
        assert!(browser_url("", "/").is_err());
        assert!(browser_url("/", "/").is_err());
    }
}
