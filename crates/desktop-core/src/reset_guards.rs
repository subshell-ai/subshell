//! The pure guards a reset is safe because of, shared by both desktop apps.
//!
//! Each app has its own chain, its own delete plan and its own Tauri commands
//! — they wipe different things. What they must NOT have is two copies of
//! these four predicates. A containment guard that drifts between the apps is
//! a machine that deletes a binary the reset promised to keep, and the drift
//! would be invisible until it happened.
//!
//! `tauri`-free by construction, which is the rule for everything in this
//! crate, and what lets these be tested without a display or a webview.
//!
//! [`machine_hostname`] lives here rather than in either app because it is the
//! value [`consent_granted`] is compared against, and its fail-closed half —
//! an unreadable name memoizing to the empty string, which grants consent to
//! nothing — is the same rule stated twice if each app reads it for itself.

use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use crate::proc::run;

/// The shape rules every deletion target must pass: absolute, never the
/// filesystem root, never the home directory itself.
///
/// Pure over the spelling, deliberately — the containment question (does this
/// path hold the binary?) is [`delete_guard_ok`], and the chain canonicalizes
/// both sides before asking it (P3), because a prefix test between a symlinked
/// and a real spelling passes while the delete still reaches the binary.
pub fn path_rules_ok(p: &Path, home: &Path) -> bool {
    p.is_absolute() && p != Path::new("/") && p != home
}

/// Whether deleting `dir` recursively could reach `keep`. False when `dir`
/// IS `keep` or contains it. **Both arguments must be canonicalized by the
/// caller** (P3); a path that exists but cannot be canonicalized is handled
/// as a refusal at the call site, not here.
pub fn delete_guard_ok(dir: &Path, keep: &Path) -> bool {
    dir != keep && !keep.starts_with(dir)
}

/// Whether a tmux socket name is one this product created. Mirrors
/// `tmuxSocketFor` (`subshell-${hash}`) in pane-runtime — a kill must sweep
/// exactly our servers and never a tmux session belonging to anything else
/// on the machine. Pinned to the other side by containment below, the way
/// the installer table pins its TypeScript twin.
pub fn is_subshell_socket(name: &str) -> bool {
    name.starts_with("subshell-")
}

/// The consent comparison, pure so its fail-closed half is testable: a
/// non-empty memo must equal the trimmed typing, and the EMPTY memo (a
/// hostname read that failed) matches NOTHING — least of all the empty box
/// it used to arm. A wipe's only gate opens on a name, never on its absence.
pub fn consent_granted(typed: &str, memo: &str) -> bool {
    !memo.is_empty() && typed.trim() == memo
}

/// This machine's name, read ONCE and memoized.
///
/// Memoized so the consent comparison is two reads of one `OnceLock` rather
/// than a re-spawn that could race a rename mid-session into an instruction
/// nobody typed: the screen renders the same string the gate later checks.
///
/// The empty string means COULD NOT READ, and every consumer refuses on it —
/// see [`consent_granted`], whose whole fail-closed half exists for this
/// value. Returning a failed spawn's empty stdout as though it were the name
/// is what once made a wipe's only gate accept an empty box.
pub fn machine_hostname() -> String {
    static HOSTNAME: OnceLock<String> = OnceLock::new();
    HOSTNAME
        .get_or_init(|| {
            let r = run(&["hostname".to_string()], Duration::from_secs(5));
            if !r.ok() {
                return String::new();
            }
            r.stdout.trim().to_string()
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_layout_passes_and_an_ancestor_of_the_binary_does_not() {
        // R13 from both sides + R3's single keep path: the default install's
        // data dir EQUALS the config dir that holds config.env, and that is
        // legal; a data dir that would take the binary with it is not.
        let home = Path::new("/home/u");
        assert!(delete_guard_ok(
            Path::new("/home/u/.config/subshell-server"),
            Path::new("/home/u/.local/bin/subshell-server")
        ));
        assert!(!delete_guard_ok(
            Path::new("/home/u/.local"),
            Path::new("/home/u/.local/bin/subshell-server")
        ));
        assert!(!delete_guard_ok(
            Path::new("/home/u"),
            Path::new("/home/u/.local/bin/subshell-server")
        ));
        assert!(path_rules_ok(Path::new("/data"), home));
        assert!(!path_rules_ok(Path::new("/"), home));
        assert!(!path_rules_ok(Path::new("/home/u"), home));
        assert!(!path_rules_ok(Path::new("relative/path"), home));
    }

    #[test]
    fn an_unread_hostname_grants_consent_to_nothing_least_of_all_the_empty_box() {
        // The PR review's fail-open finding: `machine_hostname`'s memo is
        // empty when hostname(1) cannot run, and the old comparison accepted
        // the empty box it armed. The wipe's only gate opens on a name.
        assert!(!consent_granted("", ""));
        assert!(consent_granted("devbox", "devbox"));
        assert!(consent_granted("  devbox  ", "devbox")); // typing artifact, trimmed - the UX half
        assert!(!consent_granted("Devbox", "devbox")); // the compare is exact
        assert!(!consent_granted("devbox", "")); // a name never satisfies a failed read
    }

    #[test]
    fn socket_prefix_selects_only_this_products_servers() {
        // Mirrors tmuxSocketFor (`subshell-${hash}`) in pane-runtime; the
        // containment test below pins the pair like the installer table does.
        assert!(is_subshell_socket("subshell-0a1b2c3d4e5f"));
        assert!(!is_subshell_socket("0a1b2c3d4e5f"));
        assert!(!is_subshell_socket("mywork"));
        const RUNTIME: &str = include_str!("../../../packages/pane-runtime/src/tmux-runner.ts");
        assert!(
            RUNTIME.contains("`subshell-${hash}`"),
            "the prefix rule moved; update both sides"
        );
    }
}
