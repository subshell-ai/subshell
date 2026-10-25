import Foundation
import Darwin

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
