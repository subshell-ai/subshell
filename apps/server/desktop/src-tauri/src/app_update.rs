//! Updating **this app** — the `.app` or the `.deb`, not the server it wraps
//! (spec 2026-09-15 § 7.2).
//!
//! The other update path in this app hands a bundled CLI to that CLI's own
//! `update --from` (`control::delegate_update`). This is the other half of
//! requirement 1: replacing the APP with a newer one, without a person going
//! to a downloads page. `tauri-plugin-updater` does the work; what lives here
//! is the two decisions the plugin does not make.
//!
//! **Which release.** The plugin wants a static manifest URL, and this
//! repository publishes four components under four tag prefixes — so there is
//! no single "latest" to point it at. `check_app_update` reads the same
//! release LIST every other component reads (`desktop-core`'s `release_feed`,
//! mirroring `packages/subshell-protocol/src/releases.ts`), picks the newest
//! `desktop-server-v*` by SEMVER, and only then points the plugin at that
//! release's own `latest.json`. `SUBSHELL_RELEASE_URL` repoints the list and
//! an EMPTY value turns the whole thing off, the same seam and the same
//! air-gapped answer the server has.
//!
//! **What is trusted.** The plugin verifies a minisign signature against
//! `plugins.updater.pubkey`, compiled into this binary — so the release host
//! decides only WHETHER this app is offered an update, never WHAT it is. That
//! is strictly stronger than the CLI path, where the digest and the bytes come
//! from the same source (`docs/security.md`; spec § 11). Losing the private
//! key means no installed app can ever auto-update again, which is why the
//! `.key` belongs in the password manager beside the `.p12`.
//!
//! **On Linux the plugin installs the `.deb` through `dpkg`, behind a polkit
//! prompt**, so the screen says so before the press: a system password sheet
//! nobody was told about reads as malware.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use subshell_desktop_core::release_feed::{
    self, due_for_check, format_rfc3339, latest_manifest_url, newest_release, now_epoch_secs, release_feed_rows_from,
    ReleaseRow,
};
use subshell_desktop_core::settings::SettingsState;
use subshell_desktop_core::version::version_lt;

/// The tag prefix this app's own releases carry.
///
/// The release-component ID, not the directory: `apps/server/desktop` ships as
/// `desktop-server-vX.Y.Z` (root `AGENTS.md`, "GitHub Releases"). Getting this
/// wrong points the app at another component's releases, which would parse and
/// compare perfectly well.
pub const TAG_PREFIX: &str = "desktop-server-v";

/// How long the release-list fetch may take.
///
/// A check runs on launch and behind a menu item, so a source that hangs must
/// not hold either. Short on purpose: there is nothing to wait for but one
/// small JSON document.
const FEED_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// What a check found, for the screen and for the tray.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateCheck {
    /// This app's own version.
    pub current: String,
    /// The newest published version, when it is NEWER than `current`.
    ///
    /// `None` covers "up to date" and "could not tell" alike, which is why
    /// `reason` exists: a screen that cannot distinguish them says the wrong
    /// thing in one of the two cases.
    pub latest: Option<String>,
    /// The release page, for the screen's link.
    pub notes: Option<String>,
    /// Why there is no `latest`, when that is not simply "up to date".
    pub reason: Option<String>,
}

/// What `desktop_app_update` answers: the two version facts the page shows.
///
/// Deliberately NOT `AppUpdateCheck` — that carries a `reason` and a notes
/// URL for the screen that OWNS the checking. This is the standing answer
/// from the settings file the daily check writes, and it must stay two
/// fields: everything granted to the served SPA is argued on how little it
/// can say (spec 2026-09-17 § 5.3).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateStatus {
    /// This app's own version.
    pub current_version: String,
    /// The version the last successful check found newer, if any.
    pub available_version: Option<String>,
}

/// The one rule behind every rendering of the STORED notice: it may name only
/// a version strictly newer than what is running.
///
/// `last_update_version` is what the last answering check found, and the
/// answer goes stale the moment the person installs what was announced.
/// [`install_app_update`] clears the field; a hand replacement of the `.app`
/// does not, and an app that updated itself across a crash between the write
/// and the clear will not answer the release source for a day. Every site
/// that paints the stored value without consulting the source — the tray
/// seed, the launch check's not-due branch, the unanswered-check branch, and
/// the SPA-facing [`status_view`] — routes through here, so "Update
/// available — 0.8.0" can never be shown BY 0.8.0 (review 2026-09-17:
/// `run_check`'s own comment already called that state "worse than none";
/// only the check-answered path honoured it).
///
/// `version_lt` ignores suffixes on both sides, so a canary of the announced
/// version counts as installed — the same rule every other comparison here
/// uses.
pub fn notice_for(current: &str, stored: Option<&str>) -> Option<String> {
    stored
        .filter(|version| version_lt(current, version))
        .map(str::to_string)
}

/// The pure body of `desktop_app_update`, so the camelCase contract the SPA
/// codes against is pinned without a Tauri runtime.
///
/// The stored value is filtered through [`notice_for`] HERE rather than at
/// the command, so every reader of this view gets the rule; the SPA adds a
/// matching backstop because a NEW page can meet an OLD binary that stored
/// the announcement and never cleared it.
pub fn status_view(current_version: &str, available_version: Option<&str>) -> AppUpdateStatus {
    AppUpdateStatus {
        current_version: current_version.to_string(),
        available_version: notice_for(current_version, available_version),
    }
}

/// One download-progress frame, pushed on `desktop-app-update-progress`.
///
/// `total` is `None` where the release host sent no `Content-Length`, which is
/// a real case and the reason the screen renders a bare byte count rather than
/// a percentage it cannot always compute.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    received: u64,
    total: Option<u64>,
}

/// Ask the release source whether a newer APP exists.
///
/// Never errors for "there is nothing": an air-gapped install, a source that
/// would not answer and an app already at the newest version are all ordinary
/// states of a machine, and a screen that shows an error banner for the first
/// two teaches people to ignore it. `Err` is reserved for the plugin itself
/// refusing — a malformed endpoint, or a build with no public key.
pub async fn check_app_update(app: &AppHandle) -> Result<AppUpdateCheck, String> {
    let current = app.package_info().version.to_string();
    let Some(endpoint) = release_feed::release_api(std::env::var(release_feed::RELEASE_URL_ENV).ok()) else {
        return Ok(AppUpdateCheck {
            current,
            reason: Some("no release source is configured (SUBSHELL_RELEASE_URL is empty)".into()),
            ..Default::default()
        });
    };
    let rows = match fetch_rows(&endpoint).await {
        Ok(rows) => rows,
        Err(reason) => {
            return Ok(AppUpdateCheck {
                current,
                reason: Some(reason),
                ..Default::default()
            })
        }
    };
    let Some(pick) = newest_release(TAG_PREFIX, &rows) else {
        return Ok(AppUpdateCheck {
            current,
            reason: Some(format!("the release source publishes no {TAG_PREFIX}* release")),
            ..Default::default()
        });
    };
    if !version_lt(&current, &pick.version) {
        return Ok(AppUpdateCheck {
            current,
            ..Default::default()
        });
    }
    // Only NOW does the plugin get involved, and only with one URL. Its own
    // `check()` is what verifies the manifest's signature against this build's
    // public key, so a release host that lied about which version exists still
    // cannot hand this app bytes it did not sign.
    let manifest = latest_manifest_url(&pick.tag);
    let updater = app
        .updater_builder()
        .endpoints(vec![manifest
            .parse()
            .map_err(|e| format!("bad updater endpoint: {e}"))?])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    match updater.check().await {
        // The plugin refuses a version that is not newer than this build, so
        // `None` here means the manifest disagrees with the tag — a half-cut
        // release, most likely. Say that rather than "up to date".
        Ok(None) => Ok(AppUpdateCheck {
            current,
            reason: Some(format!("{} publishes no update for this platform", pick.tag)),
            ..Default::default()
        }),
        Ok(Some(update)) => Ok(AppUpdateCheck {
            current,
            latest: Some(update.version.clone()),
            notes: Some(release_page_url(&pick.tag)),
            reason: None,
        }),
        Err(e) => Ok(AppUpdateCheck {
            current,
            reason: Some(e.to_string()),
            ..Default::default()
        }),
    }
}

/// Download and install the newest app, then relaunch into it.
///
/// Re-resolves the release rather than taking one from the page: the check's
/// answer travelled to a webview and back, and the only argument this command
/// accepts is therefore no argument at all.
///
/// **`app.restart()` never returns.** It is `-> !` and `exit(0)`s when it
/// cannot resolve the current executable, which is why the install is awaited
/// first and why the caller is the bundled page rather than a background
/// thread — see this app's `AGENTS.md` on the reset chain's three details,
/// which apply verbatim.
pub async fn install_app_update(app: &AppHandle) -> Result<(), String> {
    let Some(endpoint) = release_feed::release_api(std::env::var(release_feed::RELEASE_URL_ENV).ok()) else {
        return Err("no release source is configured (SUBSHELL_RELEASE_URL is empty)".into());
    };
    let rows = fetch_rows(&endpoint).await?;
    let pick = newest_release(TAG_PREFIX, &rows).ok_or_else(|| format!("no {TAG_PREFIX}* release to install"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![latest_manifest_url(&pick.tag)
            .parse()
            .map_err(|e| format!("bad updater endpoint: {e}"))?])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("{} publishes no update for this platform", pick.tag))?;

    let handle = app.clone();
    let mut received: u64 = 0;
    update
        .download_and_install(
            move |chunk, total| {
                received += chunk as u64;
                let _ = handle.emit("desktop-app-update-progress", ProgressEvent { received, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    // Clear the stored notice BEFORE the restart, not after — `restart()` is
    // `-> !` (this file's own header says so), so anything sequenced behind it
    // never runs. A stored 0.8.0 met by a relaunched 0.8.0 is the stale-notice
    // bug exactly: the not-due launch branch and the tray seed would repaint
    // "Update available — 0.8.0" from it for up to a day. The read side filters
    // that shape now ([`notice_for`]); this keeps the STORED fact honest, which
    // is what `run_check`'s comment demands of a check that found nothing newer.
    let _ = app.state::<SettingsState>().update(|s| s.last_update_version = None);
    app.restart();
}

/// This app's own release page, for the screen's "what changed" link.
fn release_page_url(tag: &str) -> String {
    format!(
        "https://github.com/{}/releases/tag/{tag}",
        release_feed::SUBSHELL_REPO_SLUG
    )
}

/// Install rustls' default crypto provider, if nothing has yet.
///
/// `reqwest`'s `rustls-no-provider` feature — the one the updater plugin
/// selects, and therefore the one this app must select too, or cargo resolves a
/// SECOND reqwest with a second rustls under it — deliberately picks no
/// provider. The plugin installs `ring` lazily when it builds ITS client
/// (`updater.rs:492`, guarded the same way); this app's client may be built
/// first, and a client with no provider fails every connection with an error
/// about a missing default rather than about the network.
///
/// `install_default` answers `Err` when one is already installed, which is not
/// a failure here: the guard and the ignored result are both deliberate.
fn ensure_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// GET the release list and parse it.
///
/// A GitHub API request needs a `User-Agent` or it is refused with 403, and
/// the one this app sends names the app rather than the HTTP client, so a rate
/// limit is attributable to a product rather than to "reqwest".
async fn fetch_rows(endpoint: &str) -> Result<Vec<ReleaseRow>, String> {
    ensure_crypto_provider();
    let client = reqwest::Client::builder()
        .timeout(FEED_TIMEOUT)
        .user_agent(concat!("SubshellServerDesktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client.get(endpoint).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("the release source answered {}", response.status()));
    }
    let body = response.text().await.map_err(|e| e.to_string())?;
    release_feed_rows_from(&body).map_err(|e| format!("the release source's answer is not a release list: {e}"))
}

/// The launch-time check: at most once a day, and it opens nothing.
///
/// Spawned rather than awaited, because a slow or unreachable release source
/// must not delay the window this app exists to show. What it changes is the
/// TRAY ITEM's label and the two stored fields behind it; a window that
/// appeared on its own because a release was cut is the "automatic updates"
/// this design is explicitly not (spec § 14).
pub fn check_on_launch(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let settings = handle.state::<SettingsState>();
        if !due_for_check(settings.get().last_update_check_at.as_deref(), now_epoch_secs()) {
            // Still refresh the label from what the last check found: the item
            // is built before this runs, and a stored version it does not know
            // about would otherwise only appear a day later. Filtered through
            // `notice_for` — this branch paints STORED state with no source
            // consulted, which is precisely where an installed-update lie
            // survives (a hand-replaced `.app` never clears the field).
            let stored = notice_for(
                &handle.package_info().version.to_string(),
                settings.get().last_update_version.as_deref(),
            );
            crate::tray::set_update_available(&handle, stored.as_deref());
            return;
        }
        // `settings` is a borrowed guard and `run_check` re-takes the state
        // itself; the guard simply lives to the end of the block, which is
        // exactly what the old inlined body did across its own await.
        run_check(&handle).await;
    });
}

/// Force the check now, ignoring the daily gate: the tray's "Check for
/// Updates…" press (spec 2026-09-17 § 5.2).
///
/// The item stays pressable precisely because a person may not want to wait
/// for tomorrow's daily check. Like it, this opens nothing — the answer lands
/// in the settings file and on the tray label, and a press that had found an
/// update routes the NEXT press to the `app-update` screen.
pub fn check_now(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move { run_check(&handle).await });
}

/// Whether a check is already in flight (the tray press and the launch timer
/// are two askers for the SAME answer). A second overlapping check was benign
/// — last-write-wins on the same two settings fields — but it also bought
/// nothing: the one running will write just as fresh an answer. So a press
/// during a check is a no-op, and the RAII clear means the NEXT press works.
/// This is deliberately NOT `control::ActionGuard`: that flag serializes
/// MACHINE MUTATIONS, and a network read has no business refusing a
/// supervision press for the seconds a release page takes to answer.
static CHECK_IN_FLIGHT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn try_begin_check() -> bool {
    use std::sync::atomic::Ordering::SeqCst;
    !CHECK_IN_FLIGHT.swap(true, SeqCst)
}

struct CheckGuard;

impl Drop for CheckGuard {
    fn drop(&mut self) {
        CHECK_IN_FLIGHT.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// One check against the release source, whatever asked for it.
///
/// A press and a launch owe the person the same bookkeeping, so there is one
/// body: stamp the clock and record the answer only when the source actually
/// ANSWERED, and otherwise keep showing whatever the last check that did
/// found. One at a time — see [`CHECK_IN_FLIGHT`].
async fn run_check(handle: &AppHandle) {
    if !try_begin_check() {
        return;
    }
    let _guard = CheckGuard;
    let settings = handle.state::<SettingsState>();
    // A check that could not REACH the source is not a check that found
    // nothing, and `.ok()` cannot tell them apart: `check_app_update`
    // deliberately returns `Ok` for an unreachable source and puts the
    // cause in `reason`. Stamping the clock on that answer would suppress
    // the next check for a day, and clearing `last_update_version` would
    // drop the tray notice for an update already found — one flaky launch
    // hiding a real release until tomorrow.
    let answered = check_app_update(handle).await.ok().filter(|c| c.reason.is_none());
    let Some(check) = answered else {
        // Leave the stamp and the stored version exactly as they were, and
        // keep showing whatever the last check that DID answer found —
        // filtered through `notice_for`, since "found" here means a stored
        // value painted with no source consulted.
        let stored = notice_for(
            &handle.package_info().version.to_string(),
            settings.get().last_update_version.as_deref(),
        );
        crate::tray::set_update_available(handle, stored.as_deref());
        return;
    };
    let found = check.latest;
    let stamp = format_rfc3339(now_epoch_secs());
    let _ = settings.update(|s| {
        s.last_update_check_at = Some(stamp);
        // Cleared by a check that found nothing newer: a notice naming a
        // version the person has already installed is worse than none.
        s.last_update_version = found.clone();
    });
    crate::tray::set_update_available(handle, found.as_deref());
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two askers (a press during the launch check) collapse to one run, and
    /// the flag never sticks closed — a stuck flag would silently kill the
    /// tray press for the rest of the app's life, which is a worse failure
    /// than the benign overlap it replaces. Sole toucher of the flag: cargo
    /// runs tests in threads, so no other test may call `try_begin_check`.
    #[test]
    fn one_check_at_a_time_and_never_stuck() {
        assert!(try_begin_check());
        assert!(!try_begin_check(), "a second concurrent check must skip");
        drop(CheckGuard);
        assert!(try_begin_check(), "a press after a finished check must work");
        drop(CheckGuard);
    }

    /// The tag prefix is the release-component ID, and getting it wrong points
    /// this app at a different component's releases — which would parse and
    /// compare perfectly well, and offer the CLI's version as an app update.
    #[test]
    fn the_prefix_is_this_components_own() {
        assert_eq!(TAG_PREFIX, "desktop-server-v");
        assert!(release_feed::parse_release_tag(TAG_PREFIX, "desktop-server-v1.2.3").is_some());
        assert!(release_feed::parse_release_tag(TAG_PREFIX, "server-v1.2.3").is_none());
        assert!(release_feed::parse_release_tag(TAG_PREFIX, "desktop-client-v1.2.3").is_none());
    }

    #[test]
    fn the_release_page_link_names_this_repository_and_the_tag() {
        assert_eq!(
            release_page_url("desktop-server-v1.2.3"),
            "https://github.com/subshell-ai/subshell/releases/tag/desktop-server-v1.2.3"
        );
    }

    /// The wire shape `desktop_app_update` answers with (spec 2026-09-17
    /// § 5.3): exactly two camelCase keys, `availableVersion` nullable. The
    /// SPA's sidebar row codes against these names, and a rename here is a
    /// silent `undefined` there — the same failure class `wire-names.test.ts`
    /// exists for, pinned from this side.
    #[test]
    fn the_status_view_serializes_exactly_the_two_camel_case_fields() {
        let known = serde_json::to_value(status_view("0.7.2", Some("0.8.0"))).unwrap();
        assert_eq!(
            known,
            serde_json::json!({ "currentVersion": "0.7.2", "availableVersion": "0.8.0" })
        );
        // Before the first check ever, the field is present and null — the
        // row renders the version line without the update button, which is
        // the documented answer (spec § 8), not a missing key.
        let unknown = serde_json::to_value(status_view("0.7.2", None)).unwrap();
        assert_eq!(
            unknown,
            serde_json::json!({ "currentVersion": "0.7.2", "availableVersion": null })
        );
    }

    /// The stored notice outliving the install it announced (review
    /// 2026-09-17): the daily check stores `0.8.0`, the person installs
    /// `0.8.0`, and from then on every site that paints the STORED value
    /// without consulting the source must answer "nothing to announce" —
    /// equal is not newer, and OLDER is not newer either (the reverse case
    /// is reachable when an app reverts, or when a newer app is handed a
    /// settings file from an older install).
    #[test]
    fn a_notice_names_only_a_version_newer_than_the_one_running() {
        assert_eq!(notice_for("0.7.2", Some("0.8.0")).as_deref(), Some("0.8.0"));
        assert_eq!(notice_for("0.8.0", Some("0.8.0")), None);
        assert_eq!(notice_for("0.9.0", Some("0.8.0")), None);
        assert_eq!(notice_for("0.8.0", None), None);
        // The empty stored word is the "nothing known" case `update_label`
        // already renders as a bare ask; the filter must not resurrect it.
        assert_eq!(notice_for("0.8.0", Some("")), None);
        // Suffix-ignoring comparison: a canary of the announced version IS
        // that version, same rule every other comparison here uses.
        assert_eq!(notice_for("0.8.0-canary.1", Some("0.8.0")), None);
    }

    /// The filter is inside `status_view`, not at the command — so the one
    /// pure body that feeds the SPA serialises the stale answer as null.
    #[test]
    fn the_status_view_answers_null_when_the_notice_names_the_running_version() {
        let stale = serde_json::to_value(status_view("0.8.0", Some("0.8.0"))).unwrap();
        assert_eq!(
            stale,
            serde_json::json!({ "currentVersion": "0.8.0", "availableVersion": null })
        );
    }
}
