//! Ownership and licensing, as the two desktop apps state them to a user.
//!
//! The Rust half of `packages/subshell-protocol/src/legal.ts`. Two runtimes
//! cannot share one constant, so these are duplicated on purpose and
//! `scripts/license-fields.ts` asserts that this file, the TypeScript one and
//! the root `LICENSE` all agree — a detector rather than a convention, because
//! a copyright line that drifts is invisible until someone reads an About box.
//!
//! Deliberately NOT `env!("CARGO_PKG_LICENSE")`: that answers what *this
//! crate* is (Apache-2.0 for desktop-core, AGPL for the server app), which is
//! the packaging fact. An About dialog has to describe the whole product.

/// The entity that owns the copyright. The registered name, not the DBA.
pub const COPYRIGHT_HOLDER: &str = "Disaresta, LLC";

/// Year of the copyright notice, matching the root `LICENSE`.
pub const COPYRIGHT_YEAR: &str = "2026";

/// The notice as it is rendered, e.g. `Copyright 2026 Disaresta, LLC`.
pub const COPYRIGHT_LINE: &str = "Copyright 2026 Disaresta, LLC";

/// One line naming both halves of the split, and which is which.
pub const LICENSE_SUMMARY: &str = "AGPL-3.0-only (control plane), Apache-2.0 elsewhere";

/// Where the full text lives.
pub const LICENSE_URL: &str = "https://github.com/subshell-ai/subshell/blob/main/LICENSE";

/// The copyright holder's own site.
pub const COMPANY_URL: &str = "https://disaresta.com";

/// The product name as it is presented to a user.
pub const PRODUCT_NAME: &str = "Subshell";

#[cfg(test)]
mod tests {
    use super::*;

    /// `COPYRIGHT_LINE` is written out rather than `format!`ed (a `const` cannot
    /// call `format!`), so this is the only thing keeping it consistent with the
    /// two parts it is built from.
    #[test]
    fn copyright_line_is_composed_of_its_parts() {
        assert_eq!(COPYRIGHT_LINE, format!("Copyright {COPYRIGHT_YEAR} {COPYRIGHT_HOLDER}"));
    }
}
