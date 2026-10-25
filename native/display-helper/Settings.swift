import AppKit
import ApplicationServices
import ServiceManagement

@MainActor
private final class SettingsStack: NSStackView {
    override var isFlipped: Bool { true }
}

@MainActor
final class HelperSettings: NSObject {
    private let consent: HelperConsent
    private let enable: () throws -> Void
    private let disable: () -> Void
    private var window: NSWindow?
    private let status = NSTextField(wrappingLabelWithString: "")
    private let error = NSTextField(wrappingLabelWithString: "")
    private let captureStatus = NSTextField(labelWithString: "")
    private let inputStatus = NSTextField(labelWithString: "")
    private let toggle = NSButton(title: "Enable helper", target: nil, action: nil)
    private let capture = NSButton(title: "Allow screen recording…", target: nil, action: nil)
    private let input = NSButton(title: "Allow accessibility…", target: nil, action: nil)
    private var timer: Timer?

    init(consent: HelperConsent, enable: @escaping () throws -> Void, disable: @escaping () -> Void) {
        self.consent = consent
        self.enable = enable
        self.disable = disable
    }

    func show() {
        if window == nil { build() }
        refresh()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func build() {
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 680),
                             styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        panel.title = "Virtual display helper"
        panel.isReleasedWhenClosed = false
        let stack = SettingsStack()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 16
        stack.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        panel.minSize = NSSize(width: 570, height: 500)
        let scroll = NSScrollView(frame: panel.contentView!.bounds)
        scroll.hasVerticalScroller = true
        scroll.autoresizingMask = [.width, .height]
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = stack
        panel.contentView = scroll
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            stack.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor)
        ])
        let intro = NSTextField(wrappingLabelWithString:
            "Allow Subshell to capture and control virtual displays on this Mac. The helper is shared by Subshell Client and Subshell Server. It stays off until you enable it here.")
        stack.addArrangedSubview(intro)
        let warning = NSTextField(wrappingLabelWithString:
            "macOS apps share your desktop, keyboard focus, and pointer. Other windows or notifications on a virtual display can appear in its stream. Only enable this for people you trust to control this Mac.")
        warning.textColor = .systemOrange
        stack.addArrangedSubview(warning)
        stack.addArrangedSubview(status)
        toggle.target = self; toggle.action = #selector(toggleHelper)
        stack.addArrangedSubview(toggle)
        stack.addArrangedSubview(NSTextField(wrappingLabelWithString:
            "Once enabled, the helper runs in the background and starts when you sign in. Disable it here at any time to stop capture and input and prevent it from starting again. This doesn't close your subshells or revoke macOS permissions."))
        stack.addArrangedSubview(NSButton(title: "Open login items…", target: self, action: #selector(openLoginItems)))
        stack.addArrangedSubview(captureStatus)
        capture.target = self; capture.action = #selector(requestCapture)
        stack.addArrangedSubview(capture)
        stack.addArrangedSubview(inputStatus)
        input.target = self; input.action = #selector(requestInput)
        stack.addArrangedSubview(input)
        let docs = NSButton(title: "Setup instructions…", target: self, action: #selector(openDocs))
        stack.addArrangedSubview(docs)
        stack.addArrangedSubview(NSButton(title: "Quit helper", target: self, action: #selector(quitHelper)))
        error.textColor = .systemRed
        stack.addArrangedSubview(error)
        for view in stack.arrangedSubviews {
            view.setContentCompressionResistancePriority(.required, for: .vertical)
            if let label = view as? NSTextField {
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
        status.stringValue = enabled ? "Helper enabled. Capture and control also require both macOS permissions below." : "Helper disabled. No capture or input is allowed."
        if enabled && SMAppService.mainApp.status == .requiresApproval {
            status.stringValue += " Allow background startup in System Settings → General → Login Items to resume it after signing in."
        }
        toggle.title = enabled ? "Disable helper" : "Enable helper"
        captureStatus.stringValue = "Screen Recording: \(recording ? "Allowed" : "Not allowed")"
        inputStatus.stringValue = "Accessibility: \(accessibility ? "Allowed" : "Not allowed")"
        capture.isEnabled = enabled
        input.isEnabled = enabled
        let reason = enabled ? nil : "Enable the helper before requesting macOS permissions."
        capture.toolTip = reason; input.toolTip = reason
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

    @objc private func quitHelper() { disableHelper(); NSApp.terminate(nil) }

    @objc private func openDocs() {
        NSWorkspace.shared.open(URL(string: "https://docs.subshell.sh/nodes/manage#macos-display-helper")!)
    }
}
