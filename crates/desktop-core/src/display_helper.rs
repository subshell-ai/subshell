//! The native menus and both assistants' Virtual Displays screens install the
//! same helper. Nothing calls this at startup.
//! Consent and permission prompts belong to the helper itself: its panel and its
//! status-menu toggle are the only doors, and neither is a page in this app.
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

/// The `-R` value for verifying the helper's designated requirement.
///
/// The leading `=` is not decoration: `codesign` reads an unprefixed `-R`
/// argument as a FILE to load requirements from, so a bare spec fails with
/// `"<the whole requirement>": No such file or directory` before the helper
/// ever opens. `=` says "this literal string is the requirement". Debug
/// builds drop the publisher anchor because dev bundles are ad-hoc signed.
fn requirement_test_arg(development: bool) -> String {
    if development {
        format!("=identifier \"{ID}\"")
    } else {
        format!("=anchor apple generic and identifier \"{ID}\" and certificate leaf[subject.OU] = \"DVRYX6BV6J\"")
    }
}

fn verify(bundle: &Path) -> Result<(), String> {
    // The outer desktop bundle authenticates its resource too. Verify the
    // standalone copy before reusing it, including its publisher in releases.
    let requirement = requirement_test_arg(cfg!(debug_assertions));
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
            return Err("A newer helper is bundled with this app. Choose Quit helper in the display helper's menu, then open these settings again to update it.".into());
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

/// The argv for reading a bundle's CDHash. The verbosity is load-bearing:
/// `codesign` prints `CDHash=` only from `-dvvv` up, and `-dvv` prints just
/// `Signature=` and friends, so the digest check below used to fail with
/// "Couldn't verify the display helper's code identity" on every press that
/// had an installed copy to compare against.
fn code_hash_argv(bundle: &str) -> [String; 3] {
    ["/usr/bin/codesign".into(), "-dvvv".into(), bundle.into()]
}

fn code_hash(bundle: &Path) -> Result<String, String> {
    let result = crate::proc::run(&code_hash_argv(path(bundle)?), Duration::from_secs(10));
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
    // A copy that fails its own signature check is a reason to replace it, not a
    // reason to lock the door. The bundled copy was verified by the caller, and
    // the staging below renames whatever is there to `previous.app` and keeps a
    // rollback; refusing here would strand both assistants' only way into the
    // helper settings behind a leftover from another identity, with no remedy
    // named and no rebuild that could repair it.
    if verify(installed).is_err() {
        return Ok(true);
    }
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

/// Called from a native menu selection or from either assistant's Virtual
/// Displays screen, which reach it through a command granted to the bundled page
/// only. Opening settings does not enable
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
        let result = staged_swap(&SwapSteps {
            copy: &|| run(&["/usr/bin/ditto", path(&bundled)?, path(&next)?]).map(|_| ()),
            verify: &|| verify(&next),
            move_aside: &|| {
                let had_previous = installed.exists();
                if had_previous {
                    fs::rename(&installed, &previous).map_err(|e| e.to_string())?;
                }
                Ok(had_previous)
            },
            promote: &|| fs::rename(&next, &installed).map_err(|e| e.to_string()),
            restore: &|| fs::rename(&previous, &installed).map_err(|e| e.to_string()),
        });
        // Keep a previous copy if rollback itself failed, rather than deleting it.
        if installed.exists() {
            let _ = fs::remove_dir_all(&staging);
        }
        result?;
    }
    run(&["/usr/bin/open", path(&installed)?, "--args", "--settings"]).map(|_| ())
}

/// The steps of the staged swap, injected so a test can fail each one and watch what
/// happens to the copy the person is already using.
struct SwapSteps<'a> {
    copy: &'a dyn Fn() -> Result<(), String>,
    verify: &'a dyn Fn() -> Result<(), String>,
    move_aside: &'a dyn Fn() -> Result<bool, String>,
    promote: &'a dyn Fn() -> Result<(), String>,
    restore: &'a dyn Fn() -> Result<(), String>,
}

/// Copy the bundle in, verify it, then swap it over the installed copy, putting the old
/// one back if the swap itself fails.
///
/// Two orders are the whole contract, and neither could be tested while they were inline
/// in the one function that performs them. An unverified copy must never become
/// `installed`: the staged one is a `ditto` of the bundle, and promoting a corrupt one
/// replaces the only helper the person has. And a promote that fails must restore the
/// previous copy exactly when there was one, which is the difference between a refused
/// update and a vanished install.
fn staged_swap(steps: &SwapSteps) -> Result<(), String> {
    (steps.copy)()?;
    (steps.verify)()?;
    let had_previous = (steps.move_aside)()?;
    if let Err(error) = (steps.promote)() {
        if had_previous {
            let _ = (steps.restore)();
        }
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::os::unix::fs::symlink;

    #[test]
    fn a_copy_that_does_not_verify_is_never_promoted() {
        // Delete the `verify` step from the transaction and every other test here stays
        // green, because the promote still happens: this is the only thing that says a
        // bundle the person cannot run never becomes their installed helper.
        let log = RefCell::new(Vec::new());
        let steps = SwapSteps {
            copy: &|| {
                log.borrow_mut().push("copy");
                Ok(())
            },
            verify: &|| {
                log.borrow_mut().push("verify");
                Err("bad signature".to_string())
            },
            move_aside: &|| {
                log.borrow_mut().push("aside");
                Ok(true)
            },
            promote: &|| {
                log.borrow_mut().push("promote");
                Ok(())
            },
            restore: &|| {
                log.borrow_mut().push("restore");
                Ok(())
            },
        };
        assert_eq!(staged_swap(&steps).unwrap_err(), "bad signature");
        assert_eq!(*log.borrow(), vec!["copy", "verify"]);
    }

    #[test]
    fn a_failed_promote_puts_the_previous_copy_back() {
        // Without the restore the person is left with no helper at all and a menu that
        // now opens nothing, which is why the rollback is asserted rather than trusted.
        let log = RefCell::new(Vec::new());
        let steps = SwapSteps {
            copy: &|| Ok(()),
            verify: &|| Ok(()),
            move_aside: &|| {
                log.borrow_mut().push("aside");
                Ok(true)
            },
            promote: &|| {
                log.borrow_mut().push("promote");
                Err("busy".to_string())
            },
            restore: &|| {
                log.borrow_mut().push("restore");
                Ok(())
            },
        };
        assert_eq!(staged_swap(&steps).unwrap_err(), "busy");
        assert_eq!(*log.borrow(), vec!["aside", "promote", "restore"]);
    }

    #[test]
    fn a_first_install_that_fails_to_promote_has_nothing_to_put_back() {
        // There was no previous copy, so a restore would rename a path that does not
        // exist, and the error the user is shown must stay the promote's own.
        let log = RefCell::new(Vec::new());
        let steps = SwapSteps {
            copy: &|| Ok(()),
            verify: &|| Ok(()),
            move_aside: &|| Ok(false),
            promote: &|| {
                log.borrow_mut().push("promote");
                Err("busy".to_string())
            },
            restore: &|| {
                log.borrow_mut().push("restore");
                Ok(())
            },
        };
        assert_eq!(staged_swap(&steps).unwrap_err(), "busy");
        assert!(!log.borrow().contains(&"restore"));
    }

    #[test]
    fn the_codesign_requirement_is_a_literal_not_a_filename() {
        // The original shipped without the `=` prefix and codesign read the
        // whole requirement as a file path, so no bundle ever verified and
        // "Open Display Helper settings" failed on every press.
        for development in [true, false] {
            let arg = requirement_test_arg(development);
            assert!(arg.starts_with("=identifier") || arg.starts_with("=anchor apple generic"));
            assert!(arg.contains(&format!("identifier \"{ID}\"")));
            assert_eq!(arg.contains("DVRYX6BV6J"), !development);
        }
    }

    #[test]
    fn the_digest_read_uses_the_verbosity_that_prints_cdhash() {
        // `-dvv` exits 0 but shows no `CDHash=` line, which read as a broken
        // code identity and blocked every settings press that had an
        // installed copy to compare. Only `-dvvv` and up emit it.
        let argv = code_hash_argv("/Applications/Subshell Display Helper.app");
        assert_eq!(argv[1], "-dvvv");
        assert_eq!(argv[2], "/Applications/Subshell Display Helper.app");
    }

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
    fn an_unverifiable_install_is_replaced_rather_than_locked_behind() {
        // The failure this guards: a stale or foreign copy under ~/Applications
        // that no longer satisfies its signature made every later press of
        // "Open Display Helper settings" fail with codesign's own words, even
        // though the app carries a verified bundle that would replace it.
        let directory = std::env::temp_dir().join(format!("subshell-helper-broken-{}", std::process::id()));
        fs::create_dir_all(directory.join(BUNDLE).join("Contents")).unwrap();
        fs::write(
            directory.join(BUNDLE).join("Contents/Info.plist"),
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>dev.subshell.display-helper</string><key>CFBundleVersion</key><string>9.9.9</string></dict></plist>\n",
        )
        .unwrap();
        let installed = directory.join(BUNDLE);
        assert!(
            replacement_needed(Path::new("/unused"), "1.0.0", &installed).unwrap(),
            "a copy that fails verification must be replaced, not reported as an error"
        );
        assert!(
            fs::symlink_metadata(&installed).is_ok(),
            "the decision alone touches nothing"
        );
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
