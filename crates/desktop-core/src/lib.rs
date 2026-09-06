//! Plumbing shared by the Subshell desktop apps.
//!
//! There are two Tauri apps in this repo — `apps/desktop-server`, which manages
//! a `subshell-server`, and `apps/desktop-client`, which manages a `subshell`
//! node agent. They are different products with different windows, different
//! commands and different CLIs, but underneath both is the same short list of
//! things a GUI has to get right before it can drive a binary at all. Every
//! module here was written once, for the server app, and every one of them
//! encodes a bug that was MEASURED rather than imagined:
//!
//! - [`proc`] — two pipe deadlocks, in opposite directions.
//! - [`shell_env`] — the PATH a `.app` does not inherit, and the unbounded
//!   login-shell probe that discovers it.
//! - [`version`] — comparing versions numerically instead of lexically.
//! - [`settings`] — one JSON file, and the file-location parameter that keeps
//!   two apps from sharing (or clobbering) each other's settings.
//! - [`sidecar`] — installing a shipped binary over one that may be running,
//!   quarantined, or half-written when the power goes.
//!
//! **This crate does not depend on `tauri`, and must not start.** That is the
//! whole point of the boundary: it keeps the shared half a thirty-second CI
//! job, and it keeps these tests runnable with no webview, no display server
//! and none of Tauri's system dependencies — which is what makes them the kind
//! of test anyone actually runs before pushing.
//!
//! ## What belongs here
//!
//! Logic that is true of BOTH apps and can be stated without a `tauri` type:
//! process handling, environment discovery, file layout, parsing. A module
//! that needs an `AppHandle`, a `WebviewWindow`, a window label or a command
//! name belongs in the app.
//!
//! ## What deliberately does not
//!
//! `control.rs`, `windows.rs`, `tray.rs`, `menu.rs` and `bridge.rs` stay in
//! each app, duplication and all. They are `tauri`-typed and label-driven, and
//! the two apps' window models are genuinely different — an abstraction
//! designed against one real consumer and one guess costs more than the
//! duplication it removes. `server_bin.rs` likewise stays in
//! `apps/desktop-server`: a resolution ladder for `subshell-server`
//! specifically, down to the unit file it reads and the plist it parses.
//!
//! ## What is parameterized, and why not more
//!
//! [`settings::SettingsPaths`] and [`sidecar::SidecarSpec`] carry the two
//! apps' identities: a bundle id, a directory, a bundled binary's name, an
//! installed binary's name, the prefix its `version` line starts with. They
//! are parameters rather than constants because the FILE PATHS are what a
//! shipped app's users have on disk — an app that starts reading a different
//! settings file has silently forgotten every preference they set.

pub mod proc;
pub mod settings;
pub mod shell_env;
pub mod sidecar;
pub mod version;
