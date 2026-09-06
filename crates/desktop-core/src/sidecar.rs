//! The binary a desktop app ships, and putting it somewhere the service
//! manager can point at.
//!
//! The bundle is signature-sealed and disappears when the app is uninstalled,
//! while the CLI it installs writes an ABSOLUTE `ExecStart=` /
//! `ProgramArguments` into the unit or plist. A service pointing inside
//! `Subshell.app` would break the moment the app is moved, replaced or
//! removed — so the shipped binary is materialised at a stable path outside
//! the bundle, and the service points there.
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
//!
//! All of that is true of any binary an app of this shape ships. The NAMES are
//! not, so they arrive in a [`SidecarSpec`].

use std::fs;
use std::path::{Path, PathBuf};

use crate::proc::{run, PROBE_TIMEOUT, QUERY_TIMEOUT};
use crate::shell_env::home_dir;

/// What one app's shipped binary is called, and how it announces itself.
///
/// Every field is a string the install dance would otherwise hard-code, and
/// each is per-app: `apps/desktop-server` ships a `subshell-server`,
/// `apps/desktop-client` a `subshell` node agent.
#[derive(Debug, Clone, Copy)]
pub struct SidecarSpec {
    /// The sidecar's name INSIDE the bundle.
    ///
    /// Tauri strips the `-<target-triple>` suffix that the staged file carries,
    /// so this is not the same string as the one the release script writes —
    /// see `desktopSidecarFileName` in `packages/subshell-protocol/src/paths.ts`.
    /// Anything grepping for the staged name inside a built bundle finds
    /// nothing, 100% of the time.
    pub bundled_name: &'static str,
    /// The file name the bundled binary is installed under in `~/.local/bin`.
    pub installed_name: &'static str,
    /// What the binary's `version` line starts with, including its trailing
    /// space — `"subshell-server "` for the server, `"subshell "` for the node
    /// agent, whose line then continues `(node protocol vN)`.
    pub version_prefix: &'static str,
}

/// The version out of a `<binary> version` line.
///
/// One parser, every caller (a resolution ladder, the bundled probe, the
/// already-installed check). They were three subtly different string dances,
/// one of which was an `ends_with` that would accept `11.8.0` for `1.8.0`.
///
/// The FIRST whitespace-delimited token after the prefix, not the rest of the
/// line: `subshell-server 1.8.0` and `subshell 1.8.0 (node protocol v1)` both
/// have to answer `1.8.0`, and a version carrying a parenthetical is not a
/// version anything can compare or display.
pub fn parse_version_line(stdout: &str, prefix: &str) -> Option<String> {
    let line = stdout.lines().next()?.trim();
    let rest = line.strip_prefix(prefix)?;
    rest.split_whitespace().next().map(str::to_string)
}

/// Where the bundled binary sits at runtime.
///
/// `externalBin` lands beside the app executable on both targets we ship:
/// `Subshell.app/Contents/MacOS/` on macOS and `/usr/bin/` in the `.deb`
/// (NOT `/usr/lib/<product>/`, which is where `resources` go). In
/// `tauri dev` it is beside the debug binary. One sibling rule covers all three,
/// which is why this needs no path-resolution API and no shell plugin.
pub fn bundled_path(spec: &SidecarSpec) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidate = dir.join(spec.bundled_name);
    candidate.is_file().then_some(candidate)
}

/// The stable path the bundled binary is installed to.
pub fn install_path(spec: &SidecarSpec) -> Option<PathBuf> {
    home_dir().map(|h| PathBuf::from(h).join(format!(".local/bin/{}", spec.installed_name)))
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
fn already_installed(spec: &SidecarSpec, bundled: &Path, dest: &Path, bundled_version: Option<&str>) -> bool {
    let (Ok(a), Ok(b)) = (fs::metadata(bundled), fs::metadata(dest)) else {
        return false;
    };
    if a.len() != b.len() {
        return false;
    }
    match bundled_version {
        // Cannot verify what we would be installing, so do not claim the
        // installed copy matches it.
        None => false,
        Some(want) => {
            let out = run(&[dest.to_string_lossy().into_owned(), "version".into()], QUERY_TIMEOUT);
            // `==`, not `ends_with`: the latter accepts "11.8.0" for "1.8.0".
            out.ok() && parse_version_line(&out.stdout, spec.version_prefix).as_deref() == Some(want)
        }
    }
}

/// Copy the bundled binary to its stable path, atomically.
///
/// `stop_first` is invoked before the swap when an install is actually needed —
/// the caller passes something that takes the service down, because replacing a
/// running binary is the failure this function exists to avoid.
pub fn install_bundled(
    spec: &SidecarSpec,
    bundled_version: Option<&str>,
    stop_first: impl FnOnce(),
) -> Result<InstallOutcome, String> {
    let Some(bundled) = bundled_path(spec) else {
        return Ok(InstallOutcome::NoSidecar);
    };
    let dest = install_path(spec).ok_or_else(|| "no HOME to install into".to_string())?;

    if already_installed(spec, &bundled, &dest, bundled_version) {
        return Ok(InstallOutcome::UpToDate);
    }

    let dir = dest.parent().ok_or_else(|| "install path has no parent".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    stop_first();

    // Temp file in the SAME directory: rename(2) is only atomic within one
    // filesystem, and /tmp is frequently a different one.
    let tmp = dir.join(format!("{}.tmp-{}", spec.installed_name, std::process::id()));
    let _ = fs::remove_file(&tmp);
    fs::copy(&bundled, &tmp).map_err(|e| format!("could not stage {}: {e}", tmp.display()))?;
    set_executable(&tmp)?;
    // Strip quarantine BEFORE the fsync and the rename, so the file is never
    // briefly live and quarantined at the path launchd is about to exec.
    strip_quarantine(&tmp);
    // rename(2) makes the swap atomic against a CONCURRENT reader, but not
    // against a crash: without this, a power loss between the rename and the
    // writeback can leave the new name pointing at a zero-length file, which
    // is an unbootable server that looks installed.
    fs::File::open(&tmp)
        .and_then(|f| f.sync_all())
        .map_err(|e| format!("could not flush {}: {e}", tmp.display()))?;
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
            &[
                "/usr/bin/xattr".into(),
                "-d".into(),
                "com.apple.quarantine".into(),
                path.to_string_lossy().into_owned(),
            ],
            PROBE_TIMEOUT,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_SPEC: SidecarSpec = SidecarSpec {
        bundled_name: "example-bundled",
        installed_name: "example",
        version_prefix: "example ",
    };

    #[test]
    fn install_path_is_under_local_bin() {
        if let Some(p) = install_path(&TEST_SPEC) {
            assert!(p.ends_with(".local/bin/example"), "{}", p.display());
        }
    }

    // Two apps installing under one name would each overwrite the other's
    // binary — the reason the name is a parameter rather than a constant.
    #[test]
    fn different_specs_install_to_different_paths() {
        let other = SidecarSpec {
            installed_name: "other",
            ..TEST_SPEC
        };
        let (Some(a), Some(b)) = (install_path(&TEST_SPEC), install_path(&other)) else {
            return;
        };
        assert_ne!(a, b);
    }

    #[test]
    fn a_build_with_no_sidecar_is_not_an_error() {
        if bundled_path(&TEST_SPEC).is_none() {
            let mut stopped = false;
            let outcome = install_bundled(&TEST_SPEC, None, || stopped = true).expect("must not error");
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
        assert!(!already_installed(&TEST_SPEC, &a, &b, Some("1.8.0")));
        let _ = fs::remove_dir_all(&dir);
    }

    // Not knowing what we would install is not evidence that it is already
    // installed — the answer must be "reinstall", not "skip".
    #[test]
    fn an_unverifiable_bundled_version_is_never_up_to_date() {
        let dir = std::env::temp_dir().join(format!("subshell-sidecar-unver-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let (a, b) = (dir.join("a"), dir.join("b"));
        fs::write(&a, b"same").unwrap();
        fs::write(&b, b"same").unwrap();
        assert!(!already_installed(&TEST_SPEC, &a, &b, None));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_destination_is_never_up_to_date() {
        let dir = std::env::temp_dir().join(format!("subshell-sidecar-missing-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a");
        fs::write(&a, b"same").unwrap();
        assert!(!already_installed(&TEST_SPEC, &a, &dir.join("nope"), Some("1.8.0")));
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod version_line_tests {
    use super::*;

    #[test]
    fn reads_the_version_off_the_first_line() {
        assert_eq!(
            parse_version_line("subshell-server 1.8.0\n", "subshell-server "),
            Some("1.8.0".into())
        );
        assert_eq!(
            parse_version_line("subshell-server 1.8.0", "subshell-server "),
            Some("1.8.0".into())
        );
    }

    // The node agent prints `subshell <version> (node protocol vN)`. Returning
    // the rest of the line would make the "version" a sentence — comparable to
    // nothing and displayable nowhere.
    #[test]
    fn stops_at_the_version_token() {
        assert_eq!(
            parse_version_line("subshell 1.2.3 (node protocol v1)\n", "subshell "),
            Some("1.2.3".into())
        );
    }

    #[test]
    fn refuses_anything_that_is_not_that_line() {
        assert_eq!(parse_version_line("", "subshell-server "), None);
        assert_eq!(parse_version_line("subshell 1.8.0", "subshell-server "), None);
        assert_eq!(parse_version_line("subshell-server ", "subshell-server "), None);
        assert_eq!(parse_version_line("bash: command not found", "subshell-server "), None);
    }

    // The two apps' prefixes overlap — every `subshell-server` line also starts
    // with `subshell` — so the trailing space in a prefix is load-bearing, not
    // formatting. Without it `subshell` matches `subshell-server 1.8.0` and the
    // "version" comes back as `-server`.
    #[test]
    fn the_trailing_space_in_a_prefix_is_load_bearing() {
        assert_eq!(parse_version_line("subshell-server 1.8.0", "subshell "), None);
        assert_eq!(
            parse_version_line("subshell-server 1.8.0", "subshell"),
            Some("-server".into())
        );
    }
}
