//! Version comparison, mirroring `semverLt` in
//! `packages/subshell-protocol/src/versions.ts`.
//!
//! Deliberately a re-implementation rather than a shell-out: the desktop app
//! compares versions on its cold-start path, before anything is known to be
//! runnable, and the rule is four lines. Suffixes are ignored on both sides so
//! a `-canary` build of a version is never older than that version.

/// Numeric prefix of a dotted version, e.g. `1.8.0-rc1` -> `[1, 8, 0]`.
fn parts(v: &str) -> Vec<u64> {
    v.split(|c: char| !c.is_ascii_digit() && c != '.')
        .next()
        .unwrap_or("")
        .split('.')
        .filter(|s| !s.is_empty())
        .map(|s| s.parse::<u64>().unwrap_or(0))
        .collect()
}

/// True when `a` is strictly older than `b`.
pub fn version_lt(a: &str, b: &str) -> bool {
    let (av, bv) = (parts(a), parts(b));
    for i in 0..av.len().max(bv.len()) {
        let (x, y) = (av.get(i).copied().unwrap_or(0), bv.get(i).copied().unwrap_or(0));
        if x != y {
            return x < y;
        }
    }
    false
}

/// The one rule behind every rendering of a STORED update notice: it may name
/// only a version strictly newer than what is running.
///
/// `last_update_version` is what the last answering check found, and the answer
/// goes stale the moment the person installs what was announced. Each app's
/// install clears the field, but a HAND replacement of the bundle does not, and
/// an app that updated itself across a crash between the write and the clear
/// will not answer the release source again for a day. So every site that
/// paints the stored value without consulting the source — the tray seed, the
/// launch check's not-due branch, the unanswered-check branch, and the server
/// app's SPA-facing status view — routes through here, and
/// "Update available — 0.8.0" can never be shown BY 0.8.0.
///
/// Shared rather than copied per app (2026-09-18): it was the server app's
/// alone, added by review on 2026-09-17, and Subshell Client shipped the defect
/// it closes for a day. `version_lt` ignores suffixes on both sides, so a
/// canary of the announced version counts as installed — the same rule every
/// other comparison here uses.
///
/// @param current - The version this app is running
/// @param stored - What the last answering check recorded, if any
/// @returns The version to announce, or `None` when there is nothing to say
pub fn notice_for(current: &str, stored: Option<&str>) -> Option<String> {
    stored
        .filter(|version| version_lt(current, version))
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_numerically_not_lexically() {
        assert!(version_lt("1.9.0", "1.10.0"));
        assert!(!version_lt("1.10.0", "1.9.0"));
    }

    #[test]
    fn equal_versions_are_not_older() {
        assert!(!version_lt("1.8.0", "1.8.0"));
    }

    #[test]
    fn missing_components_read_as_zero() {
        assert!(version_lt("1.8", "1.8.1"));
        assert!(!version_lt("1.8.0", "1.8"));
    }

    // A prerelease of the required version satisfies the requirement — the
    // same rule `semverLt` encodes on the TypeScript side.
    #[test]
    fn suffixes_are_ignored() {
        assert!(!version_lt("1.8.0-canary.3", "1.8.0"));
        assert!(version_lt("1.7.9-canary.3", "1.8.0"));
    }

    #[test]
    fn unparseable_reads_as_zero() {
        assert!(version_lt("", "0.0.1"));
        assert!(version_lt("not-a-version", "0.0.1"));
    }

    /// A stored version this app now IS is not a notice. The shape the server
    /// app's review found on 2026-09-17, and the one Subshell Client shipped
    /// until this moved here.
    #[test]
    fn a_stored_version_we_already_run_is_no_notice() {
        assert_eq!(notice_for("0.8.0", Some("0.9.0")), Some("0.9.0".to_string()));
        assert_eq!(notice_for("0.9.0", Some("0.9.0")), None);
        assert_eq!(notice_for("0.10.0", Some("0.9.0")), None);
        assert_eq!(notice_for("0.9.0", None), None);
        // Suffixes are ignored on both sides, as everywhere else here: a
        // canary of the announced version counts as installed.
        assert_eq!(notice_for("0.9.0-canary.1", Some("0.9.0")), None);
    }
}
