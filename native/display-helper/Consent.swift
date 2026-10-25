import Foundation

/// Only the native settings panel changes this preference. Node RPC has no
/// enable operation; macOS permissions alone never imply Subshell consent.
final class HelperConsent {
    static let bundleID = "dev.subshell.display-helper"
    private let defaults: UserDefaults
    init(defaults: UserDefaults = UserDefaults(suiteName: bundleID)!) { self.defaults = defaults }
    var enabled: Bool { defaults.bool(forKey: "enabled") }
    func setEnabled(_ enabled: Bool) { defaults.set(enabled, forKey: "enabled") }
}
