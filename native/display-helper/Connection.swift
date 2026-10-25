import Foundation
import Darwin

/// Every descriptor is nonblocking so a stalled node cannot freeze Disable.
@MainActor
final class HelperConnection {
    let id = UUID()
    let descriptor: Int32
    private var reader: DispatchSourceRead?
    private var writer: DispatchSourceWrite?
    private var incoming = Data()
    private var outgoing = Data()
    private var closed = false
    var onRequest: (([String: Any]) -> Void)?
    var onClose: (() -> Void)?

    init?(_ descriptor: Int32) {
        self.descriptor = descriptor
        var yes: Int32 = 1
        guard fcntl(descriptor, F_SETFL, O_NONBLOCK) == 0,
              setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout.size(ofValue: yes))) == 0 else {
            Darwin.close(descriptor); return nil
        }
        let read = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: .main)
        read.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.receive() } }
        reader = read
        read.resume()
    }

    func send(_ object: [String: Any]) {
        guard !closed, let bytes = try? JSONSerialization.data(withJSONObject: object), bytes.count <= 6 * 1024 * 1024,
              outgoing.count + bytes.count + 1 <= 8 * 1024 * 1024 else { close(); return }
        outgoing.append(bytes); outgoing.append(10)
        flush()
    }

    private func receive() {
        guard !closed else { return }
        var bytes = [UInt8](repeating: 0, count: 16_384)
        let count = recv(descriptor, &bytes, bytes.count, 0)
        if count == 0 { close(); return }
        if count < 0 { if errno != EAGAIN && errno != EWOULDBLOCK { close() }; return }
        incoming.append(contentsOf: bytes.prefix(count))
        guard incoming.count <= 65_536 else { close(); return }
        while let newline = incoming.firstIndex(of: 10) {
            let line = incoming.prefix(upTo: newline)
            incoming.removeSubrange(...newline)
            guard let request = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { close(); return }
            onRequest?(request)
            if closed { return }
        }
    }

    private func flush() {
        guard !closed else { return }
        while !outgoing.isEmpty {
            let count = outgoing.withUnsafeBytes { Darwin.send(descriptor, $0.baseAddress, min($0.count, 65_536), 0) }
            if count > 0 { outgoing.removeFirst(count); continue }
            if count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
                if writer == nil {
                    let write = DispatchSource.makeWriteSource(fileDescriptor: descriptor, queue: .main)
                    write.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.flush() } }
                    writer = write; write.resume()
                }
                return
            }
            close(); return
        }
        writer?.cancel(); writer = nil
    }

    func close() {
        guard !closed else { return }
        closed = true
        reader?.cancel(); reader = nil
        writer?.cancel(); writer = nil
        Darwin.close(descriptor)
        incoming.removeAll(); outgoing.removeAll()
        let callback = onClose
        onClose = nil; onRequest = nil
        callback?()
    }
}
