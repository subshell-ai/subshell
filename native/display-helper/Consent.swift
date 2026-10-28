import Foundation

/// Only the two consent acts change this preference, and they are reachable from
/// the panel and the status menu: `Runtime.enable()` stores the agreement and
/// `Runtime.disable()` clears it. A sign-in start only resumes what is already
/// stored, and its failure path stops the runtime without touching the flag.
/// Node RPC has no enable operation, and macOS permissions alone never imply
/// Subshell consent.
final class HelperConsent {
    private let defaults: UserDefaults
    // The default is `standard`, which for this bundled helper IS its own
    // domain (`dev.subshell.display-helper.plist`). Handing `suiteName:` the
    // app's own bundle identifier is not a no-op: Foundation rejects it, logs
    // "Using your own bundle identifier as an NSUserDefaults suite name does
    // not make sense and will not work", and returns nil. So the old
    // force-unwrap trapped (`EXC_BREAKPOINT`) inside `DisplayHelperApp.init`,
    // before any window or status item existed, and `open` still exited 0.
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    var enabled: Bool { defaults.bool(forKey: "enabled") }
    func setEnabled(_ enabled: Bool) { defaults.set(enabled, forKey: "enabled") }
}
