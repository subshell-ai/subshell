import AppKit
import ApplicationServices

@MainActor
final class HelperRuntime {
    private let consent: HelperConsent
    private let listener: HelperListener
    private var connections: [UUID: HelperConnection] = [:]
    private var captures: [UUID: DisplayCapture] = [:]
    private var inputs: [UUID: DisplayInput] = [:]
    private var reservations: [UUID: Int] = [:]
    private var pending = Set<UUID>()
    private var rates: [UUID: (TimeInterval, Int)] = [:]
    var onStateChange: (() -> Void)?

    init(consent: HelperConsent, listener: HelperListener? = nil) {
        self.listener = listener ?? HelperListener()
        self.consent = consent
        self.listener.onConnection = { [weak self] in self?.accept($0) }
    }

    func listenForStatus() throws { try listener.start() }

    /// How many subshell screens are being captured right now. The menu bar
    /// badge, the tooltip, and the panel's live line all read this, so the
    /// person sitting at the Mac can see when someone is looking at a virtual
    /// display rather than having to infer it.
    var viewers: Int { captures.count }

    func shutdown() {
        listener.stop()
        for connection in Array(connections.values) { connection.close() }
    }

    func enable() throws {
        try listener.start()
        consent.setEnabled(true)
        onStateChange?()
    }

    func disable() {
        consent.setEnabled(false)
        for connection in Array(connections.values) { connection.close() }
        onStateChange?()
    }

    private func accept(_ connection: HelperConnection) {
        guard connections.count < 16 else { connection.close(); return }
        connections[connection.id] = connection
        connection.onRequest = { [weak self, weak connection] request in
            guard let self, let connection else { return }
            self.handle(request, connection)
        }
        let id = connection.id
        connection.onClose = { [weak self] in self?.remove(id) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self, weak connection] in
            guard let self, let connection, (self.captures[connection.id] == nil || self.pending.contains(connection.id)) else { return }
            connection.close()
        }
    }

    private func remove(_ id: UUID) {
        inputs.removeValue(forKey: id)?.release()
        if let capture = captures.removeValue(forKey: id) {
            capture.stop()
            // The menu bar badge and the panel's live line report who is
            // being watched, so a capture ending has to announce itself.
            onStateChange?()
        }
        connections.removeValue(forKey: id)
        pending.remove(id); reservations.removeValue(forKey: id); rates.removeValue(forKey: id)
    }

    private func handle(_ request: [String: Any], _ connection: HelperConnection) {
        // `rescue-cursor` is allowed without consent: by the time the daemon
        // asks for it the display it stranded the pointer on is already gone,
        // and the action only puts the cursor back where the person at this
        // Mac can see it.
        guard let operation = request["op"] as? String,
              consent.enabled || operation == "status" || operation == "rescue-cursor"
        else { connection.close(); return }
        let now = ProcessInfo.processInfo.systemUptime
        let previous = rates[connection.id] ?? (now, 0)
        let rate = now - previous.0 >= 1 ? (now, 1) : (previous.0, previous.1 + 1)
        rates[connection.id] = rate
        guard rate.1 <= 200 else { connection.close(); return }
        do {
            switch operation {
            case "status":
                connection.send(["type": "status", "protocol": 1, "enabled": consent.enabled,
                                 "screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted(),
                                 "betterDisplayExecutable": NSRunningApplication.runningApplications(withBundleIdentifier: "pro.betterdisplay.BetterDisplay")
                                    .first(where: { $0.isFinishedLaunching })?.executableURL?.path as Any? ?? NSNull()])
            case "start":
                guard captures[connection.id] == nil, !pending.contains(connection.id),
                      let uuid = request["uuid"] as? String, let name = request["name"] as? String,
                      let width = integer(request["width"], maximum: 4096), width >= 320,
                      let height = integer(request["height"], maximum: 4096), height >= 320 else {
                    throw HelperFailure.message("Invalid display capture request.")
                }
                guard CGPreflightScreenCaptureAccess(), AXIsProcessTrusted() else {
                    throw HelperFailure.message("Allow Screen Recording and Accessibility in the helper's settings on the selected node.")
                }
                guard reservations.count < 4, reservations.values.reduce(0, +) + width * height <= 16_777_216 else {
                    throw HelperFailure.message("The helper's display capture limit is reached. Close a subshell using a virtual display on this Mac to free capacity. Closing only its viewer doesn't free capacity.")
                }
                reservations[connection.id] = width * height
                pending.insert(connection.id)
                Task { await start(connection, uuid: uuid, name: name, width: width, height: height) }
            case "pointer":
                guard let input = inputs[connection.id], let x = integer(request["x"], maximum: 4095),
                      let y = integer(request["y"], maximum: 4095), let mask = integer(request["mask"], maximum: 127) else {
                    throw HelperFailure.message("Invalid display pointer event.")
                }
                try input.pointer(x: x, y: y, mask: mask)
            case "key":
                guard let input = inputs[connection.id], let symbol = integer(request["symbol"], maximum: Int(UInt32.max)),
                      let down = request["down"] as? NSNumber, CFGetTypeID(down) == CFBooleanGetTypeID() else {
                    throw HelperFailure.message("Invalid display keyboard event.")
                }
                do { try input.key(symbol: UInt32(symbol), down: down.boolValue) }
                catch { input.release(); connection.send(["type": "input_blocked", "message": error.localizedDescription]) }
            case "release": inputs[connection.id]?.release()
            case "stop": connection.close()
            case "rescue-cursor":
                restoreStrandedCursor()
                connection.send(["type": "rescued", "protocol": 1])
            default: throw HelperFailure.message("Unknown helper request.")
            }
        } catch {
            connection.send(["type": "error", "message": error.localizedDescription])
            connection.close()
        }
    }

    private func start(_ connection: HelperConnection, uuid: String, name: String, width: Int, height: Int) async {
        do {
            try await verifyBetterDisplay(uuid: uuid, name: name)
            guard consent.enabled, connections[connection.id] != nil else { return }
            let displayID = try currentDisplay(uuid: uuid)
            let allowed = { [weak self] in self?.consent.enabled == true && self?.connections[connection.id] != nil }
            let capture = DisplayCapture(uuid: uuid, displayID: displayID, width: width, height: height,
                allowed: allowed, frame: { [weak connection] jpeg in
                    connection?.send(["type": "frame", "jpeg": jpeg.base64EncodedString(), "width": width, "height": height])
                }, lost: { [weak connection] message in
                    connection?.send(["type": "error", "message": message]); connection?.close()
                })
            captures[connection.id] = capture
            inputs[connection.id] = DisplayInput(uuid: uuid, width: width, height: height, allowed: allowed)
            try await capture.start()
            guard allowed() else { capture.stop(); onStateChange?(); return }
            onStateChange?()
            pending.remove(connection.id)
            connection.send(["type": "started", "width": width, "height": height])
        } catch {
            connection.send(["type": "error", "message": error.localizedDescription])
            connection.close()
        }
    }
}

func integer(_ value: Any?, maximum: Int) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
          number.doubleValue >= 0, number.doubleValue <= Double(maximum) else { return nil }
    return number.intValue
}
