import AppKit
import ApplicationServices

@MainActor
final class DisplayInput {
    private let uuid: String
    private let width: Int
    private let height: Int
    private let allowed: () -> Bool
    private let source = CGEventSource(stateID: .privateState)
    private var buttons = 0
    private var keys: [UInt32: CGKeyCode] = [:]
    private var target: pid_t?

    init(uuid: String, width: Int, height: Int, allowed: @escaping () -> Bool) {
        self.uuid = uuid; self.width = width; self.height = height; self.allowed = allowed
    }

    private func bounds() throws -> CGRect {
        guard allowed(), CGPreflightScreenCaptureAccess(), AXIsProcessTrusted() else { throw HelperFailure.message("Display input is disabled.") }
        return CGDisplayBounds(try currentDisplay(uuid: uuid))
    }

    func pointer(x: Int, y: Int, mask: Int) throws {
        let bounds = try bounds()
        guard x >= 0, x < width, y >= 0, y < height, mask >= 0, mask <= 127 else {
            throw HelperFailure.message("Invalid display pointer event.")
        }
        let point = CGPoint(x: bounds.minX + Double(x) * bounds.width / Double(width),
                            y: bounds.minY + Double(y) * bounds.height / Double(height))
        let drag: CGEventType = buttons & 1 != 0 ? .leftMouseDragged : buttons & 4 != 0 ? .rightMouseDragged : buttons & 2 != 0 ? .otherMouseDragged : .mouseMoved
        let dragButton: CGMouseButton = buttons & 1 != 0 ? .left : buttons & 4 != 0 ? .right : buttons & 2 != 0 ? .center : .left
        CGEvent(mouseEventSource: source, mouseType: drag, mouseCursorPosition: point, mouseButton: dragButton)?.post(tap: .cghidEventTap)
        let mappings: [(Int, CGMouseButton, CGEventType, CGEventType)] = [
            (1, .left, .leftMouseDown, .leftMouseUp), (2, .center, .otherMouseDown, .otherMouseUp),
            (4, .right, .rightMouseDown, .rightMouseUp)
        ]
        for (bit, button, down, up) in mappings where (mask & bit) != (buttons & bit) {
            CGEvent(mouseEventSource: source, mouseType: mask & bit != 0 ? down : up,
                    mouseCursorPosition: point, mouseButton: button)?.post(tap: .cghidEventTap)
        }
        for (bit, amount, horizontal) in [(8, 80, false), (16, -80, false), (32, 80, true), (64, -80, true)] where mask & bit != 0 && buttons & bit == 0 {
            CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                    wheel1: horizontal ? 0 : Int32(amount), wheel2: horizontal ? Int32(amount) : 0, wheel3: 0)?.post(tap: .cghidEventTap)
        }
        buttons = mask
    }

    private func focusedTarget(in bounds: CGRect) throws -> pid_t {
        guard let app = NSWorkspace.shared.frontmostApplication else { throw HelperFailure.message("Click a window on the virtual display before typing.") }
        let element = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(element, 0.05)
        var window: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXFocusedWindowAttribute as CFString, &window) == .success,
              let window, CFGetTypeID(window) == AXUIElementGetTypeID() else {
            throw HelperFailure.message("Click a window on the virtual display before typing.")
        }
        let focused = unsafeBitCast(window, to: AXUIElement.self)
        AXUIElementSetMessagingTimeout(focused, 0.05)
        var position: CFTypeRef?; var size: CFTypeRef?
        guard AXUIElementCopyAttributeValue(focused, kAXPositionAttribute as CFString, &position) == .success,
              AXUIElementCopyAttributeValue(focused, kAXSizeAttribute as CFString, &size) == .success,
              let position, let size, CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else {
            throw HelperFailure.message("Couldn't verify the focused window's display.")
        }
        var point = CGPoint.zero; var dimensions = CGSize.zero
        guard AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &point),
              AXValueGetValue(unsafeBitCast(size, to: AXValue.self), .cgSize, &dimensions),
              dimensions.width > 0, dimensions.height > 0,
              bounds.contains(CGRect(origin: point, size: dimensions)) else {
            throw HelperFailure.message("Keep the focused window inside the virtual display before typing.")
        }
        return app.processIdentifier
    }

    func key(symbol: UInt32, down: Bool) throws {
        let bounds = try bounds()
        let pid = try focusedTarget(in: bounds)
        if target != pid { release(); target = pid }
        let scalarValue = symbol & 0xff00_0000 == 0x0100_0000 ? symbol & 0x00ff_ffff : symbol
        if Self.codes[symbol] == nil {
            guard UnicodeScalar(scalarValue) != nil, scalarValue >= 32,
                  scalarValue < 0xff00 || scalarValue > 0xffff else { return }
        }
        guard !down || keys[symbol] != nil || keys.count < 256 else {
            release(); throw HelperFailure.message("Too many held keys. Release the keys and try again.")
        }
        let code = Self.keyCode(symbol: symbol)
        if down { keys[symbol] = code } else { keys.removeValue(forKey: symbol) }
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { return }
        var flags: CGEventFlags = []
        for (symbols, flag) in [([UInt32(0xffe1), 0xffe2], CGEventFlags.maskShift),
                                ([0xffe3, 0xffe4], .maskControl), ([0xffe9, 0xffea], .maskAlternate),
                                ([0xffe7, 0xffe8, 0xffeb, 0xffec], .maskCommand)] {
            if symbols.contains(where: { keys[$0] != nil }) { flags.insert(flag) }
        }
        event.flags = flags
        if Self.codes[symbol] == nil {
            guard let scalar = UnicodeScalar(scalarValue), scalarValue >= 32, scalarValue < 0xff00 || scalarValue > 0xffff else { return }
            let text = Array(String(scalar).utf16)
            event.keyboardSetUnicodeString(stringLength: text.count, unicodeString: text)
        }
        event.postToPid(pid)
    }

    func release() {
        if let target {
            for code in Set(keys.values) {
                let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
                event?.flags = []
                event?.postToPid(target)
            }
        }
        keys.removeAll(); target = nil
        let point = CGEvent(source: nil)?.location ?? .zero
        for (bit, button, up) in [(1, CGMouseButton.left, CGEventType.leftMouseUp),
                                  (2, .center, .otherMouseUp), (4, .right, .rightMouseUp)] where buttons & bit != 0 {
            CGEvent(mouseEventSource: source, mouseType: up, mouseCursorPosition: point, mouseButton: button)?.post(tap: .cghidEventTap)
        }
        buttons = 0
    }

    // Unicode supplies text; virtual key codes still select native shortcuts.
    // Using key code zero for every letter turns Command-C into Command-A.
    static func keyCode(symbol: UInt32) -> CGKeyCode {
        if let code = codes[symbol] { return code }
        let value = symbol & 0xff00_0000 == 0x0100_0000 ? symbol & 0x00ff_ffff : symbol
        guard let scalar = UnicodeScalar(value) else { return 0 }
        return ansiCodes[String(scalar).lowercased()] ?? 0
    }

    private static let ansiCodes: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
        "1": 18, "!": 18, "2": 19, "@": 19, "3": 20, "#": 20, "4": 21, "$": 21,
        "6": 22, "^": 22, "5": 23, "%": 23, "=": 24, "+": 24, "9": 25, "(": 25,
        "7": 26, "&": 26, "-": 27, "_": 27, "8": 28, "*": 28, "0": 29, ")": 29,
        "]": 30, "}": 30, "o": 31, "u": 32, "[": 33, "{": 33, "i": 34, "p": 35,
        "l": 37, "j": 38, "'": 39, "\"": 39, "k": 40, ";": 41, ":": 41,
        "\\": 42, "|": 42, ",": 43, "<": 43, "/": 44, "?": 44, "n": 45, "m": 46,
        ".": 47, ">": 47, " ": 49, "`": 50, "~": 50
    ]

    private static let codes: [UInt32: CGKeyCode] = [
        0xff08: 51, 0xff09: 48, 0xff0d: 36, 0xff1b: 53, 0xffff: 117,
        0xff50: 115, 0xff57: 119, 0xff51: 123, 0xff52: 126, 0xff53: 124, 0xff54: 125,
        0xff55: 116, 0xff56: 121, 0xffe1: 56, 0xffe2: 60, 0xffe3: 59, 0xffe4: 62,
        0xffe9: 58, 0xffea: 61, 0xffe7: 55, 0xffe8: 54, 0xffeb: 55, 0xffec: 54,
        0xffbe: 122, 0xffbf: 120, 0xffc0: 99, 0xffc1: 118, 0xffc2: 96, 0xffc3: 97,
        0xffc4: 98, 0xffc5: 100, 0xffc6: 101, 0xffc7: 109, 0xffc8: 103, 0xffc9: 111
    ]
}
