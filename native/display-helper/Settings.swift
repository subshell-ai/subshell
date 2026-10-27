import AppKit
import ApplicationServices
import ServiceManagement
import WebKit

/// Where the panel's own files live inside the helper bundle.
///
/// File-scope rather than a member of `HelperSettings` because the navigation
/// check has to run on whatever thread WebKit calls the delegate on, and a
/// `@MainActor` type's statics are main-actor state.
private enum PanelBundle {
    /// Staged by `build_support.rs` from `packages/helper-panel/dist`.
    static func indexURL() -> URL? {
        Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "panel")
    }

    /// The one directory the page may load from, and the only one the file
    /// read is scoped to.
    static func directoryURL() -> URL? { indexURL()?.deletingLastPathComponent() }

    /// Allow a main-frame navigation only while the document stays inside the
    /// bundle. The bridge can enable capture, so a page loaded from anywhere
    /// else would be handed that button.
    static func allows(_ url: URL?) -> Bool {
        guard let url, let directory = directoryURL(), url.isFileURL else { return false }
        return url.path.hasPrefix(directory.path + "/") || url.path == directory.path
    }
}

/// The helper's panel: its one consent surface.
///
/// The page is `packages/helper-panel`, built on the shared design system
/// (`packages/assistant/tokens.css`), so the panel reads as the same product as
/// the dashboard instead of as a hand-rolled approximation of it. It is still
/// not an authority. It is loaded with `loadFileURL` scoped to its own
/// directory, from a non-persistent data store, with no window opening and no
/// navigation off-bundle, so it can fetch nothing and hold nothing: what it
/// shows comes from the helper process, and every act it offers is re-checked
/// in Swift. A page that somehow posts `requestCapture` while consent is off
/// gets the same refusal as a person who cannot click it.
@MainActor
final class HelperSettings: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    private static let bridge = "subshell"
    private static let docsURL = "https://docs.subshell.sh/nodes/manage#macos-display-helper"

    private let consent: HelperConsent
    private let enable: () throws -> Void
    private let disable: () -> Void
    private let accessCount: () -> Int
    private var web: WKWebView?
    private var window: NSWindow?
    /// The page's own entry point, so a state push before it exists is skipped
    /// rather than swallowed by a rejected script.
    private var loaded = false
    /// The last JSON handed to the page. The poll runs every two seconds, and
    /// re-rendering an unchanged panel would move the caret and the selection.
    private var lastPushed = ""
    private var errorMessage = ""
    private var timer: Timer?
    /// What the person sees when the bundle has no panel: a named problem on
    /// the window itself, not an empty dark rectangle.
    private let fallback = NSTextField(wrappingLabelWithString: "")

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

    /// Called whenever the panel appears or disappears. The status menu's
    /// Minimize item is enabled only while the panel is on screen, and the menu
    /// is built once at launch, BEFORE `show()` has ever run: without this the
    /// item keeps the answer it computed when nothing was visible, which is how
    /// "Minimize helper" came to read as greyed out in front of an open window.
    var onVisibilityChange: (() -> Void)?

    /// Whether the panel is on screen; the menu bar's Minimize item answers
    /// to this so it never offers something that does nothing.
    var isShowing: Bool { window?.isVisible ?? false }

    func show() {
        if window == nil { build() }
        refresh()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        onVisibilityChange?()
    }

    /// Hide the panel and leave everything else alone: consent, permissions,
    /// and any screen being watched keep running. The menu bar item is still
    /// there to bring it back.
    func minimize() {
        window?.orderOut(nil)
        onVisibilityChange?()
    }

    /// Push the machine's current truth to the page. Cheap to call: identical
    /// state is not sent twice.
    func refresh() { pushState() }

    private func build() {
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: Layout.windowWidth, height: Layout.initialHeight),
                             styleMask: [.titled, .closable, .miniaturizable],
                             backing: .buffered, defer: false)
        panel.title = "Subshell virtual display helper"
        panel.isReleasedWhenClosed = false
        // The web theme is dark-only, so the panel pins it rather than mixing a
        // light-mode aqua title bar onto the void ground.
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.backgroundColor = Theme.background

        let container = NSView()
        container.translatesAutoresizingMaskIntoConstraints = false

        let config = WKWebViewConfiguration()
        // Nothing persists: no cookies, no storage, no cache. The panel is a
        // render of the helper's state, and it has no business remembering
        // anything between launches.
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, name: Self.bridge)
        config.preferences.javaScriptCanOpenWindowsAutomatically = false

        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = self
        view.underPageBackgroundColor = Theme.background
        view.translatesAutoresizingMaskIntoConstraints = false

        fallback.font = Theme.detailFont
        fallback.textColor = Theme.mutedForeground
        fallback.maximumNumberOfLines = 0
        fallback.isSelectable = true
        fallback.preferredMaxLayoutWidth = Layout.windowWidth - 2 * Layout.inset
        fallback.isHidden = true
        fallback.translatesAutoresizingMaskIntoConstraints = false

        container.addSubview(view)
        container.addSubview(fallback)
        NSLayoutConstraint.activate([
            // No width here: the document reports its own, and the window
            // follows. A constraint on the container would fight the resize and
            // clip the page it is supposed to frame.
            view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            view.topAnchor.constraint(equalTo: container.topAnchor),
            view.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            fallback.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: Layout.inset),
            fallback.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -Layout.inset),
            fallback.topAnchor.constraint(equalTo: container.topAnchor, constant: Layout.inset),
        ])
        panel.contentView = container

        if let index = PanelBundle.indexURL(), let directory = PanelBundle.directoryURL() {
            view.loadFileURL(index, allowingReadAccessTo: directory)
        } else {
            reportMissingBundle()
        }

        // The red button hides this window rather than releasing it, and that is
        // another way the panel leaves the screen. A block observer stands in
        // for NSWindowDelegate conformance because the delegate's actor
        // isolation in the SDK is not ours to assume.
        NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification, object: panel, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.onVisibilityChange?() }
        }

        web = view
        window = panel
        panel.center()
        // Permissions are granted in System Settings, two clicks and a dialog
        // away from this panel, and macOS sends no notification when they
        // change. Polling the two preflight calls is how the row catches up.
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.window?.isVisible == true else { return }
                self.pushState()
            }
        }
    }

    private func reportMissingBundle() {
        errorMessage = "The panel files are missing from this helper bundle. Reinstall Subshell to restore them."
        fallback.stringValue = errorMessage
        fallback.isHidden = false
        web?.isHidden = true
    }

    /// The state shape `packages/helper-panel/src/state.ts` renders. The keys
    /// are the contract between the two, so they stay in step by name.
    private func snapshot() -> [String: Any] {
        [
            "enabled": consent.enabled,
            "screenRecording": CGPreflightScreenCaptureAccess(),
            "accessibility": AXIsProcessTrusted(),
            "viewers": accessCount(),
            "error": errorMessage,
            "loginItemNeedsApproval": consent.enabled && SMAppService.mainApp.status == .requiresApproval,
        ]
    }

    private func pushState(force: Bool = false) {
        guard loaded, let view = web,
              let data = try? JSONSerialization.data(withJSONObject: snapshot()),
              let json = String(data: data, encoding: .utf8) else { return }
        if !force, json == lastPushed { return }
        lastPushed = json
        view.evaluateJavaScript("window.subshellSetState(\(json))", completionHandler: nil)
    }

    /// Follow the document's own box. The page reports it after every render, so
    /// the width in `packages/helper-panel/src/styles.css` is the one number and
    /// nothing inside the card ever scrolls sideways.
    private func resize(toWidth width: Double, height: Double) {
        guard width > 0, height > 0, let window else { return }
        let wanted = NSSize(
            width: min(max(CGFloat(width), Layout.minWidth), Layout.maxWidth),
            height: min(max(CGFloat(height), Layout.minHeight), Layout.maxHeight)
        )
        window.setContentSize(wanted)
    }

    private func handle(action: String) {
        switch action {
        case "enable": enableHelper()
        case "disable": disableHelper()
        case "requestCapture": requestCapture()
        case "requestInput": requestInput()
        case "openLoginItems": SMAppService.openSystemSettingsLoginItems()
        case "openDocs":
            if let url = URL(string: Self.docsURL) { NSWorkspace.shared.open(url) }
        case "minimize": minimize()
        // Quit is lifecycle only. It used to call disableHelper() too, which
        // revoked the person's stored consent and unregistered the login item:
        // an app's Close button silently destroying the very permission the
        // panel exists to collect, so every reopen started from Disabled.
        // "Disable helper" remains the consent act, in this panel and the menu.
        case "quit": NSApp.terminate(nil)
        // An action this binary does not know is a page newer than the
        // helper: ignore it rather than guess at what it asked for.
        default: break
        }
        pushState(force: true)
    }

    private func enableHelper() {
        errorMessage = ""
        do {
            try enable()
            try SMAppService.mainApp.register()
        } catch {
            // A half-registered helper is worse than a refused one: the login
            // item would outlive the consent it stands for.
            disable()
            errorMessage = "Couldn't enable the helper: \(error.localizedDescription)"
        }
    }

    func disableHelper() {
        disable()
        errorMessage = ""
        do { try SMAppService.mainApp.unregister() }
        catch { errorMessage = "The helper is disabled. Remove its login item in macOS System Settings if it still appears there." }
        pushState(force: true)
    }

    private func requestCapture() {
        // Consent gates the prompt as well as the capture: a helper that is
        // off has no business asking macOS for someone's screen.
        guard consent.enabled else { return }
        _ = CGRequestScreenCaptureAccess()
    }

    private func requestInput() {
        guard consent.enabled else { return }
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    }

    // MARK: - WebKit bridge
    //
    // The delegate methods stay `nonisolated` because that is how the SDK
    // declares them, while the properties they hand us (`WKScriptMessage.body`,
    // `WKNavigationAction.request`) are main-actor state. So each one reads its
    // argument on main rather than from here: a `Task` where the work may wait a
    // runloop turn, and `assumeIsolated` where the answer has to be synchronous,
    // which WebKit guarantees by delivering both calls on the thread that owns
    // the view, the main thread, since `build()` created it there.

    nonisolated func userContentController(_ userContentController: WKUserContentController,
                                           didReceive message: WKScriptMessage) {
        Task { @MainActor in
            // The bridge is the page's only door into the helper, so it carries a
            // name and a number and nothing else.
            guard let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
            if action == "resize" {
                let width = (body["width"] as? NSNumber)?.doubleValue ?? 0
                let height = (body["height"] as? NSNumber)?.doubleValue ?? 0
                self.resize(toWidth: width, height: height)
            } else {
                self.handle(action: action)
            }
        }
    }

    nonisolated func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                             decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        MainActor.assumeIsolated {
            decisionHandler(PanelBundle.allows(navigationAction.request.url) ? .allow : .cancel)
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor in
            self.loaded = true
            self.fallback.isHidden = true
            self.web?.isHidden = false
            self.pushState(force: true)
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        reportLoadFailure(error.localizedDescription)
    }

    nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                             withError error: any Error) {
        reportLoadFailure(error.localizedDescription)
    }

    private nonisolated func reportLoadFailure(_ words: String) {
        let message = "The panel failed to load: \(words)"
        Task { @MainActor in
            // Only the first load can leave the person with a blank panel; a
            // failure after that is some subresource the page no longer needs.
            guard !self.loaded else { return }
            self.errorMessage = message
            self.fallback.stringValue = message
            self.fallback.isHidden = false
        }
    }
}

/// One width, measured from the page: `packages/helper-panel/src/styles.css`
/// sets `.panel { width: var(--panel-width) }` at 420px, so the window and the
/// document agree and no horizontal scrollbar appears.
/// The window's first box and the limits it may be resized within. The width
/// the person finally sees comes from the document (`width: 520px` in
/// `packages/helper-panel/src/styles.css`); these only have to be good enough to
/// load the page in and wide enough that the first paint is not a scrollbar.
private enum Layout {
    static let windowWidth: CGFloat = 520
    static let inset: CGFloat = 20
    static let initialHeight: CGFloat = 560
    static let minWidth: CGFloat = 360
    static let maxWidth: CGFloat = 720
    static let minHeight: CGFloat = 200
    static let maxHeight: CGFloat = 1400
}
