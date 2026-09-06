//! The `subshell-server` this app ships, and putting it somewhere the service
//! manager can point at.
//!
//! The bundle is signature-sealed and disappears when the app is uninstalled,
//! while `apps/server/src/service.ts` writes an ABSOLUTE `ExecStart=` /
//! `ProgramArguments` into the unit or plist. A service pointing inside
//! `Subshell.app` would break the moment the app is moved, replaced or
//! removed — so the shipped binary is materialised at a stable path the
//! server owns, and the service points there.
//!
//! Three things make the copy less trivial than it looks, and all three only
//! bite on the UPGRADE path, which is the one that matters:
//!
//! - On Linux, writing to a file that is currently being executed is
//!   `ETXTBSY`. Writing in place fails exactly when a server is running.
//! - On macOS, overwriting a running signed binary invalidates its signature
//!   and the kernel SIGKILLs it.
//! - A bundle delivered by a browser carries `com.apple.quarantine` on its
//!   nested executables, and `std::fs::copy` preserves it. A quarantined loose
//!   binary needs an online Gatekeeper check that a bare Mach-O cannot satisfy
//!   from the `.app`'s staple — so launchd loads the job and the exec fails
//!   QUIETLY.
//!
//! Hence: stop the service, write a temp file in the SAME directory, chmod,
//! `rename(2)` over the target, then strip the xattr.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::proc::run;
use crate::shell_env::home_dir;

/// The sidecar's name inside the bundle. Tauri STRIPS the `-<target-triple>`
/// suffix that the staged file carries, so this is not the same string as the
/// one the release script writes — see `desktopSidecarFileName` in
/// `packages/subshell-protocol/src/paths.ts`.
pub const BUNDLED_SIDECAR_NAME: &str = "subshell-server-bundled";

/// Where the bundled server sits at runtime.
///
/// `externalBin` lands beside the app executable on both targets we ship:
/// `Subshell.app/Contents/MacOS/` on macOS and `/usr/bin/` in the `.deb`
/// (NOT `/usr/lib/<product>/`, which is where `resources` go). In
/// `tauri dev` it is beside the debug binary. One sibling rule covers all three,
/// which is why this needs no path-resolution API and no shell plugin.
pub fn bundled_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidate = dir.join(BUNDLED_SIDECAR_NAME);
    candidate.is_file().then_some(candidate)
}

/// The stable path the bundled server is installed to.
pub fn install_path() -> Option<PathBuf> {
    home_dir().map(|h| PathBuf::from(h).join(".local/bin/subshell-server"))
}

/// Why an install was or was not needed.
#[derive(Debug, PartialEq, Eq)]
pub enum InstallOutcome {
    /// The installed copy already matches the bundled one.
    UpToDate,
    /// The bundled copy was written to the install path.
    Installed,
    /// Nothing to install — this build carries no sidecar (a dev run without a staged binary).
    NoSidecar,
}

/// Whether the file at `dest` already IS the bundled binary.
///
/// Size plus reported version rather than a content hash: the bundled binary is
/// ~100 MB and this runs on every cold start, where a full hash would be a
/// visible pause for an answer that is almost always "yes". Size catches every
/// real version change, and the version string catches a same-size rebuild.
fn already_installed(bundled: &Path, dest: &Path, bundled_version: Option<&str>) -> bool {
    let (Ok(a), Ok(b)) = (fs::metadata(bundled), fs::metadata(dest)) else {
        return false;
    };
    if a.len() != b.len() {
        return false;
    }
    match bundled_version {
        None => true,
        Some(want) => {
            let out = run(&[dest.to_string_lossy().into_owned(), "version".into()], Duration::from_secs(15));
            out.ok() && out.stdout.trim().ends_with(want)
        }
    }
}

/// Copy the bundled server to its stable path, atomically.
///
/// `stop_first` is invoked before the swap when an install is actually needed —
/// the caller passes something that takes the service down, because replacing a
/// running binary is the failure this function exists to avoid.
pub fn install_bundled(
    bundled_version: Option<&str>,
    stop_first: impl FnOnce(),
) -> Result<InstallOutcome, String> {
    let Some(bundled) = bundled_path() else {
        return Ok(InstallOutcome::NoSidecar);
    };
    let dest = install_path().ok_or_else(|| "no HOME to install into".to_string())?;

    if already_installed(&bundled, &dest, bundled_version) {
        return Ok(InstallOutcome::UpToDate);
    }

    let dir = dest.parent().ok_or_else(|| "install path has no parent".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    stop_first();

    // Temp file in the SAME directory: rename(2) is only atomic within one
    // filesystem, and /tmp is frequently a different one.
    let tmp = dir.join(format!("subshell-server.tmp-{}", std::process::id()));
    let _ = fs::remove_file(&tmp);
    fs::copy(&bundled, &tmp).map_err(|e| format!("could not stage {}: {e}", tmp.display()))?;
    set_executable(&tmp)?;
    // Strip quarantine BEFORE the rename so the file is never briefly live and
    // quarantined at the path launchd is about to exec.
    strip_quarantine(&tmp);
    fs::rename(&tmp, &dest).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("could not install {}: {e}", dest.display())
    })?;
    Ok(InstallOutcome::Installed)
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("could not chmod {}: {e}", path.display()))
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Remove `com.apple.quarantine`, tolerating its absence.
///
/// Unconditional on macOS: a `.tar.gz` extracted with CLI `tar` usually carries
/// no quarantine, but a bundle the user downloaded through a browser does, and
/// the failure it causes is silent.
fn strip_quarantine(path: &Path) {
    if cfg!(target_os = "macos") {
        let _ = run(
            &["/usr/bin/xattr".into(), "-d".into(), "com.apple.quarantine".into(), path.to_string_lossy().into_owned()],
            Duration::from_secs(10),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_path_is_under_local_bin() {
        if let Some(p) = install_path() {
            assert!(p.ends_with(".local/bin/subshell-server"), "{}", p.display());
        }
    }

    // The in-bundle name has NO triple suffix: tauri-build and tauri-bundler
    // both strip it on copy, so anything looking for the staged filename inside
    // a built app finds nothing.
    #[test]
    fn bundled_name_carries_no_target_triple() {
        assert_eq!(BUNDLED_SIDECAR_NAME, "subshell-server-bundled");
        assert!(!BUNDLED_SIDECAR_NAME.contains("apple-darwin"));
        assert!(!BUNDLED_SIDECAR_NAME.contains("unknown-linux"));
    }

    #[test]
    fn a_build_with_no_sidecar_is_not_an_error() {
        if bundled_path().is_none() {
            let mut stopped = false;
            let outcome = install_bundled(None, || stopped = true).expect("must not error");
            assert_eq!(outcome, InstallOutcome::NoSidecar);
            // Nothing was torn down for an install that never happened.
            assert!(!stopped);
        }
    }

    #[test]
    fn differing_sizes_are_never_up_to_date() {
        let dir = std::env::temp_dir().join(format!("subshell-sidecar-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let (a, b) = (dir.join("a"), dir.join("b"));
        fs::write(&a, b"aaaa").unwrap();
        fs::write(&b, b"aa").unwrap();
        assert!(!already_installed(&a, &b, None));
        // Same bytes, no version demanded -> nothing to do.
        fs::write(&b, b"aaaa").unwrap();
        assert!(already_installed(&a, &b, None));
        let _ = fs::remove_dir_all(&dir);
    }
}
