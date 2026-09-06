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
}
