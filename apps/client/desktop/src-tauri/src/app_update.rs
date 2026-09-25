//! Updating **this app** — the `.app` or the `.deb`, not the node agent it
//! wraps (spec 2026-09-15 § 7.2).
//!
//! The other update path in this app hands the bundled agent to that agent's
//! own `update --from` (`control::delegate_update`). This is the other half of
//! requirement 1: replacing the APP with a newer one, without a person going
//! to a downloads page. `tauri-plugin-updater` does the work; what lives here
//! is the two decisions the plugin does not make.
//!
//! **Which release.** The plugin wants a static manifest URL, and this
//! repository publishes four components under four tag prefixes — so there is
//! no single "latest" to point it at. `check_app_update` reads the same
//! release LIST every other component reads (`desktop-core`'s `release_feed`,
//! mirroring `packages/subshell-protocol/src/releases.ts`), picks the newest
//! `desktop-client-v*` by SEMVER, and only then points the plugin at that
//! release's own `latest.json`. `SUBSHELL_RELEASE_URL` repoints the list and
//! an EMPTY value turns the whole thing off, the same seam and the same
//! air-gapped answer the control plane has.
//!
//! **What is trusted.** The plugin verifies a minisign signature against
//! `plugins.updater.pubkey`, compiled into this binary — the SAME key
//! `apps/server/desktop` pins, because the two apps are one publisher and a
//! public key is the publisher's identity rather than the app's. So the
//! release host decides only WHETHER this app is offered an update, never what
//! it is.
//!
//! **On Linux the plugin installs the `.deb` through `dpkg`, behind a polkit
//! prompt**, so the screen says so before the press: a system password sheet
//! nobody was told about reads as malware.
//!
//! This is a near-twin of `apps/server/desktop/src-tauri/src/app_update.rs`,
//! and deliberately so — it is `tauri`-typed and names this app's own tag
//! prefix, its own event and its own tray item, which is exactly the class
//! `crates/desktop-core`'s own rules keep out of the shared crate. What IS
//! shared is every decision that has no `tauri` type in it: the endpoint, the
//! tag parse, the semver pick, the manifest URL and the 24-hour schedule all
//! live in `desktop-core`'s `release_feed`.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use subshell_desktop_core::release_feed::{
    self, due_for_check, format_rfc3339, latest_manifest_url, newest_release, now_epoch_secs, release_feed_rows_from,
    ReleaseRow,
};
use subshell_desktop_core::settings::{PendingBundledInstall, SettingsState};
use subshell_desktop_core::version::{notice_for, version_lt};

/// The tag prefix this app's own releases carry.
///
/// The release-component ID, not the directory: `apps/client/desktop` ships as
/// `desktop-client-vX.Y.Z` (`docs/release-and-ci.md`, "GitHub Releases"). Getting this
/// wrong points the app at another component's releases, which would parse and
/// compare perfectly well.
pub const TAG_PREFIX: &str = "desktop-client-v";

/// How long the release-list fetch may take.
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

/// One download-progress frame, pushed on `node-app-update-progress`.
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
/// answer travelled to a webview and back, so no location this command uses
/// comes from there. Its one argument is the § 13 selection — whether the
/// agent half rides along — and it names nothing.
///
/// **This is PHASE 1 of one act** (spec 2026-09-18 § 4.2). Replacing this app
/// replaces the agent it BUNDLES, which is a source to install FROM and is on
/// no rung of the resolution ladder — so a running `subshell` daemon keeps
/// running `~/.local/bin/subshell` whatever lands here. The second half is
/// installing that bundled agent, and it necessarily runs in a process that
/// did not exist when the person pressed, so the marker written below is what
/// carries the act across the relaunch. `node_probe` weighs it against the
/// machine on the new build's first read and the update screen finishes the
/// act (`control::resume_view`).
///
/// **The marker is written AFTER the install and BEFORE the relaunch, never
/// after.** A crash between the two must leave a machine that knows what it
/// was doing; a crash before the install leaves none, which is right, because
/// nothing was replaced. It is written even on a machine with nothing to
/// install, because deciding that is `resume_decision`'s job and not this
/// one's — a marker whose work turns out to be done is cleared without acting.
///
/// **What it is NOT written for is a cleared agent row.** `install_node`
/// false writes no marker at all, so phase 2 never runs: the selection crosses
/// the relaunch as the marker's PRESENCE, which is how Subshell Server does it
/// and how there comes to be no second field for the two halves to disagree
/// about.
///
/// **`app.restart()` never returns**: it is `-> !`.
pub async fn install_app_update(app: &AppHandle, install_node: bool) -> Result<(), String> {
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
                let _ = handle.emit("node-app-update-progress", ProgressEvent { received, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    // **The selection crosses the relaunch as the marker's PRESENCE** (§ 13.1,
    // mirrored from Subshell Server in review, 2026-09-18). A cleared agent row
    // writes no marker at all, so phase 2 does not run and there is no second
    // field for the two halves to disagree about. The person who unticked it
    // keeps the agent they deliberately left where it is.
    //
    // `forced` is always false here, and that is not an omission: it carries a
    // pane-safety consent for a service RESTART, and this app's phase 2 offers
    // that restart rather than performing it (spec § 7.1). The field exists
    // for Subshell Server, which does restart, and the two apps share the
    // struct's format and never the file.
    let marker = install_node.then(|| PendingBundledInstall {
        from_app_version: app.package_info().version.to_string(),
        started_at: format_rfc3339(now_epoch_secs()),
        attempts: 0,
        forced: false,
    });
    // ONE write, because both edits must land before the relaunch and
    // `SettingsState::update` takes the lock across edit and save — two calls
    // would be two saves with a window between them in which the process is
    // about to be replaced.
    //
    // Clearing the stored notice BEFORE the restart, not after — `restart()`
    // never returns, so anything sequenced behind it does not run. A stored
    // 0.9.0 met by a relaunched 0.9.0 is the stale-notice bug exactly: the
    // not-due launch branch and the tray seed would repaint the notice from it
    // for up to a day. The read side filters that shape now (`notice_for`);
    // this keeps the STORED fact honest, which is what `check_on_launch`'s own
    // comment already demanded of a check that found nothing newer. Added
    // 2026-09-18, matching the sibling app — this app shipped without it.
    //
    // `None` where the person unticked the agent row: no marker, no phase 2,
    // and the new build simply offers what it ships.
    let _ = app.state::<SettingsState>().update(|s| {
        s.last_update_version = None;
        s.pending_bundled_install = marker;
    });

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
        .user_agent(concat!("SubshellClientDesktop/", env!("CARGO_PKG_VERSION")))
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
            // survives (a hand-replaced bundle never clears the field).
            let stored = notice_for(
                &handle.package_info().version.to_string(),
                settings.get().last_update_version.as_deref(),
            );
            crate::tray::set_update_available(&handle, stored.as_deref());
            return;
        }
        // A check that could not REACH the source is not a check that found
        // nothing, and `.ok()` cannot tell them apart: `check_app_update`
        // deliberately returns `Ok` for an unreachable source and puts the
        // cause in `reason`. Stamping the clock on that answer would suppress
        // the next check for a day, and clearing `last_update_version` would
        // drop the tray notice for an update already found — one flaky launch
        // hiding a real release until tomorrow.
        let answered = check_app_update(&handle).await.ok().filter(|c| c.reason.is_none());
        let Some(check) = answered else {
            // Leave the stamp and the stored version exactly as they were, and
            // keep showing whatever the last check that DID answer found —
            // filtered through `notice_for`, since "found" here means a stored
            // value painted with no source consulted.
            let stored = notice_for(
                &handle.package_info().version.to_string(),
                settings.get().last_update_version.as_deref(),
            );
            crate::tray::set_update_available(&handle, stored.as_deref());
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
        crate::tray::set_update_available(&handle, found.as_deref());
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tag prefix is the release-component ID, and getting it wrong points
    /// this app at a different component's releases — which would parse and
    /// compare perfectly well, and offer the SERVER app's version as this
    /// app's update.
    #[test]
    fn the_prefix_is_this_components_own() {
        assert_eq!(TAG_PREFIX, "desktop-client-v");
        assert!(release_feed::parse_release_tag(TAG_PREFIX, "desktop-client-v1.2.3").is_some());
        assert!(release_feed::parse_release_tag(TAG_PREFIX, "desktop-server-v1.2.3").is_none());
        assert!(release_feed::parse_release_tag(TAG_PREFIX, "cli-node-v1.2.3").is_none());
    }

    #[test]
    fn the_release_page_link_names_this_repository_and_the_tag() {
        assert_eq!(
            release_page_url("desktop-client-v1.2.3"),
            "https://github.com/subshell-ai/subshell/releases/tag/desktop-client-v1.2.3"
        );
    }
}
