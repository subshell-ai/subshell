import Foundation
import ServiceManagement
import Darwin
import CoreVideo

func request(_ path: String, _ line: String) throws -> [String: Any]? {
    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { fatalError("socket") }
    defer { close(descriptor) }
    var timeout = timeval(tv_sec: 2, tv_usec: 0)
    setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout)))
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8CString)
    precondition(bytes.count <= MemoryLayout.size(ofValue: address.sun_path))
    withUnsafeMutableBytes(of: &address.sun_path) { target in
        for (index, byte) in bytes.enumerated() { target[index] = UInt8(bitPattern: byte) }
    }
    let result = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    precondition(result == 0)
    let message = Data((line + "\n").utf8)
    _ = message.withUnsafeBytes { send(descriptor, $0.baseAddress, $0.count, 0) }
    var output = [UInt8](repeating: 0, count: 4096)
    let count = recv(descriptor, &output, output.count, 0)
    if count == 0 { return nil }
    precondition(count > 0, "response timeout")
    return try JSONSerialization.jsonObject(with: Data(output.prefix(count))) as? [String: Any]
}

@main
struct HelperTests {
    @MainActor static func main() async throws {
        // No app bundle, login registration, capture, input or permission requests.
        // Only a private temporary socket and a disposable preference suite.
        let suite = "dev.subshell.helper-tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let consent = HelperConsent(defaults: defaults)
        precondition(!consent.enabled)
        consent.setEnabled(true); precondition(HelperConsent(defaults: defaults).enabled)
        consent.setEnabled(false); precondition(!consent.enabled)
        // The DEFAULT initializer must read the standard (own) domain. The
        // released code handed `suiteName:` the app's own bundle id, which
        // Foundation rejects, and the force-unwrap trapped in
        // DisplayHelperApp.init before any panel could open.
        UserDefaults.standard.removeObject(forKey: "enabled")
        precondition(!HelperConsent().enabled, "A fresh helper starts without consent")
        UserDefaults.standard.set(true, forKey: "enabled")
        precondition(HelperConsent().enabled, "The default init must read the app's own domain")
        UserDefaults.standard.removeObject(forKey: "enabled")
        // The conversion, not the palette: these pins catch a broken oklch
        // → sRGB here, and can see nothing about the shared file (they read
        // Theme.tokens, the same source they check). The drift guard against
        // packages/assistant/tokens.css is the helper-panel suite's palette
        // test, which parses that file and compares the triples by name.
        func close(_ a: Double, _ b: Double) -> Bool { abs(a - b) < 0.02 }
        let warning = Theme.srgb("warning")
        precondition(close(warning.red, 1.0) && close(warning.green, 0.727) && close(warning.blue, 0.0), "warning token drifted")
        let ground = Theme.srgb("background")
        precondition(close(ground.red, 0.113) && close(ground.green, 0.094) && close(ground.blue, 0.165), "background token drifted")
        let muted = Theme.srgb("muted-foreground")
        precondition(close(muted.red, 0.700) && close(muted.green, 0.644) && close(muted.blue, 0.746), "muted-foreground token drifted")
        // The awareness copy: a dot on the menu bar is only useful if the
        // words say who is doing what, and the idle state must not claim
        // anyone is watching.
        precondition(AccessReport.tooltip(enabled: true, viewers: 2) == "Subshell is viewing a virtual display on this Mac (2 viewers)")
        precondition(AccessReport.tooltip(enabled: true, viewers: 1) == "Subshell is viewing a virtual display on this Mac")
        precondition(AccessReport.tooltip(enabled: false, viewers: 0) == "Subshell virtual display helper disabled")
        // The granted rows' way into System Settings: real pane URLs, so a
        // typo would open nothing and read as a dead button.
        precondition(SettingsRoute.screenRecording == "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        precondition(SettingsRoute.accessibility == "x-apple.systempreferences:com.apple.preference.security?Accessibility")
        // The login item's three macOS states stay three, because collapsing
        // notRegistered into "approved" is what made a turned-off sign-in start
        // still read "Starts at sign-in with macOS."
        precondition(LoginItem.pageState(.enabled) == "registered")
        precondition(LoginItem.pageState(.requiresApproval) == "needsApproval")
        precondition(LoginItem.pageState(.notRegistered) == "notRegistered")
        precondition(LoginItem.pageState(.notFound) == "notRegistered")
        // The menu's one consent item flips with the state, in both directions.
        precondition(AccessReport.toggleTitle(enabled: true) == "Disable helper")
        precondition(AccessReport.toggleTitle(enabled: false) == "Enable helper")
        // The bar item is an icon, so the menu it opens has to say what it is.
        precondition(AccessReport.heading == "Subshell virtual display helper", "the status menu must name the helper")
        // Both Quit doors ask, and the menu's copy is this. The panel's own
        // strings are compared against it by the helper-panel suite.
        precondition(QuitCopy.title.hasSuffix("?"), "a confirmation names the act as a question")
        for state in ["registered", "needsApproval", "notRegistered"] {
            for consented in [true, false] {
                let body = QuitCopy.body(loginItem: state, consented: consented)
                precondition(body.contains("loses it now"), "every variant says what stopping means")
                precondition(body.contains("virtual display settings") || body.contains("login list"),
                             "every variant says how the helper comes back")
            }
        }
        // The sentences that used to be shared: only a registered helper that is
        // switched on comes back at sign-in, and only Stop at sign-in removes it.
        precondition(QuitCopy.body(loginItem: "registered", consented: true).contains("starts again at sign-in"))
        let registeredOff = QuitCopy.body(loginItem: "registered", consented: false)
        precondition(registeredOff.contains("without capturing anything"), "a disabled start captures nothing")
        precondition(registeredOff.contains("Stop at sign-in"))
        precondition(!registeredOff.contains("starts again at sign-in"))
        for state in ["notRegistered", "needsApproval"] {
            for consented in [true, false] {
                precondition(!QuitCopy.body(loginItem: state, consented: consented).contains("starts again at sign-in"))
            }
        }
        precondition(QuitCopy.confirm != QuitCopy.cancel && !QuitCopy.cancel.isEmpty)
        // The pointer rescue: a viewer's cursor lives on the virtual display,
        // so losing that screen strands it off every display the person at
        // this Mac can see. Only a point inside no frame counts as stranded.
        let builtIn = CGRect(x: 0, y: 0, width: 1512, height: 982)
        precondition(cursorIsStranded(point: CGPoint(x: 2400, y: 1800), screens: [builtIn]), "a point off every screen is stranded")
        precondition(!cursorIsStranded(point: CGPoint(x: 100, y: 100), screens: [builtIn]), "a point on the built-in display is fine")
        precondition(!cursorIsStranded(point: CGPoint(x: 1800, y: 1500), screens: [builtIn, CGRect(x: 1512, y: 982, width: 1280, height: 800)]),
                     "a point on any connected screen is fine")
        precondition(cursorIsStranded(point: CGPoint(x: 0, y: 0), screens: []), "no screens means nowhere visible")
        precondition(DisplayInput.keyCode(symbol: 0x63) == 8) // Command-C
        precondition(DisplayInput.keyCode(symbol: 0x43) == 8)
        precondition(DisplayInput.keyCode(symbol: 0x01000063) == 8)
        precondition(DisplayInput.keyCode(symbol: 0x76) == 9) // Command-V
        precondition(DisplayInput.keyCode(symbol: 0xffe3) == 59) // Control
        precondition(integer(true, maximum: 4096) == nil)
        precondition(integer(1.5, maximum: 4096) == nil)
        precondition(integer(-1, maximum: 4096) == nil)
        precondition(integer(Double.infinity, maximum: 4096) == nil)
        precondition(integer(4097, maximum: 4096) == nil)
        precondition(integer(4096, maximum: 4096) == 4096)
        var captureAllowed = true
        var stops = 0
        try await startCaptureWhileAllowed(start: {}, stop: { stops += 1 }, allowed: { captureAllowed })
        precondition(stops == 0)
        do {
            try await startCaptureWhileAllowed(start: {
                // Simulate Disable while startup is suspended, including an
                // attempted stop before the native start finishes.
                await Task.yield()
                captureAllowed = false
                stops += 1
            }, stop: { stops += 1 }, allowed: { captureAllowed })
            preconditionFailure("Revoked capture must not finish startup")
        } catch {
            precondition(stops == 2, "Stop must run again after asynchronous startup completes")
        }
        // The navigation gate: the one rule between a document loaded from
        // somewhere else and the button that starts a screen capture. It is
        // checked here rather than assumed because its two halves are both easy
        // to break by editing for looks: drop the standardization and an escaped
        // path wears the bundle's prefix, drop the trailing separator and a
        // sibling named `panel-evil` counts as inside.
        // Built the way `directoryURL()` builds it in production, from the page's
        // own URL. `URL(fileURLWithPath:isDirectory:)` would be the natural thing
        // to reach for and is wrong here: it appends a trailing slash, so the gate
        // would compare against `panel/` and `panel//`, every allow case would
        // fail, and every refuse case would pass without the two guards doing any
        // work. The precondition below turns that Foundation subtlety into a named
        // failure instead of a confusing one.
        let panelIndex = URL(fileURLWithPath: "/tmp/subshell-panel-test/Contents/Resources/panel/index.html")
        let panel = panelIndex.deletingLastPathComponent()
        let bundleRoot = panel.deletingLastPathComponent()
        precondition(!panel.path.hasSuffix("/"), "the fixture must match directoryURL()'s shape")
        func file(_ path: String) -> URL { URL(fileURLWithPath: path) }
        precondition(PanelBundle.allows(panelIndex, within: panel), "the page itself is allowed")
        precondition(PanelBundle.allows(file(panel.path), within: panel), "the bundle directory is allowed")
        precondition(PanelBundle.allows(file(panel.path + "/assets/deep/x.js"), within: panel), "nested files are allowed")
        precondition(!PanelBundle.allows(file("/etc/passwd"), within: panel), "outside the bundle is refused")
        precondition(
            !PanelBundle.allows(file(panel.path + "/../../Secrets/id"), within: panel),
            "a path that escapes while wearing the prefix is refused")
        precondition(
            !PanelBundle.allows(file(bundleRoot.path + "/panel-evil/x.html"), within: panel),
            "a sibling sharing the directory's name is refused")
        // Scheme, not shape. Every other refusal here has a path that could not
        // match the prefix anyway, so only a network URL WEARING the bundle's own
        // path pins the `isFileURL` half of the guard: delete it and this is the
        // case that goes green on a page fetched from anywhere.
        precondition(
            !PanelBundle.allows(URL(string: "https://plane.example.test\(panel.path)/x.html")!, within: panel),
            "a network document is refused even wearing the bundle's path")
        precondition(!PanelBundle.allows(nil, within: panel), "no url is no answer")
        precondition(!PanelBundle.allows(file(panel.path + "/index.html"), within: nil), "no bundle directory allows nothing")
        // And the real entry point, with no bundle around it at all: the same
        // refusal a helper whose panel files went missing has to answer with.
        precondition(!PanelBundle.allows(file(panel.path + "/index.html")), "a bundle-less binary allows nothing")
        // Synthetic pixels exercise the worker without screen-capture permission.
        var buffer: CVPixelBuffer?
        precondition(CVPixelBufferCreate(kCFAllocatorDefault, 320, 320,
            kCVPixelFormatType_32BGRA, nil, &buffer) == kCVReturnSuccess)
        let encoded: Data? = await withCheckedContinuation { continuation in
            DisplayFrameEncoder().encode(buffer!) { jpeg in
                precondition(!Thread.isMainThread, "JPEG encoding must not block settings or RPC")
                continuation.resume(returning: jpeg)
            }
        }
        precondition(encoded?.prefix(2) == Data([0xff, 0xd8]))
        precondition(encoded?.suffix(2) == Data([0xff, 0xd9]))
        let directory = URL(fileURLWithPath: "/tmp/sh-helper-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let listener = HelperListener(directory: directory)
        let runtime = HelperRuntime(consent: consent, listener: listener)
        try runtime.listenForStatus()
        defer { runtime.shutdown() }
        let path = directory.appendingPathComponent("control.sock").path
        let disabled = try await Task.detached { try request(path, #"{"op":"status"}"#) }.value
        precondition(disabled?["enabled"] as? Bool == false)
        for operation in ["enable", "start", "pointer", "key", "requestPermissions"] {
            let result = try await Task.detached { try request(path, "{\"op\":\"\(operation)\"}") }.value
            precondition(result == nil)
            precondition(!consent.enabled)
        }
        // The two admitted operations are admissions, not mere exceptions to a
        // refusal. Deleting `|| operation == "rescue-cursor"` from `Runtime.swift`
        // leaves every assertion above green while silently breaking the one act a
        // disabled helper must still perform: by the time the daemon asks, the
        // display that stranded the pointer is already gone, and a helper that
        // answers by closing the socket strands the person at the Mac with no
        // cursor and no way to click anything.
        let rescued = try await Task.detached { try request(path, #"{"op":"rescue-cursor"}"#) }.value
        precondition(rescued?["type"] as? String == "rescued", "a disabled helper still returns the pointer")
        precondition(rescued?["protocol"] as? Int == 1, "the rescue answer keeps the frame's protocol")
        precondition(!consent.enabled, "rescuing the cursor must not grant consent")
        try runtime.enable()
        let enabled = try await Task.detached { try request(path, #"{"op":"status"}"#) }.value
        precondition(enabled?["enabled"] as? Bool == true)
        runtime.shutdown()
        precondition(consent.enabled, "Logout teardown must preserve explicit consent")
        try runtime.listenForStatus()
        runtime.disable()
        precondition(!consent.enabled)
        let final = try await Task.detached { try request(path, #"{"op":"status"}"#) }.value
        precondition(final?["enabled"] as? Bool == false)
        print("Helper consent, protocol validation, and disabled RPC tests passed")
    }
}
