import Foundation

/// Only the native settings panel changes this preference. Node RPC has no
/// enable operation; macOS permissions alone never imply Subshell consent.
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
