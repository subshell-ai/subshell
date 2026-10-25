// Development probe only. The production node never imports or starts this app.
import AppKit
import ApplicationServices
import ScreenCaptureKit

enum ProbeError: Error, CustomStringConvertible {
    case message(String)
    var description: String {
        switch self { case .message(let message): return message }
    }
}

func displayUUID(_ id: CGDirectDisplayID) -> String? {
    guard let uuid = CGDisplayCreateUUIDFromDisplayID(id)?.takeRetainedValue() else { return nil }
    return CFUUIDCreateString(nil, uuid) as String
}

func onlineDisplays() throws -> [CGDirectDisplayID] {
    var count: UInt32 = 0
    guard CGGetOnlineDisplayList(0, nil, &count) == .success, count <= 64 else {
        throw ProbeError.message("Couldn't list the Mac's displays.")
    }
    var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetOnlineDisplayList(count, &displays, &count) == .success else {
        throw ProbeError.message("The Mac's display list changed. Run the probe again.")
    }
    return Array(displays.prefix(Int(count)))
}

func selectedDisplay(_ uuid: String) throws -> CGDirectDisplayID {
    guard UUID(uuidString: uuid) != nil,
          let id = try onlineDisplays().first(where: { displayUUID($0)?.lowercased() == uuid.lowercased() }),
          CGDisplayIsMain(id) == 0, CGDisplayIsBuiltin(id) == 0,
          CGDisplayIsInMirrorSet(id) == 0, CGDisplayMirrorsDisplay(id) == kCGNullDirectDisplay else {
        throw ProbeError.message("The selected display is missing, mirrored, or the Mac's main or built-in display.")
    }
    return id
}

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

@MainActor
final class Probe: NSObject, NSApplicationDelegate {
    var window: NSWindow?
    var field: NSTextField?
    var safetyTimer: Timer?
    let args = Array(CommandLine.arguments.dropFirst())

    func applicationDidFinishLaunching(_ notification: Notification) {
        Task {
            do {
                switch args.first ?? "permissions" {
                case "readiness":
                    let displays = try onlineDisplays().map { id -> [String: Any] in
                        let bounds = CGDisplayBounds(id)
                        return ["id": id, "uuid": displayUUID(id) ?? "", "main": CGDisplayIsMain(id) != 0,
                                "builtIn": CGDisplayIsBuiltin(id) != 0, "width": bounds.width,
                                "height": bounds.height, "x": bounds.minX, "y": bounds.minY]
                    }
                    emit(["screenRecording": CGPreflightScreenCaptureAccess(),
                          "accessibility": AXIsProcessTrusted(), "displays": displays])
                    finish(0)
                case "permissions": showPermissions()
                case "capture":
                    guard args.count == 3 else { throw ProbeError.message("Expected capture UUID output.png.") }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
                        emit(["error": "Capture timed out. Check the Mac's permission prompts."])
                        self.finish(1)
                    }
                    try await capture(uuid: args[1], path: args[2])
                    finish(0)
                case "sample":
                    guard args.count == 2 else { throw ProbeError.message("Expected sample UUID.") }
                    try showSample(uuid: args[1])
                case "input":
                    guard args.count == 3, let pid = Int32(args[2]), pid > 0 else {
                        throw ProbeError.message("Expected input UUID sample-process-id.")
                    }
                    try checkInput(uuid: args[1], pid: pid)
                    finish(0)
                default: throw ProbeError.message("Unknown probe command.")
                }
            } catch {
                emit(["error": String(describing: error)])
                finish(1)
            }
        }
    }

    func finish(_ code: Int32) {
        safetyTimer?.invalidate()
        exit(code)
    }

    func makeWindow(title: String, frame: NSRect, screen: NSScreen? = nil) -> NSStackView {
        let window = NSWindow(contentRect: frame, styleMask: [.titled, .closable], backing: .buffered, defer: false, screen: screen)
        window.title = title
        window.isReleasedWhenClosed = false
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 16
        stack.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        window.contentView = stack
        self.window = window
        return stack
    }

    func showPermissions() {
        let stack = makeWindow(title: "Subshell Display Probe", frame: NSRect(x: 160, y: 160, width: 530, height: 240))
        stack.addArrangedSubview(NSTextField(wrappingLabelWithString:
            "This experiment captures one BetterDisplay virtual display. macOS requires Screen Recording for capture and Accessibility for input. The probe doesn't grant either permission itself."))
        stack.addArrangedSubview(NSButton(title: "Allow screen capture…", target: self, action: #selector(requestCapture)))
        stack.addArrangedSubview(NSButton(title: "Allow input control…", target: self, action: #selector(requestInput)))
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func requestCapture() { _ = CGRequestScreenCaptureAccess() }
    @objc func requestInput() {
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    }

    func capture(uuid: String, path: String) async throws {
        guard CGPreflightScreenCaptureAccess() else {
            throw ProbeError.message("Allow Screen Recording for Subshell Display Probe in macOS System Settings.")
        }
        let id = try selectedDisplay(uuid)
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == id }),
              display.width > 0, display.height > 0, display.width <= 4096, display.height <= 4096 else {
            throw ProbeError.message("The selected display isn't available for capture at a supported size.")
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = display.width
        config.height = display.height
        config.showsCursor = false
        config.capturesAudio = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        guard try selectedDisplay(uuid) == id else {
            throw ProbeError.message("The selected display changed during capture; the frame was discarded.")
        }
        guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            throw ProbeError.message("Couldn't encode the captured frame.")
        }
        try data.write(to: URL(fileURLWithPath: path), options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
        emit(["captured": uuid, "width": image.width, "height": image.height, "bytes": data.count])
    }

    func showSample(uuid: String) throws {
        let id = try selectedDisplay(uuid)
        guard let screen = NSScreen.screens.first(where: {
            ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id
        }) else { throw ProbeError.message("AppKit couldn't find the selected virtual display.") }
        let frame = NSRect(x: screen.frame.minX + 40, y: screen.frame.minY + 60, width: 550, height: 250)
        guard screen.visibleFrame.contains(frame) else { throw ProbeError.message("The display is too small for the sample window.") }
        let stack = makeWindow(title: "Subshell virtual display sample", frame: frame, screen: screen)
        stack.addArrangedSubview(NSTextField(labelWithString: "Subshell BetterDisplay experiment"))
        stack.addArrangedSubview(NSTextField(wrappingLabelWithString:
            "Only this virtual display should appear in the capture. Input is sent to this sample process; it doesn't test global keyboard focus."))
        let field = NSTextField(string: "")
        field.placeholderString = "Input test"
        field.widthAnchor.constraint(equalToConstant: 450).isActive = true
        stack.addArrangedSubview(field)
        self.field = field
        window?.makeFirstResponder(field)
        // NSWindow's initializer may constrain its frame to the main display.
        // Move after content layout and prove the resulting screen, not intent.
        window?.setFrameOrigin(frame.origin)
        window?.makeKeyAndOrderFront(nil)
        guard let window, screen.frame.contains(window.frame),
              (window.screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id else {
            self.window?.close()
            throw ProbeError.message("macOS didn't place the sample on the selected virtual display.")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 600) { self.finish(0) }
        // Removing a monitor relocates its windows. Close our sample immediately
        // instead of leaving it on the person's physical display.
        safetyTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                guard (try? selectedDisplay(uuid)) == id,
                      (self.window?.screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id else {
                    self.finish(0); return
                }
            }
        }
        emit(["sample": uuid, "pid": ProcessInfo.processInfo.processIdentifier,
              "windowFrame": NSStringFromRect(window.frame), "screenID": id])
    }

    func checkInput(uuid: String, pid: Int32) throws {
        _ = try selectedDisplay(uuid)
        guard AXIsProcessTrusted() else { throw ProbeError.message("Allow Accessibility for Subshell Display Probe first.") }
        guard let target = NSRunningApplication(processIdentifier: pid),
              target.bundleIdentifier == Bundle.main.bundleIdentifier,
              target.executableURL == Bundle.main.executableURL,
              pid != ProcessInfo.processInfo.processIdentifier else {
            throw ProbeError.message("Input is limited to another instance of this probe's sample app.")
        }
        let text = Array("subshell-input-ok".utf16)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
            throw ProbeError.message("Couldn't construct the sample keyboard event.")
        }
        down.keyboardSetUnicodeString(stringLength: text.count, unicodeString: text)
        up.keyboardSetUnicodeString(stringLength: text.count, unicodeString: text)
        down.postToPid(pid)
        up.postToPid(pid)
        emit(["inputSentTo": pid, "verification": "Capture the sample and check that its field contains subshell-input-ok."])
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = Probe()
    app.delegate = delegate
    app.run()
}
