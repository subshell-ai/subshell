//! Whether an interrupted update has a second half left, and whether to run it
//! (spec 2026-09-18 § 5).
//!
//! Both apps make this decision and differ only in what they DO with the
//! answer — the server app installs its bundled server and restarts the
//! service, the client app installs its bundled agent and deliberately does
//! not restart the daemon. So the branching lives here, shared, and the acting
//! stays in each app's own `control.rs`: an abstraction over the acting would
//! be one real consumer and one guess, which is the trade this crate's own
//! rule refuses.

use crate::settings::PendingBundledInstall;
use crate::version::version_lt;

/// How many boots may try the second half before it stops trying by itself.
///
/// Bounded because the failure mode is a loop the person cannot escape: an
/// install that fails on every boot would take the window to a failure screen
/// on every launch, forever. At the limit the marker STAYS — so the screen can
/// still offer Retry and still name the update — but nothing fires
/// automatically. This is the one place the design stops acting on someone's
/// behalf rather than trying again.
///
/// **What a halted screen can say, exactly.** Which versions, and that the
/// install did not finish. It cannot say WHY: the failure text is page state
/// in a process that no longer exists, and nothing here persists it across the
/// relaunch. The spec's "says what failed" was written before that was
/// noticed (review, 2026-09-18) and both it and this sentence now claim only
/// what ships. Making it literally true needs a `last_error` on
/// [`crate::settings::PendingBundledInstall`], written where the install
/// fails and read by both apps — a deliberate follow-up rather than a field
/// added to the marker in the same change that fixed the marker's own
/// correctness.
pub const MAX_RESUME_ATTEMPTS: u32 = 2;

/// What a boot should do about the marker it found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resume {
    /// Install the bundled CLI, carrying the phase-1 pane-safety consent.
    Install { forced: bool },
    /// There is nothing to install. Drop the marker without acting.
    Clear,
    /// There is work, and it has failed too many times to keep retrying.
    Halt,
}

/// Whether a marker records an act at all.
///
/// [`PendingBundledInstall`] derives `Default` under `#[serde(default)]`, so a
/// truncated or hand-edited `{"pendingBundledInstall":{}}` deserializes
/// happily into a marker whose `from_app_version` is empty — and that field is
/// the whole record of WHICH update this is. The server app renders it into a
/// sentence, which an empty string turns into "… was updated from , but …".
/// Nothing else in the struct can say the file was garbage, so this is the one
/// field worth refusing on: an act with no version handing off is not one of
/// ours, and installing off it would be acting on a file nobody wrote.
///
/// **Here rather than in either app** (review M17): the client grew this guard
/// and the server did not, in the same commit whose stated purpose was
/// removing drift between the two — and the field it guards belongs to this
/// crate, so the guard does too.
pub fn names_an_act(marker: &PendingBundledInstall) -> bool {
    !marker.from_app_version.trim().is_empty()
}

/// The decision, from the marker and the two versions that say whether there
/// is anything to do.
///
/// **The marker converts an OFFER into a continuation, and that is all it
/// does.** Whether work EXISTS is still decided by the machine — the bundled
/// copy against the installed one, the same comparison the probe already makes
/// — so a marker whose work turns out to be done (someone ran the CLI's own
/// `update` in between, say) is cleared without acting, and no timestamp
/// validity rule is needed. A marker can never cause an install that the probe
/// would not have offered anyway.
///
/// `None` means there is no marker at all: an ordinary boot, with nothing to
/// decide.
///
/// @param marker - the stored marker, if this app wrote one
/// @param bundled - the CLI version inside this app, if it ships one
/// @param installed - the CLI version on the resolution ladder, if any
pub fn resume_decision(
    marker: Option<&PendingBundledInstall>,
    bundled: Option<&str>,
    installed: Option<&str>,
) -> Option<Resume> {
    let marker = marker?;
    // A marker that names no act is a garbage file, not an interrupted
    // update. Refusing HERE rather than at each caller is what stops the two
    // apps from disagreeing about it again — `Clear` so the caller drops it.
    if !names_an_act(marker) {
        return Some(Resume::Clear);
    }
    let has_work = match (bundled, installed) {
        (Some(b), Some(i)) => version_lt(i, b),
        // A bundle with nothing installed is work: the first install.
        (Some(_), None) => true,
        // No bundle to install FROM. Nothing this marker can mean.
        //
        // **This arm cannot tell that from an unanswerable probe** (review,
        // 2026-09-18): the caller's `bundled` is `None` both for a build that
        // ships no CLI and for one whose `<sidecar> version` spawn timed out —
        // and that answer is memoized for the rest of the process, so a
        // cold-disk boot can drop a pending marker AND suppress the ordinary
        // bundled-server offer until the next launch.
        //
        // Availability rather than data loss: nothing is installed, the next
        // launch re-derives from the machine, and `version_lt` is strict, so no
        // older CLI can go over a newer one by this route. Left as it is
        // deliberately — the honest fix is a third answer from the probe rather
        // than a guess here — but written down rather than reading as a
        // considered `false`.
        (None, _) => false,
    };
    if !has_work {
        return Some(Resume::Clear);
    }
    if marker.attempts >= MAX_RESUME_ATTEMPTS {
        return Some(Resume::Halt);
    }
    Some(Resume::Install { forced: marker.forced })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marker(attempts: u32, forced: bool) -> PendingBundledInstall {
        PendingBundledInstall {
            from_app_version: "0.8.0".into(),
            started_at: "2026-09-18T12:00:00Z".into(),
            attempts,
            forced,
        }
    }

    /// A truncated or hand-edited `{"pendingBundledInstall":{}}` is a garbage
    /// file, not an interrupted update — and the field that says so is the
    /// only one that can (review M17).
    #[test]
    fn a_marker_that_names_no_act_is_cleared_rather_than_run() {
        let mut m = marker(0, true);
        m.from_app_version = String::new();
        assert!(!names_an_act(&m));
        assert_eq!(
            resume_decision(Some(&m), Some("0.10.0"), Some("0.9.0")),
            Some(Resume::Clear)
        );
        m.from_app_version = "   ".into();
        assert_eq!(
            resume_decision(Some(&m), Some("0.10.0"), Some("0.9.0")),
            Some(Resume::Clear)
        );
    }

    #[test]
    fn no_marker_means_nothing_to_resume() {
        assert_eq!(resume_decision(None, Some("0.10.0"), Some("0.9.0")), None);
    }

    #[test]
    fn a_marker_with_a_newer_bundle_installs() {
        let m = marker(0, false);
        assert_eq!(
            resume_decision(Some(&m), Some("0.10.0"), Some("0.9.0")),
            Some(Resume::Install { forced: false })
        );
    }

    #[test]
    fn the_phase_one_consent_rides_along() {
        let m = marker(0, true);
        assert_eq!(
            resume_decision(Some(&m), Some("0.10.0"), Some("0.9.0")),
            Some(Resume::Install { forced: true })
        );
    }

    /// The work is already done — someone ran `subshell-server update` by hand
    /// in between. Clearing without acting is what keeps the marker from being
    /// a second opinion about the machine.
    #[test]
    fn a_marker_whose_work_is_done_clears_without_acting() {
        let m = marker(0, false);
        assert_eq!(
            resume_decision(Some(&m), Some("0.10.0"), Some("0.10.0")),
            Some(Resume::Clear)
        );
    }

    /// An installed copy NEWER than the bundle is the adopt case, and it is
    /// not work either — the ladder already prefers it.
    #[test]
    fn an_installed_copy_newer_than_the_bundle_is_not_work() {
        let m = marker(0, false);
        assert_eq!(
            resume_decision(Some(&m), Some("0.9.0"), Some("0.10.0")),
            Some(Resume::Clear)
        );
    }

    #[test]
    fn a_bundle_with_nothing_installed_is_the_first_install() {
        let m = marker(0, false);
        assert_eq!(
            resume_decision(Some(&m), Some("0.10.0"), None),
            Some(Resume::Install { forced: false })
        );
    }

    #[test]
    fn a_marker_with_no_bundle_clears() {
        let m = marker(0, false);
        assert_eq!(resume_decision(Some(&m), None, Some("0.9.0")), Some(Resume::Clear));
    }

    /// Bounded, or a machine that cannot finish meets a failure screen on
    /// every launch for the rest of its life.
    #[test]
    fn it_halts_at_the_attempt_limit_rather_than_trying_forever() {
        let m = marker(MAX_RESUME_ATTEMPTS, false);
        assert_eq!(
            resume_decision(Some(&m), Some("0.10.0"), Some("0.9.0")),
            Some(Resume::Halt)
        );
    }

    /// One under the limit still tries — the bound is a ceiling, not an
    /// off-by-one that spends the last attempt on nothing.
    #[test]
    fn the_attempt_below_the_limit_still_runs() {
        let m = marker(MAX_RESUME_ATTEMPTS - 1, false);
        assert_eq!(
            resume_decision(Some(&m), Some("0.10.0"), Some("0.9.0")),
            Some(Resume::Install { forced: false })
        );
    }

    /// Halting is decided AFTER the work question, so a machine that has run
    /// out of attempts and has nothing left to do still clears rather than
    /// sitting on a marker forever.
    #[test]
    fn a_spent_marker_with_no_work_left_clears_rather_than_halting() {
        let m = marker(MAX_RESUME_ATTEMPTS, false);
        assert_eq!(
            resume_decision(Some(&m), Some("0.10.0"), Some("0.10.0")),
            Some(Resume::Clear)
        );
    }
}
