//! The staging script's own tests.
//!
//! `native/display-helper/build_support.rs` is included only by the two apps'
//! `build.rs`, and `cargo test` never builds build scripts as test targets, so
//! without this shim its content-gating checks (the fingerprint, and
//! write-only-if-different) would compile nothing and run nowhere. The
//! `build()` body reads `OUT_DIR` and shells out to `xcrun`, which is fine: it
//! is never called here, only the pure helpers are.
#![allow(dead_code)]

#[path = "../../../../../native/display-helper/build_support.rs"]
mod build_support;
