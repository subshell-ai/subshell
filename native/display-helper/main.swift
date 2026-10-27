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
    /// macOS naps a background app whose windows are not in front, and a napped
    /// app's timers are coalesced to minutes. This helper's job includes
    /// reporting consent and permission state truthfully while the person is
    /// sitting in System Settings, so it stays awake enough to poll.
    private let activity = ProcessInfo.processInfo.beginActivity(
        options: [.userInitiatedAllowingIdleSystemSleep],
        reason: "Keeping the helper's consent and permission state current"
    )

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
        // A viewer's pointer is the real cursor, so the screen it was parked on
        // can go away while this process is not running: the docs promise an
        // existing virtual screen may outlive the helper, and whoever closes the
        // last pane over it cannot ask a dead socket to warp the cursor back. Any
        // start, at sign-in or from the panel, heals that here rather than
        // leaving the person at the Mac without a pointer. It moves the cursor
        // only when it is inside no screen's frame, so a normal launch does
        // nothing at all.
        restoreStrandedCursor()
        if consent.enabled {
            do { try runtime.enable() }
            // Two wrong answers, and one right one. `disable()` clears consent
            // before it closes anything, so a transient failure here would
            // silently un-consent a Mac whose person never changed their mind.
            // Staying alive is wrong the other way: with the listener down the
            // menu and the panel both read "Enabled" over a machine capturing
            // nothing, and this panel exists to be truthful about capture. Leaving
            // is the same answer the socket gives two pages up, and it keeps the
            // agreement. Unreachable today, because `listenForStatus()` has already
            // bound and `Listener.start()` returns early when a descriptor exists:
            // it is here so that whoever adds a throwing step to `enable()` finds a
            // honest failure, not a lying menu.
            catch { NSApp.terminate(nil); return }
        }
        // Who is allowed to open the panel decides whether this run stays.
        let opensPanel = CommandLine.arguments.contains("--settings")
        if !opensPanel && !consent.enabled {
            // The sign-in case the docs describe as exiting at once: a helper left
            // registered after the person switched it off comes back, finds no
            // consent, and leaves. Drawing the menu-bar icon first would flash a
            // display glyph on a Mac that is capturing nothing, which reads as a
            // watcher that is not there, so the icon is installed only for a run
            // that stays.
            NSApp.terminate(nil)
            return
        }
        updateMenu()
        if opensPanel { settings.show() }
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
        // One item, named for the direction it goes. The menu used to carry
        // only "Disable helper", greyed once consent was off, which left a
        // person who had just disabled the helper with a settings window as the
        // only way back to running.
        let toggle = NSMenuItem(title: AccessReport.toggleTitle(enabled: consent.enabled), action: #selector(toggleHelper), keyEquivalent: "")
        toggle.target = self; menu.addItem(toggle)
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
    /// Enable or disable from the menu, then raise the panel: the consent
    /// sentence and the state belong where the person can read what they just
    /// agreed to, and a failure has to land on the thing that failed.
    @objc private func toggleHelper() {
        if consent.enabled {
            settings.disableHelper()
        } else {
            settings.enableHelper()
        }
        settings.show()
    }
    /// Whether the quit confirmation is on screen, so a second menu press
    /// cannot stack a duplicate question.
    private var quitAlertShown = false

    /// The menu's Quit asks the same question the panel asks, because the
    /// consequence lives in the act rather than in the control. An accessory
    /// app has no window to host a sheet while the panel is closed, so this is
    /// a native alert; Cancel is the button Return presses, the way the panel
    /// focuses the way out rather than the act. `applicationWillTerminate`
    /// closes every capture, and leaving consent alone is deliberate: a quit is
    /// not a revocation.
    @objc private func quitHelper() {
        // The status menu stays clickable through an app-modal session, so a
        // second press would nest another identical alert: the person answers
        // once, and a second question is still waiting. One at a time.
        if quitAlertShown {
            NSApp.activate()
            return
        }
        quitAlertShown = true
        defer { quitAlertShown = false }
        let alert = NSAlert()
        alert.messageText = QuitCopy.title
        alert.informativeText = QuitCopy.body(loginItem: LoginItem.currentPageState(), consented: consent.enabled)
        alert.alertStyle = .warning
        // Added first, so Return and the rightmost position land on the way out.
        alert.addButton(withTitle: QuitCopy.cancel)
        let confirm = alert.addButton(withTitle: QuitCopy.confirm)
        confirm.hasDestructiveAction = true
        // An accessory app has no key window to hang the alert on, so it comes
        // forward first, and it has to come forward over whatever app the person
        // was in: the menu is still clickable through an app-modal session, so an
        // alert left behind another window reads as a menu that does nothing.
        //
        // Apple marks this form deprecated as of macOS 14, and it is still the
        // right call here: it is the shape main has shipped through the macOS lane
        // (where warnings are errors, so a warning would have surfaced), while the
        // no-argument `activate()` arrived with the macOS 14 SDK and nothing in
        // this repo has ever compiled it. Note also that this file is outside that
        // lane's reach at all - `test.sh` excludes `main.swift` - so the release
        // build is the only thing that would tell us, and it passes no
        // `-warnings-as-errors`.
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn { return }
        NSApp.terminate(nil)
    }
}

umask(0o077)
MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = DisplayHelperApp()
    app.delegate = delegate
    app.run()
}
