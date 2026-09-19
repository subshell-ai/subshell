//! Which release of this app is the newest one, read from the same list every
//! other component reads (spec 2026-09-15 § 3.1, § 7.2).
//!
//! The Rust half of `packages/subshell-protocol/src/releases.ts`, and only the
//! part two desktop apps need: the endpoint, the tag parse, and the pick. The
//! server and the node agent resolve the same list in TypeScript; these apps
//! cannot, because the whole point of an app update is that it works with no
//! server on the machine at all.
//!
//! **The endpoint is the LIST, never `/releases/latest`.** This repository cuts
//! four app components plus a release per npm package, so "latest" is very
//! often not the component a caller wants — measured 2026-09-15, `server-v0.6.0`
//! beat `node-v0.8.0` by seconds. The caller filters by tag prefix instead, and
//! `per_page=100` is what stops one version PR's eleven releases from pushing a
//! whole component off the first page.
//!
//! **The pick is by SEMVER, never by date or by the order the API returned.** A
//! re-cut of an older version publishes later than a newer one, and a
//! date-ordered pick would then hand every installed app a downgrade.
//!
//! What this module does NOT do is fetch. That stays in each app's
//! `app_update.rs`, with the `tauri` types and the updater plugin, because this
//! crate has no HTTP client and is not going to grow one for a parse.

use serde::Deserialize;

use crate::version::version_lt;

/// The repository these releases are published from.
pub const SUBSHELL_REPO_SLUG: &str = "subshell-ai/subshell";

/// The releases endpoint, mirroring `DEFAULT_RELEASE_API` in
/// `packages/subshell-protocol/src/releases.ts`.
///
/// Held equal to it by a test that READS that file, so the two cannot drift:
/// a mirrored constant nothing compares is a second source of truth.
pub const RELEASE_API: &str = "https://api.github.com/repos/subshell-ai/subshell/releases?per_page=100";

/// The env var that repoints (or disables) the release source.
///
/// The same name and the same semantics the server uses: a value replaces the
/// endpoint, and an EMPTY value is the air-gapped configuration — no update
/// check happens at all, rather than one against a default the operator
/// deliberately cleared.
pub const RELEASE_URL_ENV: &str = "SUBSHELL_RELEASE_URL";

/// Where this app reads its release list from, or `None` when the operator has
/// turned the source off.
pub fn release_api(from_env: Option<String>) -> Option<String> {
    match from_env {
        None => Some(RELEASE_API.to_string()),
        Some(value) if value.trim().is_empty() => None,
        Some(value) => Some(value.trim().to_string()),
    }
}

/// One row of the releases list, reduced to what choosing between them needs.
///
/// `#[serde(default)]` on `draft` rather than a required field: a static mirror
/// of this JSON (the `downloads.subshell.sh` the design leaves room for) has no
/// reason to carry it, and an absent flag means "published".
#[derive(Debug, Clone, Deserialize)]
pub struct ReleaseRow {
    pub tag_name: String,
    #[serde(default)]
    pub draft: bool,
}

/// One release, reduced to what the updater needs to point at it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleasePick {
    pub tag: String,
    pub version: String,
}

/// The version inside a `<component>-vX.Y.Z` tag, or `None` for any other tag.
///
/// Three numeric parts, nothing else — the same rule `parseReleaseTag` states
/// in TypeScript. A prerelease or build-metadata suffix is deliberately NOT
/// accepted: an updater would then hand a machine a build the release pipeline
/// does not smoke-test the same way.
pub fn parse_release_tag(prefix: &str, tag: &str) -> Option<String> {
    let version = tag.strip_prefix(prefix)?;
    let mut parts = version.split('.');
    let ok = (0..3).all(|_| {
        parts
            .next()
            .is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    });
    (ok && parts.next().is_none()).then(|| version.to_string())
}

/// The newest published release carrying `prefix`, by semver.
///
/// Drafts are skipped: a draft's assets are not downloadable by an anonymous
/// client, so offering one is offering an update that cannot be fetched.
///
/// Tags belonging to another component are ignored even when they would parse
/// as a newer version. Since the 2026-09-18 rename every prefix reads
/// `<form>-<role>-v`, so no prefix is another's prefix or suffix and a plain
/// `starts_with` is exact.
pub fn newest_release(prefix: &str, rows: &[ReleaseRow]) -> Option<ReleasePick> {
    let mut best: Option<ReleasePick> = None;
    for row in rows.iter().filter(|r| !r.draft) {
        let Some(version) = parse_release_tag(prefix, &row.tag_name) else {
            continue;
        };
        if best.as_ref().is_none_or(|b| version_lt(&b.version, &version)) {
            best = Some(ReleasePick {
                tag: row.tag_name.clone(),
                version,
            });
        }
    }
    best
}

/// Parse a release-list response body.
///
/// Its own function rather than a `response.json()` at each call site, so both
/// apps read the same shape and both tolerate the same extra fields: the
/// GitHub API answers with dozens per release, and a strict struct would break
/// the day one is renamed. Everything but `tag_name` and `draft` is ignored.
pub fn release_feed_rows_from(body: &str) -> Result<Vec<ReleaseRow>, String> {
    serde_json::from_str(body).map_err(|e| e.to_string())
}

/// How long a launch-time update check is good for (spec 2026-09-15 § 7.2:
/// "each app checks once if the last check is older than 24 h").
pub const UPDATE_CHECK_INTERVAL_SECS: u64 = 24 * 60 * 60;

/// Now, as whole seconds since the Unix epoch.
pub fn now_epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Whether a launch should ask the release source.
///
/// A timestamp that cannot be parsed counts as "never", which is the SAFE
/// direction here: the cost of an extra check is one anonymous GET, and the
/// cost of treating a hand-edited or future-dated value as current is an app
/// that never learns about an update again.
pub fn due_for_check(last: Option<&str>, now: u64) -> bool {
    match last.and_then(parse_rfc3339) {
        None => true,
        // A stamp in the future (a clock that was wrong, or one that moved
        // back) must not park the check forever, so the comparison is on the
        // absolute distance rather than on `now - last`.
        Some(then) => now.abs_diff(then) >= UPDATE_CHECK_INTERVAL_SECS,
    }
}

/// `YYYY-MM-DDTHH:MM:SSZ` — the one spelling this crate writes and reads.
///
/// Hand-rolled rather than a `chrono`/`time` dependency: this crate exists to
/// be a thirty-second CI job with no `tauri` and nothing heavy in it, and the
/// need is one UTC timestamp in one file. The civil-date conversion is Howard
/// Hinnant's `days_from_civil` / `civil_from_days`, valid for any year this
/// software will see.
pub fn format_rfc3339(epoch_secs: u64) -> String {
    let days = (epoch_secs / 86_400) as i64;
    let rem = epoch_secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Epoch seconds out of an RFC 3339 UTC timestamp, or `None`.
///
/// Deliberately narrow: `Z` only, no offsets, no fractional seconds. It reads
/// exactly what {@link format_rfc3339} writes, and anything else is treated as
/// "never checked" rather than guessed at.
pub fn parse_rfc3339(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    if bytes.len() != 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    if bytes[13] != b':' || bytes[16] != b':' || bytes[19] != b'Z' {
        return None;
    }
    let num = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, s) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    let days = days_from_civil(y, mo as u32, d as u32);
    u64::try_from(days * 86_400 + h * 3600 + mi * 60 + s).ok()
}

/// Days since 1970-01-01 for a civil date (Hinnant).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = i64::from((m + 9) % 12);
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The inverse of {@link days_from_civil} (Hinnant).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// The updater manifest's URL for a tag.
///
/// Knowable before the release exists, which is what lets the release script
/// write the manifest's own download URLs in: the tag and every asset name are
/// chosen by this repository (`desktopArtifactFileName`), not by the bundler.
pub fn latest_manifest_url(tag: &str) -> String {
    format!("https://github.com/{SUBSHELL_REPO_SLUG}/releases/download/{tag}/latest.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The TypeScript this module mirrors, read at compile time.
    ///
    /// `include_str!` rather than a copied string, the same containment
    /// `apps/server/desktop/src-tauri/src/reset.rs` uses to pin the tmux socket
    /// prefix across the two languages. A mirrored constant that nothing
    /// compares is a second source of truth, and this one decides where every
    /// installed app looks for its own updates.
    const RELEASES_TS: &str = include_str!("../../../packages/subshell-protocol/src/releases.ts");

    #[test]
    fn the_endpoint_is_the_one_the_protocol_package_defines() {
        // `export const SUBSHELL_REPO_SLUG = "subshell-ai/subshell";`
        let slug = RELEASES_TS
            .split("export const SUBSHELL_REPO_SLUG = \"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .expect("SUBSHELL_REPO_SLUG in releases.ts");
        assert_eq!(slug, SUBSHELL_REPO_SLUG);

        // `export const DEFAULT_RELEASE_API = `https://…/${SUBSHELL_REPO_SLUG}/releases?per_page=100`;`
        let template = RELEASES_TS
            .split("export const DEFAULT_RELEASE_API = `")
            .nth(1)
            .and_then(|rest| rest.split('`').next())
            .expect("DEFAULT_RELEASE_API in releases.ts");
        assert_eq!(template.replace("${SUBSHELL_REPO_SLUG}", slug), RELEASE_API);
    }

    // The env var is the one seam, and an EMPTY value is the air-gapped
    // configuration rather than a fall-back to the default. Reading it as
    // "unset" would make a deliberately cleared source reach out anyway.
    #[test]
    fn an_empty_override_turns_the_source_off() {
        assert_eq!(release_api(None).as_deref(), Some(RELEASE_API));
        assert_eq!(release_api(Some("  ".into())), None);
        assert_eq!(release_api(Some(String::new())), None);
        assert_eq!(
            release_api(Some(" https://mirror.example/releases ".into())).as_deref(),
            Some("https://mirror.example/releases")
        );
    }

    #[test]
    fn a_tag_is_three_numeric_parts_and_nothing_else() {
        assert_eq!(
            parse_release_tag("desktop-server-v", "desktop-server-v1.2.3"),
            Some("1.2.3".into())
        );
        assert_eq!(parse_release_tag("desktop-server-v", "desktop-server-v1.2"), None);
        assert_eq!(parse_release_tag("desktop-server-v", "desktop-server-v1.2.3.4"), None);
        assert_eq!(parse_release_tag("desktop-server-v", "desktop-server-v1.2.3-rc1"), None);
        assert_eq!(parse_release_tag("desktop-server-v", "desktop-server-v"), None);
        assert_eq!(parse_release_tag("desktop-server-v", "cli-server-v1.2.3"), None);
    }

    fn row(tag: &str, draft: bool) -> ReleaseRow {
        ReleaseRow {
            tag_name: tag.into(),
            draft,
        }
    }

    // Every component's tags land on one Releases page, so a picker that
    // matched loosely would hand a desktop app a CLI release.
    #[test]
    fn another_components_tag_is_never_picked() {
        let rows = [
            row("cli-server-v9.0.0", false),
            row("cli-node-v9.0.0", false),
            row("desktop-client-v9.0.0", false),
            row("desktop-server-v1.2.3", false),
        ];
        let pick = newest_release("desktop-server-v", &rows).expect("a pick");
        assert_eq!(pick.tag, "desktop-server-v1.2.3");
        assert_eq!(pick.version, "1.2.3");
        assert_eq!(newest_release("desktop-client-v", &rows).unwrap().version, "9.0.0");
    }

    // By SEMVER, not by the list's order and not by date: a re-cut of an older
    // version publishes LAST, and picking it would hand every machine a
    // downgrade the updater would then refuse — which reads as "no updates".
    #[test]
    fn the_newest_is_by_semver_not_by_position() {
        let rows = [
            row("desktop-server-v1.9.0", false),
            row("desktop-server-v1.10.0", false),
            row("desktop-server-v1.2.0", false),
        ];
        assert_eq!(newest_release("desktop-server-v", &rows).unwrap().version, "1.10.0");
    }

    // A draft's assets 404 for an anonymous client, so offering one is
    // offering an update that cannot be downloaded.
    #[test]
    fn drafts_are_skipped() {
        let rows = [row("desktop-server-v2.0.0", true), row("desktop-server-v1.0.0", false)];
        assert_eq!(newest_release("desktop-server-v", &rows).unwrap().version, "1.0.0");
        assert_eq!(
            newest_release("desktop-server-v", &[row("desktop-server-v2.0.0", true)]),
            None
        );
    }

    #[test]
    fn nothing_published_is_no_pick() {
        assert_eq!(newest_release("desktop-server-v", &[]), None);
        assert_eq!(newest_release("desktop-server-v", &[row("v1.0.0", false)]), None);
    }

    // The GitHub API answers with dozens of fields per release. A strict
    // struct would break the day one is renamed, for a reader that wants two.
    #[test]
    fn a_real_release_list_parses_and_extra_fields_are_ignored() {
        let body = r#"[
          {"id": 1, "tag_name": "desktop-server-v1.2.3", "draft": false, "prerelease": false,
           "html_url": "https://github.com/x", "assets": [{"name": "latest.json"}]},
          {"id": 2, "tag_name": "cli-server-v9.9.9", "draft": false}
        ]"#;
        let rows = release_feed_rows_from(body).expect("rows");
        assert_eq!(rows.len(), 2);
        assert_eq!(newest_release("desktop-server-v", &rows).unwrap().version, "1.2.3");
    }

    // A source that answers HTML (a login page, a proxy) must be a refusal the
    // caller can print, not a panic and not an empty list read as "no updates".
    #[test]
    fn a_non_list_answer_is_an_error() {
        assert!(release_feed_rows_from("<html>nope</html>").is_err());
        assert!(release_feed_rows_from("").is_err());
        assert_eq!(release_feed_rows_from("[]").unwrap().len(), 0);
    }

    // The round trip is the whole of the schedule's correctness: the timestamp
    // is written by one launch and read by the next, possibly months later.
    #[test]
    fn timestamps_round_trip_through_the_file() {
        for epoch in [0_u64, 1_000_000_000, 1_789_430_400, 4_102_444_800] {
            let text = format_rfc3339(epoch);
            assert_eq!(parse_rfc3339(&text), Some(epoch), "{text}");
        }
        assert_eq!(format_rfc3339(1_789_430_400), "2026-09-15T00:00:00Z");
    }

    // Narrow on purpose: anything this crate did not write is "never checked",
    // which costs one extra GET and never costs a missed update.
    #[test]
    fn anything_else_is_not_a_timestamp() {
        for bad in [
            "",
            "2026-09-15",
            "2026-09-15T00:00:00",
            "2026-09-15T00:00:00.5Z",
            "2026-09-15T00:00:00+01:00",
            "2026-13-15T00:00:00Z",
            "2026-09-15T24:00:00Z",
            "not-a-time-at-allZ",
        ] {
            assert_eq!(parse_rfc3339(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_check_is_due_once_a_day_and_always_when_there_is_none() {
        let now = 1_789_430_400_u64;
        assert!(due_for_check(None, now));
        assert!(due_for_check(Some("nonsense"), now));
        assert!(!due_for_check(Some(&format_rfc3339(now - 60)), now));
        assert!(!due_for_check(
            Some(&format_rfc3339(now - UPDATE_CHECK_INTERVAL_SECS + 1)),
            now
        ));
        assert!(due_for_check(
            Some(&format_rfc3339(now - UPDATE_CHECK_INTERVAL_SECS)),
            now
        ));
    }

    // A clock that was wrong — or one that moved back — must not park the
    // check forever, which is what a plain `now - last` would do.
    #[test]
    fn a_future_stamp_does_not_disable_the_check() {
        let now = 1_789_430_400_u64;
        assert!(due_for_check(
            Some(&format_rfc3339(now + UPDATE_CHECK_INTERVAL_SECS * 30)),
            now
        ));
    }

    // The manifest URL is built from the tag, which this repository chooses —
    // that is what lets the release script write the manifest before the
    // release exists.
    #[test]
    fn the_manifest_url_names_the_tag() {
        assert_eq!(
            latest_manifest_url("desktop-server-v1.2.3"),
            "https://github.com/subshell-ai/subshell/releases/download/desktop-server-v1.2.3/latest.json"
        );
    }
}
