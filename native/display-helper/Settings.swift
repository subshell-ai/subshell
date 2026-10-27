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
private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

/// One column, one rhythm. The panel is a settings card, not a report: a
/// width this text can actually be read at, and everything measured from it.
private enum Layout {
    static let windowWidth: CGFloat = 420
    static let inset: CGFloat = 20
    static var contentWidth: CGFloat { windowWidth - 2 * inset }
}

private extension NSTextField {
    /// The gold the design system reserves for "the person who owns this can
    /// fix it here" - the same role the dashboard's `text-warning` holds.
    func withWarningColor() -> NSTextField {
        textColor = Theme.warning
        return self
    }
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
    // Built once in `build()`; these placeholders exist so a state change
    // arriving before the first `show()` has something safe to address.
    private var toggle = NSButton()
    private var capture = NSButton()
    private var input = NSButton()
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
        label.preferredMaxLayoutWidth = Layout.contentWidth
        return label
    }

    private func detail(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = Theme.detailFont
        label.textColor = Theme.mutedForeground
        return label
    }

    /// A 1px rule in the border token: the only separator the panel needs,
    /// because grouping is carried by headings and spacing, not by lines.
    private func rule() -> NSView {
        let line = NSView()
        line.wantsLayer = true
        line.layer?.backgroundColor = Theme.border.cgColor
        line.translatesAutoresizingMaskIntoConstraints = false
        line.heightAnchor.constraint(equalToConstant: 1).isActive = true
        line.widthAnchor.constraint(equalToConstant: Layout.contentWidth).isActive = true
        return line
    }

    /// Standard push buttons: native chrome, consistent height, alignment the
    /// layout can trust. `isDefault` makes the window's default button, which
    /// is how macOS shows the primary action - fake filled bezels (setting
    /// `bezelColor` on `.regularSquare`) render as mismatched tall boxes,
    /// which is what made this panel look broken.
    private func push(_ title: String, _ action: Selector, `default`: Bool = false) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        button.controlSize = .regular
        button.font = Theme.bodyFont
        if `default` {
            button.keyEquivalent = "\r"
        }
        return button
    }

    private func build() {
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: Layout.windowWidth, height: 480),
                             styleMask: [.titled, .closable, .miniaturizable],
                             backing: .buffered, defer: false)
        panel.title = "Subshell virtual display helper"
        panel.isReleasedWhenClosed = false
        // The web theme is dark-only, so the panel pins it rather than mixing a
        // light-mode aqua control onto the void ground.
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.backgroundColor = Theme.background

        let stack = SettingsStack()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false

        // Header: the brand mark, the name, and what it does in one line.
        let mark = NSImageView()
        mark.image = NSImage(systemSymbolName: "display", accessibilityDescription: nil)
        mark.contentTintColor = Theme.primary
        mark.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 18, weight: .semibold)
        mark.setFrameSize(NSSize(width: 24, height: 24))
        let header = NSStackView(views: [mark, heading("Subshell virtual display helper")])
        header.orientation = .horizontal
        header.spacing = 10

        stack.addArrangedSubview(header)
        stack.addArrangedSubview(detail("Capture and control of Subshell's virtual displays on this Mac."))
        stack.addArrangedSubview(body(
            "macOS shares one desktop: a viewer's pointer is the real cursor, and other windows can appear in the stream. Enable this only for people you trust to control this Mac."
        ).withWarningColor())
        stack.addArrangedSubview(rule())

        stack.addArrangedSubview(section("Access"))
        status.font = Theme.detailFont
        status.textColor = Theme.mutedForeground
        status.preferredMaxLayoutWidth = Layout.contentWidth
        stack.addArrangedSubview(status)
        access.font = Theme.detailFont
        access.textColor = Theme.mutedForeground
        access.preferredMaxLayoutWidth = Layout.contentWidth
        stack.addArrangedSubview(access)
        toggle = push("Enable helper", #selector(toggleHelper), default: true)
        stack.addArrangedSubview(toggle)
        stack.addArrangedSubview(detail(
            "While enabled the helper runs in the background and starts at sign-in. Disabling stops capture and input; your subshells and macOS permissions stay."
        ))
        stack.addArrangedSubview(rule())

        // Permissions read as a table: the state on the left, its action on
        // the same row, so the two states line up instead of floating.
        stack.addArrangedSubview(section("macOS permissions"))
        captureStatus.font = Theme.detailFont
        captureStatus.textColor = Theme.mutedForeground
        inputStatus.font = Theme.detailFont
        inputStatus.textColor = Theme.mutedForeground
        capture = push("Allow screen recording…", #selector(requestCapture))
        input = push("Allow accessibility…", #selector(requestInput))
        let grid = NSGridView(views: [[captureStatus, capture], [inputStatus, input]])
        grid.rowSpacing = 10
        grid.columnSpacing = 14
        grid.column(at: 0).xPlacement = .leading
        grid.column(at: 1).xPlacement = .trailing
        grid.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(grid)
        stack.addArrangedSubview(rule())

        error.font = Theme.detailFont
        error.textColor = Theme.destructive
        error.preferredMaxLayoutWidth = Layout.contentWidth
        stack.addArrangedSubview(error)

        // Secondary actions left, the way out right.
        let docs = push("Setup instructions…", #selector(openDocs))
        let loginItems = push("Open login items…", #selector(openLoginItems))
        let minimize = push("Minimize helper", #selector(minimizePanel))
        let quit = push("Quit helper", #selector(quitHelper))
        let leading = NSStackView(views: [docs, loginItems])
        leading.orientation = .horizontal
        leading.spacing = 10
        let trailing = NSStackView(views: [minimize, quit])
        trailing.orientation = .horizontal
        trailing.spacing = 10
        let foot = NSGridView(views: [[leading, trailing]])
        foot.column(at: 0).xPlacement = .leading
        foot.column(at: 1).xPlacement = .trailing
        foot.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(foot)

        let container = FlippedView()
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            container.widthAnchor.constraint(equalToConstant: Layout.windowWidth),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: Layout.inset),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -Layout.inset),
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: Layout.inset),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -Layout.inset),
        ])
        panel.contentView = container
        panel.layoutIfNeeded()
        panel.setContentSize(NSSize(width: Layout.windowWidth, height: max(360, stack.fittingSize.height + 2 * Layout.inset)))
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
