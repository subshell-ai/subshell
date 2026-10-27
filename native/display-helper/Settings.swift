import AppKit
import ApplicationServices
import ServiceManagement

/// The helper's own panel. It is the consent surface, so it is native AppKit:
/// a local prompt the person can trust should not be HTML, and the buttons
/// that open System Settings must be the real thing.
///
/// It is styled from `Theme`, the mirror of the dashboard's token file, so a
/// person who knows Subshell from the browser recognizes the product here:
/// the void ground, the plum accent, heading/label/body/detail at the sizes
/// the web uses, gold for what the owner can fix and red for what the machine
/// refused.
@MainActor
private final class SettingsStack: NSStackView {
    override var isFlipped: Bool { true }
}

@MainActor
final class HelperSettings: NSObject {
    private let consent: HelperConsent
    private let enable: () throws -> Void
    private let disable: () -> Void
    private let accessCount: () -> Int
    private var window: NSWindow?
    private let status = NSTextField(wrappingLabelWithString: "")
    private let access = NSTextField(wrappingLabelWithString: "")
    private let error = NSTextField(wrappingLabelWithString: "")
    private let captureStatus = NSTextField(labelWithString: "")
    private let inputStatus = NSTextField(labelWithString: "")
    private let toggle = NSButton(title: "Enable helper", target: nil, action: nil)
    private let capture = NSButton(title: "Allow screen recording…", target: nil, action: nil)
    private let input = NSButton(title: "Allow accessibility…", target: nil, action: nil)
    private var timer: Timer?

    init(consent: HelperConsent,
         enable: @escaping () throws -> Void,
         disable: @escaping () -> Void,
         accessCount: @escaping () -> Int = { 0 })
    {
        self.consent = consent
        self.enable = enable
        self.disable = disable
        self.accessCount = accessCount
    }

    /// Whether the panel is on screen; the menu bar's Minimize item answers
    /// to this so it never offers something that does nothing.
    var isShowing: Bool { window?.isVisible ?? false }

    func show() {
        if window == nil { build() }
        refresh()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Hide the panel and leave everything else alone: consent, permissions,
    /// and any screen being watched keep running. The menu bar item is still
    /// there to bring it back.
    func minimize() { window?.orderOut(nil) }

    private func heading(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = Theme.headingFont
        label.textColor = Theme.foreground
        return label
    }

    private func section(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = Theme.labelFont
        label.textColor = Theme.foreground
        return label
    }

    private func body(_ text: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = Theme.bodyFont
        label.textColor = Theme.foreground
        label.isSelectable = false
        return label
    }

    private func detail(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = Theme.detailFont
        label.textColor = Theme.mutedForeground
        return label
    }

    /// A 1px rule in the border token, the same separation the dashboard's
    /// cards use between sections.
    private func rule() -> NSView {
        let line = NSView()
        line.wantsLayer = true
        line.layer?.backgroundColor = Theme.border.cgColor
        line.translatesAutoresizingMaskIntoConstraints = false
        line.heightAnchor.constraint(equalToConstant: 1).isActive = true
        return line
    }

    /// The primary control: the plum fill, dark ink on it, the same pairing
    /// `--primary` and `--primary-foreground` declare.
    private func stylePrimary(_ button: NSButton) {
        button.bezelStyle = .regularSquare
        button.isBordered = true
        button.bezelColor = Theme.primary
        button.contentTintColor = Theme.primaryForeground
        button.attributedTitle = NSAttributedString(string: button.title, attributes: [
            .foregroundColor: Theme.primaryForeground,
            .font: Theme.labelFont,
        ])
    }

    /// A secondary control: the sunk plate, brand ink, the border token.
    private func styleSecondary(_ button: NSButton) {
        button.bezelStyle = .regularSquare
        button.isBordered = true
        button.bezelColor = Theme.secondary
        button.attributedTitle = NSAttributedString(string: button.title, attributes: [
            .foregroundColor: Theme.foreground,
            .font: Theme.bodyFont,
        ])
    }

    private func build() {
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 680),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable],
                             backing: .buffered, defer: false)
        panel.title = "Subshell virtual display helper"
        panel.titlebarAppearsTransparent = false
        panel.isReleasedWhenClosed = false
        // The web theme is dark-only, so the panel pins it rather than mixing a
        // light-mode aqua control onto the void ground.
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.backgroundColor = Theme.background
        panel.minSize = NSSize(width: 570, height: 500)

        let stack = SettingsStack()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 16
        stack.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let scroll = NSScrollView(frame: panel.contentView!.bounds)
        scroll.hasVerticalScroller = true
        scroll.autoresizingMask = [.width, .height]
        scroll.drawsBackground = false
        scroll.documentView = stack
        panel.contentView = scroll
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            stack.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
        ])

        stack.addArrangedSubview(heading("Subshell virtual display helper"))
        stack.addArrangedSubview(body(
            "Allow Subshell to capture and control virtual displays on this Mac. The helper is shared by Subshell Client and Subshell Server. It stays off until you enable it here."
        ))
        let warning = body(
            "macOS apps share your desktop, keyboard focus, and pointer. Other windows or notifications on a virtual display can appear in its stream. Only enable this for people you trust to control this Mac."
        )
        warning.textColor = Theme.warning
        stack.addArrangedSubview(warning)
        stack.addArrangedSubview(rule())

        stack.addArrangedSubview(section("Access"))
        status.font = Theme.bodyFont
        status.textColor = Theme.mutedForeground
        stack.addArrangedSubview(status)
        access.font = Theme.detailFont
        access.textColor = Theme.mutedForeground
        stack.addArrangedSubview(access)
        toggle.target = self
        toggle.action = #selector(toggleHelper)
        stylePrimary(toggle)
        stack.addArrangedSubview(toggle)
        stack.addArrangedSubview(detail(
            "Once enabled, the helper runs in the background and starts when you sign in. Disable it here at any time to stop capture and input and prevent it from starting again. This doesn't close your subshells or revoke macOS permissions."
        ))
        let loginItems = NSButton(title: "Open login items…", target: self, action: #selector(openLoginItems))
        styleSecondary(loginItems)
        stack.addArrangedSubview(loginItems)
        stack.addArrangedSubview(rule())

        stack.addArrangedSubview(section("macOS permissions"))
        captureStatus.font = Theme.detailFont
        captureStatus.textColor = Theme.mutedForeground
        stack.addArrangedSubview(captureStatus)
        capture.target = self
        capture.action = #selector(requestCapture)
        styleSecondary(capture)
        stack.addArrangedSubview(capture)
        inputStatus.font = Theme.detailFont
        inputStatus.textColor = Theme.mutedForeground
        stack.addArrangedSubview(inputStatus)
        input.target = self
        input.action = #selector(requestInput)
        styleSecondary(input)
        stack.addArrangedSubview(input)
        stack.addArrangedSubview(rule())

        let docs = NSButton(title: "Setup instructions…", target: self, action: #selector(openDocs))
        styleSecondary(docs)
        stack.addArrangedSubview(docs)
        error.font = Theme.detailFont
        error.textColor = Theme.destructive
        stack.addArrangedSubview(error)

        // The two ways out, together at the foot: minimize keeps the helper
        // running, quit stops the process (and revokes consent on the way).
        let foot = NSStackView()
        foot.orientation = .horizontal
        foot.spacing = 12
        let minimize = NSButton(title: "Minimize helper", target: self, action: #selector(minimizePanel))
        styleSecondary(minimize)
        let quit = NSButton(title: "Quit helper", target: self, action: #selector(quitHelper))
        styleSecondary(quit)
        foot.addArrangedSubview(minimize)
        foot.addArrangedSubview(quit)
        stack.addArrangedSubview(foot)

        for view in stack.arrangedSubviews {
            view.setContentCompressionResistancePriority(.required, for: .vertical)
            if let label = view as? NSTextField, label.lineBreakMode == .byWordWrapping {
                label.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -48).isActive = true
            }
        }
        panel.center()
        window = panel
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
    }

    func refresh() {
        let enabled = consent.enabled
        let recording = CGPreflightScreenCaptureAccess()
        let accessibility = AXIsProcessTrusted()
        status.stringValue = enabled
            ? "Helper enabled. Capture and control also require both macOS permissions below."
            : "Helper disabled. No capture or input is allowed."
        if enabled && SMAppService.mainApp.status == .requiresApproval {
            status.stringValue += " Allow background startup in System Settings → General → Login Items to resume it after signing in."
        }
        let line = AccessReport.panelLine(viewers: accessCount())
        access.stringValue = line.text
        access.textColor = line.warning ? Theme.warning : Theme.mutedForeground
        toggle.title = enabled ? "Disable helper" : "Enable helper"
        stylePrimary(toggle)
        captureStatus.stringValue = "Screen Recording: \(recording ? "Allowed" : "Not allowed")"
        inputStatus.stringValue = "Accessibility: \(accessibility ? "Allowed" : "Not allowed")"
        capture.isEnabled = enabled
        input.isEnabled = enabled
        let reason = enabled ? nil : "Enable the helper before requesting macOS permissions."
        capture.toolTip = reason
        input.toolTip = reason
        if !enabled { status.stringValue += " Enable it before requesting macOS permissions." }
    }

    @objc private func toggleHelper() {
        error.stringValue = ""
        if consent.enabled {
            disableHelper()
        } else {
            do {
                try enable()
                try SMAppService.mainApp.register()
            } catch {
                disable()
                self.error.stringValue = "Couldn't enable the helper: \(error.localizedDescription)"
            }
        }
        refresh()
    }

    func disableHelper() {
        disable()
        do { try SMAppService.mainApp.unregister() }
        catch { self.error.stringValue = "The helper is disabled. Remove its login item in macOS System Settings if it still appears there." }
        refresh()
    }

    @objc private func requestCapture() {
        guard consent.enabled else { return }
        _ = CGRequestScreenCaptureAccess()
        refresh()
    }

    @objc private func requestInput() {
        guard consent.enabled else { return }
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        refresh()
    }

    @objc private func openLoginItems() { SMAppService.openSystemSettingsLoginItems() }

    @objc private func minimizePanel() { minimize() }

    @objc private func quitHelper() { disableHelper(); NSApp.terminate(nil) }

    @objc private func openDocs() {
        NSWorkspace.shared.open(URL(string: "https://docs.subshell.sh/nodes/manage#macos-display-helper")!)
    }
}
