import AppKit
import CoreGraphics

func currentDisplay(uuid: String) throws -> CGDirectDisplayID {
    guard let requested = UUID(uuidString: uuid) else { throw HelperFailure.message("Invalid virtual display identity.") }
    var count: UInt32 = 0
    guard CGGetOnlineDisplayList(0, nil, &count) == .success, count <= 64 else {
        throw HelperFailure.message("Couldn't list the selected node's displays.")
    }
    var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetOnlineDisplayList(count, &displays, &count) == .success else {
        throw HelperFailure.message("The selected node's displays changed.")
    }
    for id in displays.prefix(Int(count)) {
        guard let identity = CGDisplayCreateUUIDFromDisplayID(id)?.takeRetainedValue(),
              UUID(uuidString: CFUUIDCreateString(nil, identity) as String) == requested else { continue }
        guard CGDisplayIsBuiltin(id) == 0, CGDisplayIsMain(id) == 0,
              CGDisplayIsInMirrorSet(id) == 0, CGDisplayMirrorsDisplay(id) == kCGNullDirectDisplay else {
            throw HelperFailure.message("The helper won't capture a main, built-in, or mirrored display.")
        }
        return id
    }
    throw HelperFailure.message("The virtual display is no longer connected.")
}

/// BetterDisplay's own inventory must identify this as a Subshell virtual
/// screen. A caller-supplied CoreGraphics ID alone could name a real monitor.
func verifyBetterDisplay(uuid: String, name: String) async throws {
    guard name.hasPrefix("Subshell-"), UUID(uuidString: String(name.dropFirst(9))) != nil,
          UUID(uuidString: uuid) != nil else { throw HelperFailure.message("Invalid Subshell display identity.") }
    let executable = await MainActor.run {
        NSRunningApplication.runningApplications(withBundleIdentifier: "pro.betterdisplay.BetterDisplay")
            .first(where: { $0.isFinishedLaunching })?.executableURL
    }
    guard let executable else { throw HelperFailure.message("Open BetterDisplay on the selected node first.") }
    let output = try await Task.detached {
        let process = Process()
        process.executableURL = executable
        process.arguments = ["get", "-identifiers"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        try process.run()
        let deadline = DispatchWorkItem { if process.isRunning { kill(process.processIdentifier, SIGKILL) } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 4, execute: deadline)
        defer { deadline.cancel(); try? pipe.fileHandleForReading.close() }
        var output = Data()
        while true {
            let chunk = pipe.fileHandleForReading.availableData
            if chunk.isEmpty { break }
            guard output.count + chunk.count <= 131_072 else {
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                process.waitUntilExit()
                throw HelperFailure.message("BetterDisplay returned too much data.")
            }
            output.append(chunk)
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw HelperFailure.message("BetterDisplay didn't answer. Check its CLI access setting.") }
        return output
    }.value
    guard let text = String(data: output, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty,
          let json = (text.hasPrefix("[") ? text : "[\(text)]").data(using: .utf8),
          let entries = try JSONSerialization.jsonObject(with: json) as? [[String: Any]], entries.count <= 64 else {
        throw HelperFailure.message("Couldn't verify BetterDisplay's display inventory.")
    }
    let matches = entries.filter { ($0["UUID"] as? String)?.lowercased() == uuid.lowercased() }
    guard matches.count == 1, matches[0]["deviceType"] as? String == "VirtualScreen",
          matches[0]["name"] as? String == name else {
        throw HelperFailure.message("The requested screen isn't a Subshell virtual display.")
    }
}
