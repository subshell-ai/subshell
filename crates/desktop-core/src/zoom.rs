//! The text-size ladder both desktop apps step through.
//!
//! Zoom is OWNED BY RUST in both apps, and that is a security property rather
//! than a style choice. Tauri's built-in `zoom_hotkeys_enabled` injects a page
//! script that invokes `plugin:webview|set_webview_zoom`, so it only works on
//! a window that has been granted that command — and `apps/client/desktop`'s
//! `main` window is granted exactly ONE command on purpose, which opens a page
//! in the system browser rather than resizing anything, because it shows a
//! control plane's own page from an origin this app cannot enumerate ahead of
//! time.
//! `WebviewWindow::set_zoom()` called from Rust goes nowhere near the IPC ACL,
//! so the level below reaches that window without widening its surface by one
//! command. (The polyfill also keeps its level in a page-local variable, which
//! a reload or a navigation resets.)
//!
//! A LADDER rather than a float: a step has to be predictable, the stored
//! value has to be one a later build still understands, and the rungs are
//! chosen so the small ones are small (a 10% nudge either side of normal is
//! most of what anyone wants) and the large ones are usable jumps.

/// Every text size the apps offer, ascending.
///
/// `1.0` is a rung, so [`zoom_out`] from `1.1` and [`zoom_in`] from `0.9` both
/// land on exactly the value "Actual Size" resets to — no near-miss that
/// leaves a window imperceptibly off normal.
pub const ZOOM_LEVELS: [f64; 8] = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0];

/// The size a window opens at when nothing has been chosen.
pub const ZOOM_DEFAULT: f64 = 1.0;

/// Snap an arbitrary stored value onto the ladder.
///
/// Clamped on READ rather than trusted, the same way
/// [`crate::tray::effective_close_to_tray`] is: `settings.json` is a plain
/// file a person can edit, and a `0` or a `NaN` in it is a window that cannot
/// be read and therefore cannot be fixed from inside the app. Snapping (not
/// merely bounding) is what keeps the invariant the steppers rely on — the
/// current level is always exactly one of [`ZOOM_LEVELS`].
pub fn clamp_zoom(stored: f64) -> f64 {
    if !stored.is_finite() {
        return ZOOM_DEFAULT;
    }
    let mut best = ZOOM_LEVELS[0];
    let mut best_gap = f64::INFINITY;
    for rung in ZOOM_LEVELS {
        let gap = (rung - stored).abs();
        if gap < best_gap {
            best_gap = gap;
            best = rung;
        }
    }
    best
}

/// The next rung up, or the top one when already there.
pub fn zoom_in(current: f64) -> f64 {
    let here = clamp_zoom(current);
    ZOOM_LEVELS.iter().copied().find(|rung| *rung > here).unwrap_or(here)
}

/// The next rung down, or the bottom one when already there.
pub fn zoom_out(current: f64) -> f64 {
    let here = clamp_zoom(current);
    ZOOM_LEVELS
        .iter()
        .copied()
        .rev()
        .find(|rung| *rung < here)
        .unwrap_or(here)
}

/// The level as a whole percentage, for a menu label.
pub fn zoom_percent(level: f64) -> u32 {
    (clamp_zoom(level) * 100.0).round() as u32
}

/// The assistant frame's design size (spec 2026-09-11 § 3.1, adopted by
/// `apps/client/desktop` in spec 2026-09-12 § 6.4).
///
/// Both apps' assistants are this one frame — a 560px column centred in the
/// region with a 72px bar under it — so the arithmetic lives once even though
/// each app builds its own window.
///
/// **Sized to the column it holds, since 2026-09-14.** It was 1024x720, which
/// was wrong twice over: the column is capped at 560px, so 232px of each side
/// was dead by construction, and the height did not fit a 1366x768 laptop —
/// the clamp below cut it to 688 on the most ordinary panel there is, which
/// is a design size failing the common case rather than the edge one. 720x620
/// leaves ~80px gutters and fits that panel untouched at every text size a
/// person is likely to pick. The floor on how small this may go is the
/// content: the column plus its gutters, and a bar that has to stay on
/// screen.
pub const ASSISTANT_WIDTH: f64 = 720.0;
pub const ASSISTANT_HEIGHT: f64 = 620.0;

/// Room reserved for OS chrome a monitor's work area does not already exclude
/// everywhere (a title bar, in particular), subtracted before clamping.
const ASSISTANT_MARGIN: f64 = 80.0;

/// The assistant frame at a given text size, clamped to what the display can
/// actually show.
///
/// Scaled because the frame is FIXED and non-resizable: bigger text in a frame
/// that cannot grow is bigger text with less room to say it in. Clamped
/// because a frame is only useful while the whole of it is on screen — the
/// window is not resizable, so a bottom edge past the work area takes the bar
/// carrying Continue with it and nothing inside the page can bring it back.
/// (Content overflowing the frame is a different, safe case: the bar is its
/// own row and the region above it scrolls.)
///
/// `None` — no monitor could be queried — keeps the scaled design size rather
/// than guessing at a display.
pub fn assistant_frame(level: f64, work_area: Option<(f64, f64)>) -> (f64, f64) {
    let level = clamp_zoom(level);
    let (width, height) = (ASSISTANT_WIDTH * level, ASSISTANT_HEIGHT * level);
    match work_area {
        Some((w, h)) if w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0 => {
            (width.min(w - ASSISTANT_MARGIN), height.min(h - ASSISTANT_MARGIN))
        }
        _ => (width, height),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ladder_ascends_and_holds_normal() {
        assert!(ZOOM_LEVELS.windows(2).all(|w| w[0] < w[1]), "{ZOOM_LEVELS:?}");
        assert!(ZOOM_LEVELS.contains(&ZOOM_DEFAULT));
    }

    // The steppers' whole contract: whatever is stored, the level in hand is a
    // rung. A value that merely sat between two rungs would make every later
    // step land between two rungs as well.
    #[test]
    fn clamping_snaps_onto_a_rung() {
        for stored in [0.83, 1.04, 1.2, 1.6, 1.9] {
            let snapped = clamp_zoom(stored);
            assert!(ZOOM_LEVELS.contains(&snapped), "{stored} -> {snapped}");
        }
        assert_eq!(clamp_zoom(1.04), 1.0);
        assert_eq!(clamp_zoom(1.2), 1.25);
    }

    // A hand-edited file is the reason this function exists: a window at 0.05
    // is one nobody can read well enough to fix from inside the app.
    #[test]
    fn an_unusable_stored_value_is_pulled_back_onto_the_ladder() {
        assert_eq!(clamp_zoom(0.0), 0.8);
        assert_eq!(clamp_zoom(-3.0), 0.8);
        assert_eq!(clamp_zoom(42.0), 2.0);
        assert_eq!(clamp_zoom(f64::NAN), ZOOM_DEFAULT);
        assert_eq!(clamp_zoom(f64::INFINITY), ZOOM_DEFAULT);
    }

    #[test]
    fn stepping_walks_the_ladder_and_stops_at_both_ends() {
        assert_eq!(zoom_in(1.0), 1.1);
        assert_eq!(zoom_out(1.0), 0.9);
        assert_eq!(zoom_in(2.0), 2.0);
        assert_eq!(zoom_out(0.8), 0.8);
    }

    // Stepping from OFF the ladder must not step twice or stall: it snaps
    // first, then moves exactly one rung from where it snapped.
    #[test]
    fn stepping_from_between_rungs_moves_exactly_one_rung() {
        assert_eq!(zoom_in(1.04), 1.1);
        assert_eq!(zoom_out(1.04), 0.9);
        assert_eq!(zoom_in(f64::NAN), 1.1);
    }

    // Every rung is reachable by walking up from the bottom, and back down.
    #[test]
    fn the_whole_ladder_is_walkable_in_both_directions() {
        let mut level = ZOOM_LEVELS[0];
        let mut seen = vec![level];
        for _ in 1..ZOOM_LEVELS.len() {
            level = zoom_in(level);
            seen.push(level);
        }
        assert_eq!(seen, ZOOM_LEVELS.to_vec());
        for _ in 1..ZOOM_LEVELS.len() {
            level = zoom_out(level);
        }
        assert_eq!(level, ZOOM_LEVELS[0]);
    }

    #[test]
    fn percent_is_what_a_menu_would_show() {
        assert_eq!(zoom_percent(1.0), 100);
        assert_eq!(zoom_percent(1.25), 125);
        assert_eq!(zoom_percent(0.8), 80);
        assert_eq!(zoom_percent(f64::NAN), 100);
    }

    #[test]
    fn the_assistant_frame_grows_with_the_text_in_it() {
        // The frame cannot be resized, so a bigger text size that left the
        // frame alone would just be less room to say the same thing.
        let (w, h) = assistant_frame(1.5, Some((3000.0, 2000.0)));
        assert_eq!((w, h), (ASSISTANT_WIDTH * 1.5, ASSISTANT_HEIGHT * 1.5));
        let (w, h) = assistant_frame(1.0, Some((3000.0, 2000.0)));
        assert_eq!((w, h), (ASSISTANT_WIDTH, ASSISTANT_HEIGHT));
    }

    // The reason the clamp exists: this window is non-resizable, so a bottom
    // edge past the work area takes the bar carrying Continue with it and
    // nothing inside the page can bring it back.
    #[test]
    fn the_assistant_frame_never_outgrows_the_work_area() {
        // A 1366x768 laptop panel at 150%, where both dimensions would
        // otherwise overflow.
        assert_eq!(assistant_frame(1.5, Some((1366.0, 768.0))), (1080.0, 688.0));
    }

    // The design size used to be 1024x720, which this very panel could not
    // show at normal size: the height clamped to 688 with nothing asking for
    // it, on the most ordinary laptop there is. A frame that has to be cut
    // down to fit the common case was the wrong design size, so it is smaller
    // than the common case now and the clamp is back to being the edge case
    // it was written as.
    #[test]
    fn the_design_size_fits_an_ordinary_laptop_untouched() {
        assert_eq!(
            assistant_frame(1.0, Some((1366.0, 768.0))),
            (ASSISTANT_WIDTH, ASSISTANT_HEIGHT)
        );
        // And at the text size a person is most likely to have nudged it to.
        let (w, h) = assistant_frame(1.1, Some((1366.0, 768.0)));
        assert_eq!((w, h), (ASSISTANT_WIDTH * 1.1, ASSISTANT_HEIGHT * 1.1));
    }

    // The frame exists to hold a 560px column. Wider than the column plus
    // gutters is dead space by construction, and that is what it had: 1024
    // around 560 left 232px of nothing on each side.
    #[test]
    fn the_design_width_is_the_column_it_holds_plus_gutters() {
        // Read through the function rather than off the constants: clippy
        // rejects an assert whose condition is a constant expression (it
        // compiles to `assert!(true)` and is optimised out), and going
        // through `assistant_frame` is what a caller does anyway.
        const COLUMN: f64 = 560.0;
        let (width, _) = assistant_frame(1.0, None);
        assert!(width > COLUMN, "the column has to fit");
        assert!(
            width - COLUMN <= 200.0,
            "{width} leaves {} of gutter around a {COLUMN}px column",
            width - COLUMN
        );
    }

    #[test]
    fn the_assistant_frame_keeps_its_design_size_when_no_monitor_answers() {
        assert_eq!(assistant_frame(1.0, None), (ASSISTANT_WIDTH, ASSISTANT_HEIGHT));
        assert_eq!(
            assistant_frame(1.0, Some((0.0, 0.0))),
            (ASSISTANT_WIDTH, ASSISTANT_HEIGHT)
        );
        assert_eq!(
            assistant_frame(1.0, Some((f64::NAN, f64::NAN))),
            (ASSISTANT_WIDTH, ASSISTANT_HEIGHT)
        );
    }

    // An off-ladder level must not reach a window size either.
    #[test]
    fn the_assistant_frame_snaps_its_level_first() {
        assert_eq!(assistant_frame(1.04, None), assistant_frame(1.0, None));
    }
}
