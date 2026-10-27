import AppKit

/// The three colours and one type role the native chrome still needs.
///
/// The panel's own page draws the palette itself, from
/// `packages/assistant/tokens.css`, so this file is no longer a mirror of the
/// whole theme: what is left is what AppKit must still paint by hand, the
/// window's ground behind the web view, the muted text and `detail` size of the
/// "the bundle has no panel" label, and the gold the status item takes on while
/// someone is watching.
///
/// The numbers are the CSS tokens themselves (L, C, H) converted here, not
/// retyped hexes: a re-typed hex is a second source of truth that drifts the
/// moment the web palette moves, and `lint:design` only guards the web and
/// mobile halves. The conversion is pure and tested.
///
/// The web theme is dark-only, so the panel pins `darkAqua` instead of
/// following the system appearance: a light-mode aqua title bar sitting on the
/// void ground looks broken, not themed.
enum Theme {
    /// Token name to (oklch L, C, H) exactly as `packages/assistant/tokens.css`
    /// declares them. Add a row only when native chrome has to draw it.
    static let tokens: [String: (l: Double, c: Double, h: Double)] = [
        "background": (0.224, 0.035, 296),
        "muted-foreground": (0.74, 0.04, 310),
        "warning": (0.828, 0.189, 84.429),
    ]

    /// The panel's ground: the same void the dashboard draws.
    static let background = color("background")
    /// Secondary text: metadata and anything the page could not render.
    static let mutedForeground = color("muted-foreground")
    /// Gold: the operator can fix this (the same role `text-warning` holds).
    static let warning = color("warning")

    /// The `detail` role (13px at 400). There is no 12px: detail is the floor,
    /// the same rule the dashboard obeys.
    static let detailFont = NSFont.systemFont(ofSize: 13, weight: .regular)

    /// The token as sRGB components. Oklab's inverse transform, then the
    /// sRGB transfer curve, clamped to the gamut the way CSS does.
    static func srgb(_ name: String) -> (red: Double, green: Double, blue: Double) {
        guard let token = tokens[name] else { preconditionFailure("unknown token \(name)") }
        let h = token.h * Double.pi / 180
        let a = token.c * cos(h)
        let b = token.c * sin(h)
        let l_ = token.l + 0.396_337_777_4 * a + 0.215_803_757_3 * b
        let m_ = token.l - 0.105_561_345_8 * a - 0.063_854_172_8 * b
        let s_ = token.l - 0.089_484_177_5 * a - 1.291_485_548 * b
        let l = l_ * l_ * l_
        let m = m_ * m_ * m_
        let s = s_ * s_ * s_
        func encode(_ v: Double) -> Double {
            let x = min(max(v, 0), 1)
            return x <= 0.003_130_8 ? 12.92 * x : 1.055 * pow(x, 1 / 2.4) - 0.055
        }
        return (encode(4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s),
                encode(-1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s),
                encode(-0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701 * s))
    }

    static func color(_ name: String) -> NSColor {
        let rgb = srgb(name)
        return NSColor(srgbRed: rgb.red, green: rgb.green, blue: rgb.blue, alpha: 1)
    }
}

/// What the menu bar says while someone is watching a screen. Pure so the
/// wording is testable without a status item. The panel's own copy lives in
/// `packages/helper-panel/src/strings.ts`; keep a sentence in one of the two,
/// not both.
#if os(macOS)
import ServiceManagement

/// The login item's state, in the three words the page renders. Kept apart
/// because each needs a different sentence: `requiresApproval` is macOS waiting
/// for a switch the person has not thrown, while `notRegistered` means the item
/// is not in the list at all, which is what turning it OFF in System Settings
/// leaves behind. Reading both as approved is how a disabled sign-in start kept
/// claiming it starts at sign-in.
enum LoginItem {
    /// macOS's answer right now, in the word the page uses. Callers that are
    /// not the web view (the quit alert, mainly) read the registration through
    /// this rather than importing ServiceManagement themselves.
    static func currentPageState() -> String {
        pageState(SMAppService.mainApp.status)
    }

    static func pageState(_ status: SMAppService.Status) -> String {
        switch status {
        case .enabled: return "registered"
        case .requiresApproval: return "needsApproval"
        default: return "notRegistered"
        }
    }
}
#endif

/// Deep links into System Settings' Privacy & Security panes. A granted
/// permission still deserves a way to the place it was granted, and re-running
/// the request prompt would open nothing.
enum SettingsRoute {
    static let screenRecording = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    static let accessibility = "x-apple.systempreferences:com.apple.preference.security?Accessibility"
}

enum AccessReport {
    /// What the status menu calls itself. The bar item is only an icon, so a
    /// person who clicks it without hovering the tooltip has nothing else
    /// telling them which helper this menu belongs to.
    static let heading = "Subshell virtual display helper"

    /// What the one consent item is called, in the panel and in the status menu
    /// alike. The menu used to offer only "Disable helper", so a person who had
    /// just disabled the helper found the way back was a settings window.
    static func toggleTitle(enabled: Bool) -> String {
        return enabled ? "Disable helper" : "Enable helper"
    }

    /// The tooltip on the status item: honest about who is doing what.
    static func tooltip(enabled: Bool, viewers: Int) -> String {
        if viewers > 0 {
            return "Subshell is viewing a virtual display on this Mac"
                + (viewers == 1 ? "" : " (\(viewers) viewers)")
        }
        return enabled ? "Subshell virtual display helper enabled" : "Subshell virtual display helper disabled"
    }
}

/// The quit confirmation, worded once for both doors. The panel's Quit and the
/// status menu's Quit ask the same question, because the consequence (everyone
/// watching loses the screen now) belongs to the act, not to which control
/// started it. `packages/helper-panel/src/strings.ts` carries the originals the
/// panel renders; the helper-panel suite fails if these drift from them.
enum QuitCopy {
    static let title = "Quit the display helper?"
    static let confirm = "Quit helper"
    static let cancel = "Cancel"

    /// The body reads the registration state rather than assuming one: enabling
    /// never registered a login item and disabling never removes one, so
    /// promising a return at sign-in to someone who never asked for it would be
    /// a warning that misleads instead of informing. The three sentences match
    /// `quitBody` in the panel's `strings.ts`, which the helper-panel suite
    /// compares these against.
    // One whole literal per reachable pair rather than a shared prefix, so the
    // parity test can compare sentences between the two files. Consent is part
    // of the answer because a registered helper that is switched off does come
    // back at sign-in and then exits without capturing anything: telling that
    // person "it starts again at sign-in" describes a return that delivers no
    // screen, and sending them to Stop at sign-in to prevent it asks them to
    // fix something that is not broken.
    static func body(loginItem: String, consented: Bool) -> String {
        switch (loginItem, consented) {
        case ("registered", true):
            return "Anyone watching a virtual display on this Mac loses it now. Your consent and the macOS permissions stay. The helper starts again at sign-in, or sooner from Subshell's virtual display settings. To stop it coming back, use the panel's Stop at sign-in button first."
        case ("registered", false):
            return "Anyone watching a virtual display on this Mac loses it now. Your consent and the macOS permissions stay. The helper is disabled, so at sign-in it starts and exits without capturing anything. To take it out of macOS's login list, choose Stop at sign-in in the panel first."
        case ("needsApproval", _):
            return "Anyone watching a virtual display on this Mac loses it now. Your consent and the macOS permissions stay. macOS is still waiting for your approval before it would start at sign-in, so it comes back when you open Subshell's virtual display settings."
        default:
            return "Anyone watching a virtual display on this Mac loses it now. Your consent and the macOS permissions stay. Nothing starts it at sign-in; it comes back when you open Subshell's virtual display settings."
        }
    }
}
