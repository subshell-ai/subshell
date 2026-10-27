import AppKit
import CoreGraphics

/// Whether the pointer is stranded: it has to fall inside at least one
/// screen's frame, or the person sitting at this Mac cannot see it at all.
///
/// Pure so the rule is testable without a display or a cursor.
func cursorIsStranded(point: CGPoint, screens: [CGRect]) -> Bool {
    !screens.contains { $0.contains(point) }
}

/// Put the pointer back on the built-in display when a viewing session has
/// left it stranded.
///
/// A viewer's pointer events move the REAL system cursor onto the virtual
/// display; that is how shared control works on a single macOS desktop. If the
/// phantom screen disappears while the cursor is on it (pane closed, display
/// discarded, helper quit), the local person is left with no visible cursor
/// and no way to know why, which is exactly what happened on the M5. Only
/// warping when stranded leaves a person's own pointer where they put it.
@MainActor func restoreStrandedCursor() {
    let point = NSEvent.mouseLocation
    let frames = NSScreen.screens.map(\.frame)
    guard cursorIsStranded(point: point, screens: frames) else { return }
    // The display carrying the origin is the one macOS treats as home.
    let home = frames.first(where: { $0.origin == .zero }) ?? frames.first
    guard let home else { return }
    CGWarpMouseCursorPosition(CGPoint(x: home.midX, y: home.midY))
    CGAssociateMouseAndMouseCursorPosition(1)
}
