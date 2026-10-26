import AppKit

@MainActor
final class DisplayHelperApp: NSObject, NSApplicationDelegate {
    private let consent = HelperConsent()
    private lazy var runtime = HelperRuntime(consent: consent)
    private lazy var settings = HelperSettings(consent: consent,
        enable: { [weak self] in try self?.runtime.enable() }, disable: { [weak self] in self?.runtime.disable() })
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
    }

    private func updateMenu() {
        if statusItem == nil {
            statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
            statusItem?.button?.image = NSImage(systemSymbolName: "display", accessibilityDescription: "Subshell virtual display helper")
        }
        let menu = NSMenu()
        menu.autoenablesItems = false
        let settingsItem = NSMenuItem(title: "Virtual Display Helper Settings…", action: #selector(showSettings), keyEquivalent: "")
        settingsItem.target = self; menu.addItem(settingsItem)
        let disable = NSMenuItem(title: "Disable Helper", action: #selector(disableHelper), keyEquivalent: "")
        disable.target = self; disable.isEnabled = consent.enabled; menu.addItem(disable)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Helper", action: #selector(quitHelper), keyEquivalent: "")
        quit.target = self; menu.addItem(quit)
        statusItem?.menu = menu
        statusItem?.button?.toolTip = consent.enabled ? "Subshell display helper enabled" : "Subshell display helper disabled"
        settings.refresh()
    }

    @objc private func showSettings() { settings.show() }
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
