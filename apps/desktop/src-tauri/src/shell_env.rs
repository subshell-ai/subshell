//! The PATH a GUI app does not have.
//!
//! A `.app` launched from Finder (or a `.deb`'s desktop entry) inherits
//! launchd's / the session manager's minimal PATH — `/usr/bin:/bin:/usr/sbin:/sbin`
//! — with no `/opt/homebrew/bin` and no `~/.local/bin`. That matters twice on
//! the way to a working server, and both failures land far from the cause:
//!
//! 1. `subshell-server service install` runs a tmux preflight through an
//!    injected `which`, so a Homebrew tmux is simply "not found".
//! 2. The unit it writes bakes `Environment=PATH=` from the installing
//!    process's PATH, so even a successful install produces a service that
//!    cannot find tmux later, and every pane launch fails.
//!
//! So every `subshell-server` spawn gets a login shell's PATH, resolved once.

use std::process::Command;
use std::sync::OnceLock;

static LOGIN_PATH: OnceLock<String> = OnceLock::new();

/// PATH entries always worth having, whatever the login shell reports.
const FLOOR: &[&str] = &[
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

/// The user's login shell, from the password database rather than `$SHELL`
/// (which a GUI launch does not necessarily set).
fn login_shell() -> String {
    if let Ok(out) = Command::new("dscl")
        .args([".", "-read", &format!("/Users/{}", whoami()), "UserShell"])
        .output()
    {
        if out.status.success() {
            if let Some(sh) = String::from_utf8_lossy(&out.stdout).split_whitespace().nth(1) {
                return sh.to_string();
            }
        }
    }
    if let Ok(out) = Command::new("getent").args(["passwd", &whoami()]).output() {
        if out.status.success() {
            if let Some(sh) = String::from_utf8_lossy(&out.stdout).trim_end().rsplit(':').next() {
                if !sh.is_empty() {
                    return sh.to_string();
                }
            }
        }
    }
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
}

fn whoami() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .unwrap_or_default()
}

/// Ask a login shell what PATH it would give an interactive session.
fn probe_login_path() -> Option<String> {
    let shell = login_shell();
    let out = Command::new(&shell).args(["-l", "-c", "printf %s \"$PATH\""]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

/// Merge the probed PATH with {@link FLOOR} and `~/.local/bin`, preserving the
/// probe's own ordering and dropping duplicates.
fn build_path() -> String {
    let mut seen: Vec<String> = Vec::new();
    let mut push = |entry: &str| {
        if !entry.is_empty() && !seen.iter().any(|e| e == entry) {
            seen.push(entry.to_string());
        }
    };
    if let Some(probed) = probe_login_path() {
        for entry in probed.split(':') {
            push(entry);
        }
    } else if let Ok(inherited) = std::env::var("PATH") {
        for entry in inherited.split(':') {
            push(entry);
        }
    }
    if let Some(home) = home_dir() {
        push(&format!("{home}/.local/bin"));
    }
    for entry in FLOOR {
        push(entry);
    }
    seen.join(":")
}

/// The PATH to hand every `subshell-server` spawn. Resolved once per process —
/// spawning a login shell is not free, and the answer cannot change underneath us.
pub fn login_path() -> &'static str {
    LOGIN_PATH.get_or_init(build_path)
}

/// `$HOME`, or `None` when the environment does not name one.
pub fn home_dir() -> Option<String> {
    std::env::var("HOME").ok().filter(|h| !h.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_path_contains_the_floor() {
        let path = login_path();
        for entry in ["/usr/bin", "/bin"] {
            assert!(path.split(':').any(|p| p == entry), "missing {entry} in {path}");
        }
    }

    #[test]
    fn login_path_has_no_duplicates() {
        let path = login_path();
        let mut entries: Vec<&str> = path.split(':').collect();
        let before = entries.len();
        entries.sort_unstable();
        entries.dedup();
        assert_eq!(before, entries.len(), "duplicate PATH entries in {path}");
    }

    #[test]
    fn login_path_includes_user_local_bin() {
        if let Some(home) = home_dir() {
            let want = format!("{home}/.local/bin");
            assert!(login_path().split(':').any(|p| p == want));
        }
    }
}
