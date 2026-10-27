import AppKit

@MainActor
final class DisplayHelperApp: NSObject, NSApplicationDelegate {
    private let consent = HelperConsent()
    private lazy var runtime = HelperRuntime(consent: consent)
    private lazy var settings = HelperSettings(consent: consent,
        enable: { [weak self] in try self?.runtime.enable() }, disable: { [weak self] in self?.runtime.disable() },
        accessCount: { [weak self] in self?.runtime.viewers ?? 0 })
    private var statusItem: NSStatusItem?
    private var installLock: Int32 = -1
    private var started = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Hold the install lock even while disabled: another desktop app must
        // never replace the executable behind macOS's running permission owner.
        do {
            try FileManager.default.createDirectory(at: HelperListener.directory, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            installLock = open(HelperListener.directory.appendingPathComponent("install.lock").path,
                               O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
            guard installLock >= 0, flock(installLock, LOCK_EX | LOCK_NB) == 0 else {
                NSApp.terminate(nil); return
            }
        } catch { NSApp.terminate(nil); return }
        // Neither install nor a node request can opt in. Login resumes only
        // the consent the person previously gave in this native panel.
        do { try runtime.listenForStatus() } catch { NSApp.terminate(nil); return }
        started = true
        runtime.onStateChange = { [weak self] in self?.updateMenu() }
        settings.onVisibilityChange = { [weak self] in self?.updateMenu() }
        if consent.enabled {
            do { try runtime.enable() }
            catch { runtime.disable() }
        }
        updateMenu()
        if CommandLine.arguments.contains("--settings") { settings.show() }
        else if !consent.enabled { NSApp.terminate(nil) }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        settings.show(); return false
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Keep explicit consent across a normal logout; the next login may
        // resume it. Closing the listener tears down every capture and key.
        guard started else { return }
        runtime.shutdown()
        // A viewer may have left the pointer on a virtual display this quit
        // ends; do not hand the person at the Mac a missing cursor.
        restoreStrandedCursor()
    }

    private func updateMenu() {
        if statusItem == nil {
            statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            statusItem?.button?.image = NSImage(systemSymbolName: "display", accessibilityDescription: "Subshell virtual display helper")
        }
        let viewers = runtime.viewers
        let menu = NSMenu()
        menu.autoenablesItems = false
        // The item in the bar is an icon. Opening the menu without a word about
        // what it belongs to left people guessing, so the menu says its name.
        let heading = NSMenuItem(title: AccessReport.heading, action: nil, keyEquivalent: "")
        heading.isEnabled = false; menu.addItem(heading)
        menu.addItem(.separator())
        let settingsItem = NSMenuItem(title: "Settings…", action: #selector(showSettings), keyEquivalent: "")
        settingsItem.target = self; menu.addItem(settingsItem)
        let minimize = NSMenuItem(title: "Minimize helper", action: #selector(minimizeSettings), keyEquivalent: "m")
        minimize.target = self; minimize.isEnabled = settings.isShowing; menu.addItem(minimize)
        let disable = NSMenuItem(title: "Disable helper", action: #selector(disableHelper), keyEquivalent: "")
        disable.target = self; disable.isEnabled = consent.enabled; menu.addItem(disable)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit helper", action: #selector(quitHelper), keyEquivalent: "")
        quit.target = self; menu.addItem(quit)
        statusItem?.menu = menu
        statusItem?.button?.toolTip = AccessReport.tooltip(enabled: consent.enabled, viewers: viewers)
        // Someone is watching a screen: the icon takes the warning gold and
        // gains a dot, so the awareness survives a click elsewhere on the
        // menu bar and does not depend on reading the tooltip.
        statusItem?.button?.contentTintColor = viewers > 0 ? Theme.warning : nil
        statusItem?.button?.attributedTitle = viewers > 0
            ? NSAttributedString(string: " ●", attributes: [
                .foregroundColor: Theme.warning,
                .font: NSFont.systemFont(ofSize: 9),
            ])
            : NSAttributedString(string: "")
        settings.refresh()
    }

    @objc private func showSettings() { settings.show() }
    @objc private func minimizeSettings() { settings.minimize() }
    @objc private func disableHelper() { settings.disableHelper(); settings.show() }
    @objc private func quitHelper() { settings.disableHelper(); NSApp.terminate(nil) }
}

umask(0o077)
MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = DisplayHelperApp()
    app.delegate = delegate
    app.run()
}
