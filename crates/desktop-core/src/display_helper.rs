//! The two native menus install the same helper. Nothing calls this at startup.
//! Consent and permission prompts belong to the helper's own native panel.
use std::fs::{self, File, OpenOptions};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::Path;
use std::time::Duration;

const BUNDLE: &str = "Subshell Display Helper.app";
const ID: &str = "dev.subshell.display-helper";

fn run(args: &[&str]) -> Result<String, String> {
    let args = args.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    let result = crate::proc::run(&args, Duration::from_secs(30));
    if result.ok() {
        Ok(result.stdout)
    } else {
        Err(result.detail())
    }
}

fn path(path: &Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| "The helper's path isn't valid UTF-8.".into())
}

fn version(bundle: &Path) -> Result<String, String> {
    let plist = bundle.join("Contents/Info.plist");
    let id = run(&[
        "/usr/libexec/PlistBuddy",
        "-c",
        "Print :CFBundleIdentifier",
        path(&plist)?,
    ])?;
    if id.trim() != ID {
        return Err("The installed display helper has an unexpected identity.".into());
    }
    let version = run(&["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleVersion", path(&plist)?])?;
    let version = version.trim();
    if version.split('.').count() != 3 || !version.split('.').all(|part| part.parse::<u32>().is_ok()) {
        return Err("The display helper has an invalid version.".into());
    }
    Ok(version.into())
}

fn verify(bundle: &Path) -> Result<(), String> {
    // The outer desktop bundle authenticates its resource too. Verify the
    // standalone copy before reusing it, including its publisher in releases.
    let requirement = if cfg!(debug_assertions) {
        format!("identifier \"{ID}\"")
    } else {
        format!("anchor apple generic and identifier \"{ID}\" and certificate leaf[subject.OU] = \"DVRYX6BV6J\"")
    };
    run(&[
        "/usr/bin/codesign",
        "--verify",
        "--strict",
        "-R",
        &requirement,
        path(bundle)?,
    ])
    .map(|_| ())
}

struct InstallLock(File);
impl InstallLock {
    fn acquire(directory: &Path) -> Result<Self, String> {
        fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(directory.join("install.lock"))
            .map_err(|e| e.to_string())?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("A newer helper is bundled with this app. Choose Quit Helper in the display helper's menu, then open these settings again to update it.".into());
        }
        Ok(Self(file))
    }
}
impl Drop for InstallLock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

fn code_hash(bundle: &Path) -> Result<String, String> {
    let result = crate::proc::run(
        &["/usr/bin/codesign".into(), "-dvv".into(), path(bundle)?.into()],
        Duration::from_secs(10),
    );
    if !result.ok() {
        return Err(result.detail());
    }
    let hash = result
        .stderr
        .lines()
        .find_map(|line| line.strip_prefix("CDHash="))
        .filter(|hash| hash.len() == 40 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| "Couldn't verify the display helper's code identity.".to_owned())?;
    Ok(hash.to_owned())
}

fn replacement_needed(bundled: &Path, bundled_version: &str, installed: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(installed) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error.to_string()),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(
                "The display helper installation is a symbolic link. Move it aside before opening these settings."
                    .into(),
            )
        }
        _ => {}
    }
    verify(installed)?;
    let installed_version = version(installed)?;
    if !may_replace_version(bundled_version, &installed_version, cfg!(debug_assertions)) {
        return Ok(false);
    }
    Ok(bundled_version != installed_version || code_hash(bundled)? != code_hash(installed)?)
}

// Helper versions are shared by both apps and advance independently of either
// app's release version. Equal-version release bundles must never flip-flop.
fn may_replace_version(bundled: &str, installed: &str, development: bool) -> bool {
    crate::version::version_lt(installed, bundled) || (development && bundled == installed)
}

/// Called only from a native menu selection. Opening settings does not enable
/// capture, input, login registration, or a node's virtual display setting.
pub fn open_settings(resource_dir: &Path, home: &Path) -> Result<(), String> {
    let bundled = if resource_dir.file_name().is_some_and(|name| name == "Resources") {
        resource_dir
            .parent()
            .ok_or("Missing desktop bundle directory")?
            .join("Helpers")
            .join(BUNDLE)
    } else if cfg!(debug_assertions) {
        // Tauri dev uses the Cargo output directory, before an outer .app exists.
        resource_dir.join(BUNDLE)
    } else {
        return Err("Couldn't locate the bundled display helper.".into());
    };
    verify(&bundled)?;
    let bundled_version = version(&bundled)?;
    let applications = home.join("Applications");
    let installed = applications.join(BUNDLE);
    if replacement_needed(&bundled, &bundled_version, &installed)? {
        let _lock = match InstallLock::acquire(&home.join("Library/Caches/Subshell/display-helper")) {
            Ok(lock) => lock,
            // An update must never block the route to Disable. Keep using the
            // verified running copy; the next menu open after Quit can update.
            Err(_) if installed.exists() => {
                return run(&["/usr/bin/open", path(&installed)?, "--args", "--settings"]).map(|_| ())
            }
            Err(error) => return Err(error),
        };
        // Another app may have installed a newer copy while this menu was opening.
        if !replacement_needed(&bundled, &bundled_version, &installed)? {
            drop(_lock);
            return run(&["/usr/bin/open", path(&installed)?, "--args", "--settings"]).map(|_| ());
        }
        fs::create_dir_all(&applications).map_err(|e| e.to_string())?;
        let staging = applications.join(format!(".subshell-display-helper-{}", std::process::id()));
        // Never overwrite an unknown staging directory left by another run.
        fs::create_dir(&staging).map_err(|e| e.to_string())?;
        let next = staging.join(BUNDLE);
        let previous = staging.join("previous.app");
        let result = (|| {
            run(&["/usr/bin/ditto", path(&bundled)?, path(&next)?])?;
            verify(&next)?;
            let had_previous = installed.exists();
            if had_previous {
                fs::rename(&installed, &previous).map_err(|e| e.to_string())?;
            }
            if let Err(error) = fs::rename(&next, &installed) {
                if had_previous {
                    let _ = fs::rename(&previous, &installed);
                }
                return Err(error.to_string());
            }
            Ok(())
        })();
        // Keep a previous copy if rollback itself failed, rather than deleting it.
        if installed.exists() {
            let _ = fs::remove_dir_all(&staging);
        }
        result?;
    }
    run(&["/usr/bin/open", path(&installed)?, "--args", "--settings"]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn release_updates_require_a_newer_shared_helper_version() {
        assert!(!may_replace_version("1.0.0", "1.0.0", false));
        assert!(!may_replace_version("1.0.0", "1.0.1", false));
        assert!(may_replace_version("1.0.1", "1.0.0", false));
        assert!(may_replace_version("1.0.0", "1.0.0", true));
        assert!(!may_replace_version("1.0.0", "1.0.1", true));
    }

    #[test]
    fn another_install_or_running_helper_blocks_replacement() {
        let directory = std::env::temp_dir().join(format!("subshell-helper-lock-{}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        let first = InstallLock::acquire(&directory).unwrap();
        assert!(InstallLock::acquire(&directory).is_err());
        drop(first);
        let next = InstallLock::acquire(&directory).unwrap();
        drop(next);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_symlink_install_is_never_followed_or_replaced() {
        let directory = std::env::temp_dir().join(format!("subshell-helper-link-{}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        let installed = directory.join(BUNDLE);
        symlink("/does/not/exist", &installed).unwrap();
        assert!(replacement_needed(Path::new("/unused"), "1.0.0", &installed)
            .unwrap_err()
            .contains("symbolic link"));
        assert!(fs::symlink_metadata(&installed).unwrap().file_type().is_symlink());
        fs::remove_dir_all(directory).unwrap();
    }
}
