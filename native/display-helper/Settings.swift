import AppKit
import ApplicationServices
import ServiceManagement
import WebKit

/// Where the panel's own files live inside the helper bundle.
///
/// File-scope rather than a member of `HelperSettings` because the navigation
/// check has to run on whatever thread WebKit calls the delegate on, and a
/// `@MainActor` type's statics are main-actor state.
///
/// Module-visible rather than `private` for one reason: `tests/HelperTests.swift`
/// checks the gate. It is the one rule standing between a document loaded from
/// somewhere else and the button that starts a screen capture, and a bundle-less
/// test binary has no `panel` directory to answer for, so the directory is a
/// parameter of the pure half rather than read from `Bundle.main` there.
enum PanelBundle {
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
        allows(url, within: directoryURL())
    }

    /// The gate itself, with the directory handed in.
    static func allows(_ url: URL?, within directory: URL?) -> Bool {
        guard let url, let directory, url.isFileURL else { return false }
        // Standardized, so `panel/../../Secrets/x` cannot wear the prefix of a
        // directory it actually escapes. The file read is scoped separately;
        // this gate is the one the header comment leans on, so it stands alone.
        let path = url.standardizedFileURL.path
        // The trailing separator is not decoration: without it a sibling named
        // `panel-evil` shares the prefix and is read as being inside.
        return path == directory.path || path.hasPrefix(directory.path + "/")
    }
}

/// The helper's panel: its one consent surface.
///
/// The page is `packages/helper-panel`, built on the shared design system
/// (`packages/assistant/tokens.css`), so the panel reads as the same product as
/// the dashboard instead of as a hand-rolled approximation of it. It is still
/// not an authority. It is loaded with `loadFileURL` scoped to its own
/// directory, from a non-persistent data store, with no window opening and no
/// navigation off-bundle, and its own Content-Security-Policy (`default-src
/// 'none'`, with only the two inline sources the build's fold needs) refuses
/// every request the page might try to make. So it can fetch nothing and hold
/// nothing: what it shows comes from the helper process, and every act it
/// offers is re-checked in Swift. A page that somehow posts `requestCapture` while consent is off
/// gets the same refusal as a person who cannot click it.
@MainActor
final class HelperSettings: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    private static let bridge = "subshell"
    private static let docsURL = "https://docs.subshell.sh/previews/macos"

    private let consent: HelperConsent
    private let enable: () throws -> Void
    private let disable: () -> Void
    private let accessCount: () -> Int
    private var web: WKWebView?
    private var window: NSWindow?
    /// The page's own entry point, so a state push before it exists is skipped
    /// rather than swallowed by a rejected script.
    private var loaded = false
    /// The last JSON handed to the page. The poll runs every five seconds, and
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
        // The panel is opened from the desktop app's button as well as from this
        // helper's menu, so the click may have landed in another app, and an
        // accessory app is not trusted to pull its own window over the frontmost
        // one on someone else's keystroke. Ordering it up regardless is what makes
        // the press visible; the activation call is the one this helper has always
        // shipped and the one the macOS lane compiles clean.
        //
        // Apple marks `activate(ignoringOtherApps:)` deprecated as of macOS 14,
        // and `test.sh` does treat warnings as errors, yet this file has built the
        // call through that lane, so on this toolchain the deprecation is not a
        // warning.
        // The no-argument `activate()` arrived with the macOS 14 SDK and nothing
        // here has ever compiled it: if the runner's SDK predates that, it is a
        // hard error, not a warning. Keep the proven call, and swap it only after
        // the mac lane says so. Note the lane's reach: `test.sh` compiles every
        // source EXCEPT `main.swift`, and the release build in `build_support.rs`
        // passes no `-warnings-as-errors` at all, so this file is guarded and the
        // app delegate is not.
        window?.makeKeyAndOrderFront(nil)
        window?.orderFrontRegardless()
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
            // willClose arrives before isVisible changes. Rebuild the menu
            // after the close completes so Minimize reflects the hidden panel.
            Task { @MainActor [weak self] in self?.onVisibilityChange?() }
        }

        web = view
        window = panel
        panel.center()
        // Permissions are granted in System Settings, two clicks and a dialog
        // away from this panel, and macOS sends no notification when they
        // change. Polling the two preflight calls is how the row catches up.
        // Five seconds, in every run-loop mode. The default mode stops firing
        // while a menu is being tracked, and the whole point of the poll is to
        // catch a change made in another app, so the wait for a switch flip in
        // System Settings must not depend on this process being idle.
        let poll = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.window?.isVisible == true else { return }
                self.pushState()
            }
        }
        RunLoop.main.add(poll, forMode: .common)
        timer = poll
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
            "loginItem": LoginItem.pageState(SMAppService.mainApp.status),
        ]
    }

    private func pushState(force: Bool = false) {
        guard loaded, let view = web,
              let data = try? JSONSerialization.data(withJSONObject: snapshot(), options: [.sortedKeys]),
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
        case "openCaptureSettings": open(SettingsRoute.screenRecording)
        case "openInputSettings": open(SettingsRoute.accessibility)
        case "registerLoginItem": registerLoginItem()
        case "unregisterLoginItem": unregisterLoginItem()
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

    /// The consent act, and nothing else: the helper starts listening and the
    /// person's agreement is stored. It deliberately does not register the
    /// login item, because agreeing to be captured and agreeing to launch at
    /// sign-in are two choices and macOS's list is not the place to discover
    /// the second one was made for you. `registerLoginItem` is its own act with
    /// its own button, in the panel: the status menu carries consent and the
    /// exits, and leaves the sign-in list to the row that can read it back.
    func enableHelper() {
        errorMessage = ""
        do { try enable() }
        catch { errorMessage = "Couldn't enable the helper: \(error.localizedDescription)" }
    }

    /// Registering for sign-in is its own act with its own button. Enabling the
    /// helper used to do it silently, so agreeing to be captured also put a
    /// launcher in macOS's login list without anyone being asked.
    func registerLoginItem() {
        errorMessage = ""
        do { try SMAppService.mainApp.register() }
        catch { errorMessage = "Couldn't set the helper to start at sign-in: \(error.localizedDescription)" }
    }

    func unregisterLoginItem() {
        errorMessage = ""
        do { try SMAppService.mainApp.unregister() }
        catch { errorMessage = "Couldn't stop the helper from starting at sign-in. Turn it off in System Settings under General, Login Items." }
    }

    /// Disabling stops capture and input and leaves the sign-in choice alone. It
    /// was the person's choice to make, and un-making it here would be the same
    /// silent side effect enabling used to have. A helper that starts with
    /// consent off does nothing and exits.
    func disableHelper() {
        disable()
        errorMessage = ""
        pushState(force: true)
    }

    /// Opens one of System Settings' panes. A malformed route is a developer
    /// mistake, not something to bother the person with, so it fails quietly.
    private func open(_ route: String) {
        if let url = URL(string: route) { NSWorkspace.shared.open(url) }
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
            guard message.frameInfo.isMainFrame,
                  PanelBundle.allows(message.frameInfo.request.url) else { return }
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
