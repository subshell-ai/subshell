//! What macOS has, and has not, allowed this app to do.
//!
//! A first run on a Mac produces system prompts the app does not control and,
//! once declined, cannot re-raise: macOS asks about notifications exactly
//! once, and a declined app then goes quiet with nothing in the product saying
//! why. This module is the READ that makes that state sayable — plus the two
//! requests the app owns, notifications and Photos — so a screen can explain
//! what is about to be asked and a dashboard can explain why something did not
//! happen.
//!
//! It lives here rather than in either app's `control.rs` for the crate's own
//! rule: Subshell Client posts no notifications today, and the day it does,
//! this is the half it adopts (spec 2026-09-14 § 9). Nothing here is
//! `tauri`-typed.
//!
//! Three facts decided the shape, and each is a measured hazard rather than a
//! preference:
//!
//! - **Tauri's notification plugin cannot answer this.** `permission_state()`
//!   and `request_permission()` are STUBBED to `Granted` on desktop (measured
//!   against 2.4.0), so an app asking the plugin is told yes by a machine that
//!   is dropping every notification on the floor. The framework API is the
//!   only source of the real answer.
//! - **The API aborts a process that is not an `.app` bundle.**
//!   `currentNotificationCenter` kills the process with "bundleProxyForCurrent
//!   Process is nil" from a bare binary — which is exactly what `tauri dev`
//!   runs. So [`in_app_bundle`] gates every call, and a dev build answers
//!   [`Permission::Unavailable`] instead of dying. The test at the bottom of
//!   this file IS that guard: `cargo test` is itself a bare binary, so a
//!   regression here does not fail an assertion, it aborts the test runner.
//! - **The identifier alone is not proof of a bundle.** `tauri-build` embeds
//!   an `Info.plist` into the dev BINARY, so `bundleIdentifier` answers there
//!   too. The bundle PATH is the half that cannot be faked by a linker
//!   section, which is why both are checked.
//!
//! Every asynchronous answer these frameworks give arrives on a completion
//! handler, so the two notification functions and [`request_photos`] block on
//! an `mpsc` channel with a bounded wait. [`photos_permission`] is the one call
//! here that answers synchronously, which is why it needs no channel. Those
//! three must therefore never be called from a thread the handler needs — the
//! notification handlers run on the framework's own queue rather than the main
//! one (the same reason every Objective-C consumer of this API re-dispatches to
//! main INSIDE the block), and [`WAIT`] is the backstop if that is ever untrue
//! on some future OS: a bounded wrong answer rather than a window that never
//! paints.
//!
//! A fourth measured fact sits beside that: **PhotoKit's consent prompt is
//! presentation, and presentation belongs on the main thread.** The Photos
//! REQUEST (not its handler) must run on main; calling it from this command's
//! worker thread was measured (2026-09-25, packaged app) to produce no sheet
//! and no TCC registration at all. The hop to main is INJECTED —
//! [`request_photos`] takes a `run_on_main` dispatcher from its caller — for a
//! reason measured the same day at 09:06: the first fix sent
//! `+[NSThread performBlockOnMainThread:]` through a raw `msg_send!`, that
//! selector does not exist on the class (its absence from the generated
//! bindings was the evidence, read the wrong way), and the unrecognized
//! selector ABORTS the process — an objc miss is not a catchable error.
//! `AppHandle::run_on_main_thread` is a checked Rust API, so the shape of the
//! hop can no longer be guessed wrong. The notifications calls keep calling
//! in place: the UN framework re-dispatches its own request internally,
//! which is why the same command-threaded pattern works for it and did not
//! for Photos.

use serde::Serialize;

/// How this app stands with one macOS permission.
///
/// One type for notifications and Photos both, because the page renders both
/// with one model: a glyph, a suffix and at most one button. The words on the
/// wire are the kebab-case variant names, and [`Permission::as_str`] gives the
/// same strings to anything that needs them without serde.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Permission {
    /// macOS has not asked yet. The only state in which asking does anything.
    NotDetermined,
    /// Refused — by the person, or by policy. macOS will not ask again, so the
    /// only route back is System Settings.
    Denied,
    /// Allowed.
    Authorized,
    /// Notifications only: allowed quietly, without having been asked.
    /// Delivered, so it counts as allowed everywhere this is acted on.
    Provisional,
    /// This process cannot ask the question — not a bundle, not macOS, or the
    /// OS did not answer in time. Never a statement about the person's choice.
    Unavailable,
}

impl Permission {
    /// The same words `serde` writes, for callers that hold a `Permission`
    /// rather than serializing one (log lines, a plist-free test).
    pub fn as_str(self) -> &'static str {
        match self {
            Permission::NotDetermined => "not-determined",
            Permission::Denied => "denied",
            Permission::Authorized => "authorized",
            Permission::Provisional => "provisional",
            Permission::Unavailable => "unavailable",
        }
    }
}

/// How long a framework callback has to answer before the caller gives up.
///
/// Generous, because this is a backstop and not a schedule: the UN framework
/// answers in microseconds when it answers at all, and the case this bounds is
/// the one where it never does. Ten seconds of a stuck probe is survivable;
/// a command that never returns freezes both of an app's windows.
#[cfg(target_os = "macos")]
const WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// May this app post notifications? Read-only — it never prompts.
#[cfg(target_os = "macos")]
pub fn notification_permission() -> Permission {
    use objc2_user_notifications::UNUserNotificationCenter;
    use std::ptr::NonNull;
    use std::sync::mpsc;

    if !in_app_bundle() {
        return Permission::Unavailable;
    }
    let (tx, rx) = mpsc::channel::<isize>();
    let handler = block2::RcBlock::new(
        move |settings: NonNull<objc2_user_notifications::UNNotificationSettings>| {
            // Send the raw NSInteger rather than the Objective-C object: the
            // value crosses a thread boundary, and a plain integer is the only
            // thing here that trivially may.
            //
            // SAFETY: the framework hands the block a live, non-null
            // `UNNotificationSettings` and keeps it alive for the call.
            let status = unsafe { settings.as_ref() }.authorizationStatus();
            let _ = tx.send(status.0);
        },
    );
    UNUserNotificationCenter::currentNotificationCenter().getNotificationSettingsWithCompletionHandler(&handler);
    match rx.recv_timeout(WAIT) {
        Ok(raw) => authorization_status(raw),
        Err(_) => Permission::Unavailable,
    }
}

/// Ask macOS for permission to post notifications, and answer where that left
/// things.
///
/// **The first of the two prompts the app owns**, and it fires at most once in
/// the life of an install: macOS shows the sheet only while the state is
/// [`Permission::NotDetermined`] and silently no-ops afterwards. So it belongs
/// behind a button a person pressed, on a screen that has just explained what
/// is about to be asked.
///
/// The answer is re-READ from the settings rather than inferred from the
/// handler's `granted` flag, because the flag cannot distinguish an
/// authorization from a provisional one — and the row that renders this
/// distinguishes them.
///
/// `Err` is reserved for the framework's own complaint (a bundle it will not
/// accept, an entitlement problem): a refusal by the person is
/// [`Permission::Denied`], which is an answer and not an error.
#[cfg(target_os = "macos")]
pub fn request_notifications() -> Result<Permission, String> {
    use objc2::runtime::Bool;
    use objc2_foundation::NSError;
    use objc2_user_notifications::{UNAuthorizationOptions, UNUserNotificationCenter};
    use std::sync::mpsc;

    if !in_app_bundle() {
        return Ok(Permission::Unavailable);
    }
    let (tx, rx) = mpsc::channel::<Option<String>>();
    let handler = block2::RcBlock::new(move |_granted: Bool, error: *mut NSError| {
        // The error's DESCRIPTION, not the error: same rule as above, and the
        // string is the only part of it anything here can render.
        //
        // SAFETY: non-null only when the framework reports a failure, and the
        // object is alive for the duration of the call.
        let message = unsafe { error.as_ref() }.map(|e| e.localizedDescription().to_string());
        let _ = tx.send(message);
    });
    // Alert and sound, and nothing else: this app posts one kind of
    // notification — an agent is waiting — and badges, CarPlay and critical
    // alerts are capabilities it would be asking for and never using.
    let options = UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound;
    UNUserNotificationCenter::currentNotificationCenter()
        .requestAuthorizationWithOptions_completionHandler(options, &handler);
    match rx.recv_timeout(WAIT) {
        Ok(None) => Ok(notification_permission()),
        Ok(Some(message)) => Err(message),
        Err(_) => Ok(Permission::Unavailable),
    }
}

/// May this app read the Photos library? Read-only — `authorizationStatus` is
/// the API that never prompts, which is the whole reason it is the one used.
///
/// Asking lives in [`request_photos`], not here. For most of this feature the
/// app only ever READ this state, because the system raises the prompt at the
/// moment an image is picked (spec 2026-09-14 § 9) — and the picker's panel is
/// this app's own, so that prompt arms the same subject a prompt raised here
/// would. That is what makes the button on the permissions screen real rather
/// than a second door to the same room, and the app reads the answer either
/// way so it can explain a picker that silently attaches nothing.
#[cfg(target_os = "macos")]
pub fn photos_permission() -> Permission {
    use objc2_photos::{PHAccessLevel, PHAuthorizationStatus, PHPhotoLibrary};

    if !in_app_bundle() {
        return Permission::Unavailable;
    }
    // SAFETY: a class method taking a plain enum and returning one. It reads
    // the TCC answer for this bundle and does not prompt.
    let status = unsafe { PHPhotoLibrary::authorizationStatusForAccessLevel(PHAccessLevel::ReadWrite) };
    match status {
        PHAuthorizationStatus::NotDetermined => Permission::NotDetermined,
        // `Restricted` is a policy denial (a profile, screen time) rather than
        // the person's, but the two are one fact to everything that acts on
        // this: attaching from Photos will not work and System Settings is
        // where to look.
        PHAuthorizationStatus::Denied | PHAuthorizationStatus::Restricted => Permission::Denied,
        // `Limited` means the person chose WHICH photos this app may see. The
        // picker works, so the only notice this drives — "images picked from
        // Photos will not attach" — would be false.
        PHAuthorizationStatus::Authorized | PHAuthorizationStatus::Limited => Permission::Authorized,
        // A status this OS grew after this build. Refusing to guess is the
        // same answer as "cannot ask", and it renders as an explanation rather
        // than as a wrong accusation.
        _ => Permission::Unavailable,
    }
}

/// Ask macOS for permission to read the Photos library, and answer where that
/// left things.
///
/// **The second prompt the app owns** (operator's request, 2026-09-17), and it
/// is NOT the no-op the original reasoning assumed. The prompt this raises is
/// the same TCC question the image picker asks, because the asking subject is
/// this app: `apps/server/desktop/AGENTS.md` records that Photos is raised by
/// the picker's own panel, which runs in this process, and `Info.plist` already
/// carries the `NSPhotoLibraryUsageDescription` sentence that sheet shows.
/// Asking here arms exactly what the picker would otherwise arm later.
///
/// Asks at [`PHAccessLevel::ReadWrite`], the SAME level [`photos_permission`]
/// reads, so the sheet and the row answer one question.
///
/// The answer is re-READ from [`photos_permission`] rather than mapped from the
/// handler's status — the notifications request's own reasoning, and stronger
/// here: this row renders the difference between `authorized` and `limited`,
/// and one read keeps that mapping in one place.
///
/// `Err` is reserved for the framework's complaint. A refusal by the person is
/// [`Permission::Denied`], which is an answer and not an error. The Photos
/// callback carries no `NSError` at all — its whole answer is the status.
/// The dispatcher moves the request to the main thread; this crate cannot do
/// that hop itself (it is `tauri`-free), and the caller must not guess an
/// Objective-C selector for it: `+[NSThread performBlockOnMainThread:]` does
/// NOT exist, an unrecognized selector aborts the process outright, and 1.0.1
/// shipped that mistake — the crash report of 2026-09-25 09:06 is the record.
/// `AppHandle::run_on_main_thread` is the checked hop the caller hands in.
#[cfg(target_os = "macos")]
pub fn request_photos(
    run_on_main: impl FnOnce(Box<dyn FnOnce() + Send>) -> Result<(), String>,
) -> Result<Permission, String> {
    use objc2_photos::{PHAccessLevel, PHAuthorizationStatus, PHPhotoLibrary};
    use std::sync::mpsc;

    if !in_app_bundle() {
        return Ok(Permission::Unavailable);
    }
    let (tx, rx) = mpsc::channel::<()>();
    // **The request itself goes to the main thread.** Called from this
    // command's tokio worker (measured 2026-09-25, packaged app): the sheet
    // never appeared and the app never registered under System Settings →
    // Privacy & Security → Photos, which is what "no consent prompt ever
    // reached TCC" looks like from outside. PhotoKit's consent sheet is
    // presentation, and the completion handler — unlike UN's, which this
    // same pattern serves fine — arrives on an arbitrary background queue,
    // so blocking HERE (never on main) stays safe: main presents, a framework
    // queue answers, this worker waits.
    let start = Box::new(move || {
        let answer = tx;
        let handler = block2::RcBlock::new(move |_status: PHAuthorizationStatus| {
            // The status is dropped on purpose — the row is re-read below.
            // What crosses the channel is only the fact that the framework
            // answered.
            let _ = answer.send(());
        });
        // SAFETY: a class method taking a plain enum and a completion block,
        // now called on the main thread by the injected dispatcher. The block
        // runs on the framework's own queue with a plain integer argument;
        // the `WAIT` timeout bounds the wait, exactly as around the UN calls.
        unsafe {
            PHPhotoLibrary::requestAuthorizationForAccessLevel_handler(PHAccessLevel::ReadWrite, &handler);
        }
    });
    run_on_main(start)?;
    match rx.recv_timeout(WAIT) {
        Ok(()) => Ok(photos_permission()),
        Err(_) => Ok(Permission::Unavailable),
    }
}

/// `UNAuthorizationStatus` as the one enum both rows render.
///
/// `Ephemeral` (an App Clip's session-scoped grant) maps to `Authorized`: it
/// delivers, and there is nothing a person could do about it if it did not.
#[cfg(target_os = "macos")]
fn authorization_status(raw: isize) -> Permission {
    use objc2_user_notifications::UNAuthorizationStatus;
    match UNAuthorizationStatus(raw) {
        UNAuthorizationStatus::NotDetermined => Permission::NotDetermined,
        UNAuthorizationStatus::Denied => Permission::Denied,
        UNAuthorizationStatus::Authorized | UNAuthorizationStatus::Ephemeral => Permission::Authorized,
        UNAuthorizationStatus::Provisional => Permission::Provisional,
        _ => Permission::Unavailable,
    }
}

/// Whether this process is running from an `.app` bundle.
///
/// **Both halves are load-bearing.** A bundle identifier alone is not proof:
/// `tauri-build` embeds an `Info.plist` into the dev binary through a linker
/// section, so `bundleIdentifier` answers for `tauri dev` — the exact process
/// in which touching the UN framework aborts. The bundle PATH is what a
/// linker section cannot supply, and for a loose binary it is the directory
/// the binary sits in, which does not end in `.app`.
///
/// Getting this wrong is not a wrong answer, it is a crash with no stack in
/// the log, so it is checked before every call in this module rather than once
/// at startup.
#[cfg(target_os = "macos")]
fn in_app_bundle() -> bool {
    use objc2_foundation::NSBundle;

    let bundle = NSBundle::mainBundle();
    bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
}

// ---------------------------------------------------------------------------
// Everywhere else
// ---------------------------------------------------------------------------

/// Linux has none of these prompts, so there is no state to report.
#[cfg(not(target_os = "macos"))]
pub fn notification_permission() -> Permission {
    Permission::Unavailable
}

/// Linux has nothing to ask for; see [`notification_permission`].
#[cfg(not(target_os = "macos"))]
pub fn request_notifications() -> Result<Permission, String> {
    Ok(Permission::Unavailable)
}

/// Linux has no Photos library; see [`notification_permission`].
#[cfg(not(target_os = "macos"))]
pub fn photos_permission() -> Permission {
    Permission::Unavailable
}

/// Linux has nothing to ask for; see [`request_notifications`]. The dispatcher
/// is ignored — there is no request to move.
///
/// The stub is load-bearing rather than tidy: `control.rs` names this function
/// on every platform, and `cargo clippy` on a Mac cannot see what Linux
/// compiles — the trap `apps/server/desktop/AGENTS.md` records.
#[cfg(not(target_os = "macos"))]
pub fn request_photos(
    _run_on_main: impl FnOnce(Box<dyn FnOnce() + Send>) -> Result<(), String>,
) -> Result<Permission, String> {
    Ok(Permission::Unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **This is the crash guard, not a value check.**
    ///
    /// `cargo test` builds a bare binary in `target/debug/deps`, which is
    /// precisely the process shape `currentNotificationCenter` aborts in — so
    /// a regression in [`in_app_bundle`] does not fail this assertion, it
    /// kills the test runner with no assertion output at all. A green run here
    /// is the evidence that `tauri dev` still starts.
    ///
    /// On Linux the same call answers the same word for an entirely different
    /// reason, which is why one test covers both platforms.
    #[test]
    fn every_answer_is_unavailable_outside_a_bundle() {
        assert_eq!(notification_permission(), Permission::Unavailable);
        assert_eq!(photos_permission(), Permission::Unavailable);
        assert_eq!(request_notifications(), Ok(Permission::Unavailable));
        assert_eq!(request_photos(|_| Ok(())), Ok(Permission::Unavailable));
    }

    /// The five words are the wire contract with both the assistant page and
    /// the SPA, and they are written twice — by serde and by `as_str`. Two
    /// spellings of one word is how a row renders "unavailable" forever.
    #[test]
    fn the_wire_words_agree_with_as_str() {
        let cases = [
            (Permission::NotDetermined, "not-determined"),
            (Permission::Denied, "denied"),
            (Permission::Authorized, "authorized"),
            (Permission::Provisional, "provisional"),
            (Permission::Unavailable, "unavailable"),
        ];
        for (value, word) in cases {
            assert_eq!(value.as_str(), word);
            assert_eq!(serde_json::to_string(&value).unwrap(), format!("\"{word}\""));
        }
    }
}
