import AppKit
import ScreenCaptureKit
import CoreImage
import CoreMedia

@MainActor
final class DisplayCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    let uuid: String
    let displayID: CGDirectDisplayID
    let width: Int
    let height: Int
    private let allowed: () -> Bool
    private let frame: (Data) -> Void
    private let lost: (String) -> Void
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var stream: SCStream?
    private var stopped = false
    private var permissionTimer: Timer?

    init(uuid: String, displayID: CGDirectDisplayID, width: Int, height: Int,
         allowed: @escaping () -> Bool, frame: @escaping (Data) -> Void, lost: @escaping (String) -> Void) {
        self.uuid = uuid; self.displayID = displayID; self.width = width; self.height = height
        self.allowed = allowed; self.frame = frame; self.lost = lost
    }

    func start() async throws {
        guard allowed(), CGPreflightScreenCaptureAccess(), try currentDisplay(uuid: uuid) == displayID else {
            throw HelperFailure.message("Enable the helper and allow Screen Recording on the selected node.")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard !stopped, allowed(), CGPreflightScreenCaptureAccess(), AXIsProcessTrusted(),
              (try? currentDisplay(uuid: uuid)) == displayID,
              let display = content.displays.first(where: { $0.displayID == displayID }) else {
            throw HelperFailure.message("The virtual display is no longer available.")
        }
        let config = SCStreamConfiguration()
        config.width = width; config.height = height
        config.minimumFrameInterval = CMTime(value: 1, timescale: 5)
        config.queueDepth = 3
        config.capturesAudio = false
        config.showsCursor = true
        let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: config, delegate: self)
        self.stream = stream
        permissionTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, !self.stopped else { return }
                guard self.allowed(), CGPreflightScreenCaptureAccess(), AXIsProcessTrusted(),
                      (try? currentDisplay(uuid: self.uuid)) == self.displayID else {
                    self.stop(); self.lost("Display access ended."); return
                }
            }
        }
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: .main)
        try await startCaptureWhileAllowed(
            start: { try await stream.startCapture() },
            stop: { try? await stream.stopCapture() },
            allowed: { !self.stopped && self.allowed() && CGPreflightScreenCaptureAccess()
                && AXIsProcessTrusted() && (try? currentDisplay(uuid: self.uuid)) == self.displayID }
        )
    }

    nonisolated func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        MainActor.assumeIsolated {
            guard !stopped, type == .screen else { return }
            guard allowed(), CGPreflightScreenCaptureAccess(), AXIsProcessTrusted(),
                  (try? currentDisplay(uuid: uuid)) == displayID else {
                stop(); lost("Display access ended."); return
            }
            guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let status = attachments.first?[.status] as? Int, status == SCFrameStatus.complete.rawValue,
                  let pixelBuffer = sampleBuffer.imageBuffer else { return }
            guard CVPixelBufferGetWidth(pixelBuffer) == width, CVPixelBufferGetHeight(pixelBuffer) == height else {
                stop(); lost("The virtual display's dimensions changed."); return
            }
            let image = CIImage(cvPixelBuffer: pixelBuffer)
            guard let cgImage = context.createCGImage(image, from: image.extent),
                  let jpeg = NSBitmapImageRep(cgImage: cgImage).representation(using: .jpeg, properties: [.compressionFactor: 0.7]),
                  jpeg.count <= 0x3f_ffff else { stop(); lost("The display frame exceeded its limit."); return }
            frame(jpeg)
        }
    }

    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task { @MainActor in
            guard !stopped else { return }
            stop(); lost("macOS stopped the virtual display capture.")
        }
    }

    func stop() {
        stopped = true
        permissionTimer?.invalidate(); permissionTimer = nil
        if let stream {
            self.stream = nil
            Task { try? await stream.stopCapture() }
        }
    }
}

/// Disable can stop a stream while its asynchronous start is still pending.
/// Stop that same stream again after startup completes, even if the owner has
/// already cleared its stream reference. Re-enabling doesn't revive this start.
@MainActor
func startCaptureWhileAllowed(start: () async throws -> Void, stop: () async -> Void,
                              allowed: () -> Bool) async throws {
    try await start()
    guard allowed() else {
        await stop()
        throw HelperFailure.message("Display access ended while capture was starting.")
    }
}
