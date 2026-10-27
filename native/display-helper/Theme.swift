import AppKit

/// The Subshell palette and type roles, mirrored from
/// `apps/server/web/src/styles.css` so this panel reads as the same product as
/// the dashboard rather than as a foreign system dialog.
///
/// The numbers are the CSS tokens themselves (L, C, H) converted here, not
/// retyped hexes: a re-typed hex is a second source of truth that drifts the
/// moment the web palette moves, and `lint:design` only guards the web and
/// mobile halves. The conversion is pure and tested.
///
/// The web theme is dark-only, so the panel pins `darkAqua` instead of
/// following the system appearance: a light-mode aqua button sitting on the
/// void ground looks broken, not themed.
enum Theme {
    /// Token name to (oklch L, C, H) exactly as `styles.css` declares them.
    static let tokens: [String: (l: Double, c: Double, h: Double)] = [
        "background": (0.224, 0.035, 296),
        "card": (0.255, 0.032, 296),
        "foreground": (0.92, 0.03, 312),
        "primary": (0.75, 0.17, 322),
        "primary-foreground": (0.16, 0.05, 322),
        "secondary": (0.29, 0.034, 296),
        "muted-foreground": (0.74, 0.04, 310),
        "destructive": (0.65, 0.2, 25),
        "warning": (0.828, 0.189, 84.429),
        "success": (0.765, 0.177, 163.223),
        "border": (0.33, 0.035, 296),
    ]

    /// The panel's ground: the same void the dashboard draws.
    static let background = color("background")
    /// Section plates, the token cards use.
    static let card = color("card")
    static let foreground = color("foreground")
    /// Secondary text: metadata, permission lines, timestamps.
    static let mutedForeground = color("muted-foreground")
    /// Brand accent: links, the enabled state, the primary control.
    static let primary = color("primary")
    static let primaryForeground = color("primary-foreground")
    static let secondary = color("secondary")
    /// Gold: the operator can fix this (the same role `text-warning` holds).
    static let warning = color("warning")
    /// Red: what the machine refused (the same role `text-destructive` holds).
    static let destructive = color("destructive")
    static let success = color("success")
    static let border = color("border")

    /// Type roles at two weights, the sizes the web token file declares:
    /// heading 20/600, label 15/600, body 14/400, detail 13/400. There is no
    /// 12px: detail is the floor, same rule the dashboard obeys.
    static let headingFont = NSFont.systemFont(ofSize: 20, weight: .semibold)
    static let labelFont = NSFont.systemFont(ofSize: 15, weight: .semibold)
    static let bodyFont = NSFont.systemFont(ofSize: 14, weight: .regular)
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

/// What the menu bar and the panel say while someone is watching a screen.
/// Pure so the wording is testable without a window or a status item.
enum AccessReport {
    /// The tooltip on the status item: honest about who is doing what.
    static func tooltip(enabled: Bool, viewers: Int) -> String {
        if viewers > 0 {
            return "Subshell is viewing a virtual display on this Mac"
                + (viewers == 1 ? "" : " (\(viewers) viewers)")
        }
        return enabled ? "Subshell virtual display helper enabled" : "Subshell virtual display helper disabled"
    }

    /// The panel's live line. Gold while anyone is watching, muted otherwise:
    /// same role split the dashboard uses for "the machine's owner should see
    /// this" versus plain metadata.
    static func panelLine(viewers: Int) -> (text: String, warning: Bool) {
        guard viewers > 0 else { return ("No one is viewing a virtual display on this Mac.", false) }
        let plural = viewers == 1 ? "viewer is" : "viewers are"
        return ("A Subshell \(plural) watching this Mac's virtual display right now.", true)
    }
}
