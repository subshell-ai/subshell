import Foundation
import Darwin

enum HelperFailure: Error, LocalizedError {
    case message(String)
    var errorDescription: String? { switch self { case .message(let message): return message } }
}

@MainActor
final class HelperListener {
    nonisolated static var directory: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Caches/Subshell/display-helper")
    }
    nonisolated static var socketPath: String { directory.appendingPathComponent("control.sock").path }
    private let location: URL
    private var localSocketPath: String { location.appendingPathComponent("control.sock").path }
    init(directory: URL = HelperListener.directory) { location = directory }
    private var descriptor: Int32 = -1
    private var lockDescriptor: Int32 = -1
    private var source: DispatchSourceRead?
    var onConnection: ((HelperConnection) -> Void)?

    func start() throws {
        guard descriptor < 0 else { return }
        let directory = location
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        lockDescriptor = open(directory.appendingPathComponent("owner.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard lockDescriptor >= 0 else { throw HelperFailure.message("Couldn't lock the helper's local connection.") }
        guard flock(lockDescriptor, LOCK_EX | LOCK_NB) == 0 else {
            Darwin.close(lockDescriptor); lockDescriptor = -1
            throw HelperFailure.message("Another display helper is already running. Open its settings to manage it.")
        }
        do {
            var address = sockaddr_un()
            address.sun_family = sa_family_t(AF_UNIX)
            let path = Array(localSocketPath.utf8CString)
            guard path.count <= MemoryLayout.size(ofValue: address.sun_path) else {
                throw HelperFailure.message("The account's home path is too long for the helper's local connection.")
            }
            withUnsafeMutableBytes(of: &address.sun_path) { destination in
                for (index, byte) in path.enumerated() { destination[index] = UInt8(bitPattern: byte) }
            }
            address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
            descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
            guard descriptor >= 0 else { throw HelperFailure.message("Couldn't create the helper's local connection.") }
            guard fcntl(descriptor, F_SETFL, O_NONBLOCK) == 0 else {
                throw HelperFailure.message("Couldn't configure the helper's local connection.")
            }
            unlink(localSocketPath)
            let bound = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            guard bound == 0, chmod(localSocketPath, 0o600) == 0, listen(descriptor, 16) == 0 else {
                throw HelperFailure.message("Couldn't open the helper's local connection.")
            }
            let source = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: .main)
            source.setEventHandler { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    let client = accept(self.descriptor, nil, nil)
                    guard client >= 0 else { return }
                    var uid: uid_t = 0; var gid: gid_t = 0
                    guard getpeereid(client, &uid, &gid) == 0, uid == getuid() else { Darwin.close(client); return }
                    if let connection = HelperConnection(client) { self.onConnection?(connection) }
                }
            }
            self.source = source; source.resume()
        } catch { stop(); throw error }
    }

    func stop() {
        source?.cancel(); source = nil
        if descriptor >= 0 { Darwin.close(descriptor); descriptor = -1; unlink(localSocketPath) }
        if lockDescriptor >= 0 { flock(lockDescriptor, LOCK_UN); Darwin.close(lockDescriptor); lockDescriptor = -1 }
    }
}
