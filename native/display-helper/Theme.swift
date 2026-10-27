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
enum AccessReport {
    /// What the status menu calls itself. The bar item is only an icon, so a
    /// person who clicks it without hovering the tooltip has nothing else
    /// telling them which helper this menu belongs to.
    static let heading = "Subshell virtual display helper"

    /// The tooltip on the status item: honest about who is doing what.
    static func tooltip(enabled: Bool, viewers: Int) -> String {
        if viewers > 0 {
            return "Subshell is viewing a virtual display on this Mac"
                + (viewers == 1 ? "" : " (\(viewers) viewers)")
        }
        return enabled ? "Subshell virtual display helper enabled" : "Subshell virtual display helper disabled"
    }
}
