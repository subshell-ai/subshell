//! The system tray.
//!
//! Honest about Linux: `TrayIconEvent` is never emitted there (Tauri's own
//! docs: "Unsupported. The event is not emitted even though the icon is shown
//! and will still show a context menu on right click"), and whether the icon
//! is DRAWN at all depends on a StatusNotifier host being registered on the
//! session bus — KDE has one, a stock GNOME does not. Where none is, the icon
//! is SILENTLY INVISIBLE, with no error and no event. Two rules follow, and
//! both are load-bearing:
//!
//! - Every tray action also exists in the window UI or the menu bar. The tray
//!   is a shortcut, never the only route to anything.
//! - `close_to_tray` DEFAULTS ON (2026-09-07), and both the setter and the
//!   window-close handler gate on `subshell_desktop_core::tray`'s PROBE of that
//!   bus rather than on the platform — so a KDE user gets the feature and a
//!   stock GNOME user cannot hide a window into an icon nothing renders: the
//!   clamp, not the default, is what makes the ON default safe.
//!   `single-instance`
//!   — relaunching — is the only way back from that, which is why the check is
//!   re-run at the moment of hiding.
//!
//! A `Menu` is attached even where nothing needs one: on some Linux
//! implementations an icon with no menu may not register at all.
//!
//! **macOS has its own silently-invisible mode, and it is not ours to fix.**
//! Measured on a notched MacBook Pro running macOS 26.6.2: every newly created
//! `NSStatusItem` is allocated with its right edge at logical x≈847, which is
//! INSIDE the notch (`NSScreen.auxiliaryTopRightArea` starts at 848), and grows
//! leftward — never into the free right-hand area, ~179pt of which macOS was
//! holding while drawing nothing. AppKit reports the item perfectly healthy the
//! whole time: `isVisible == true`, `alphaValue == 1.0`, window level 25,
//! occlusion "visible". A 25-line pure Swift/AppKit program with no Tauri and
//! no `tray-icon` reproduces it exactly, so nothing in this repo, in Tauri, or
//! in `tray-icon` is implicated. Restarting ControlCenter or the session is the
//! remedy.
//!
//! The lesson that IS ours: **`build()` returning `Ok` and `tray_by_id()`
//! returning `Some` are not evidence the icon is on screen** — both were true
//! throughout, on both platforms, which is exactly why this looked like a
//! silent code failure for so long. Do not build a health check on either.
//! The only usable macOS check would compare `TrayIcon::rect()` against
//! `auxiliaryTopRightArea`; there is none today, so this app cannot warn.

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use subshell_desktop_core::settings::SettingsState;
use subshell_desktop_core::tray::tray_support;

/// The "Keep Running in Menu Bar" check item, held so the menu handler can
/// read the state muda has already toggled onto it.
///
/// This preference used to be a switch on the console's Application section,
/// read through `desktop_settings` and written through
/// `desktop_set_close_to_tray`. Both commands are gone (spec 2026-09-12
/// § 5.6): the preference is ABOUT the tray, so it belongs in the tray, and
/// putting it there removes the two commands rather than moving them to
/// another page.
///
/// **There is deliberately no "New Subshell…" here, and no "Open
/// Dashboard".** The first dispatched an action INTO the SPA, so being
/// enabled required more than a running server — a server with no users yet
/// is sitting on the setup wizard, and nothing this side can see
/// distinguishes those states. The second is now "Open Subshell Server",
/// always enabled, because `control::open_home` decides between the dashboard
/// and the assistant from a fresh probe: an item that needed a probe to know
/// whether it could be pressed needed the probe that now happens when it is.
pub struct KeepItem(CheckMenuItem<Wry>);

/// The update item — "Check for Updates…", or "Update available — Subshell
/// Server {version}" once a check knows — held so the checks can relabel it.
///
/// A tray item is the whole of the launch check's OUTPUT (spec 2026-09-15
/// § 7.2): no window opens on its own, no badge appears, nothing is
/// downloaded. The item exists either way and is always pressable — a check
/// someone asks for must work whether or not the background one has run, or
/// the only way to look would be to wait a day. Its two labels are its two
/// acts (`tray_update_action`).
pub struct UpdateItem(MenuItem<Wry>);

/// The tray's "Check for Updates…" id.
const UPDATE_ID: &str = "tray:update";

/// The screen the tray's OpenScreen press routes to (spec 2026-09-17 § 5.2;
/// the ONE update screen since spec 2026-09-18 § 8).
///
/// A named constant rather than an inline literal so the test below pins the
/// WORD THE DISPATCH ACTUALLY PASSES — a test against a second copy of the
/// literal would stay green through the rename it exists to catch. It was
/// `app-update` until the two update screens became one; the label above is
/// unchanged, because it always named the APP and the act it opens now
/// genuinely covers the app and the server that app ships.
const UPDATE_SCREEN: &str = "update";

/// The item's label: a full notice when the last check found an update, the
/// ask otherwise.
///
/// The old form was a suffix — "Check for Updates… (0.8.0 available)" — which
/// made the notice a decoration on the request (spec 2026-09-17 § 5.2). Now
/// the two states are two different items: an update that is KNOWN says so as
/// a sentence, and the label matches what pressing the item does (below).
///
/// Pure, so the one thing a person reads about updates is testable without a
/// tray, a menu or a display server.
pub fn update_label(available: Option<&str>) -> String {
    match available {
        Some(version) if !version.is_empty() => format!("Update available — Subshell Server {version}"),
        _ => "Check for Updates…".to_string(),
    }
}

/// What pressing the update item does, decided by what is known (spec
/// 2026-09-17 § 5.2).
#[derive(Debug, PartialEq, Eq)]
pub enum TrayUpdateAction {
    /// Nothing is known newer: run the check now, in the background, exactly
    /// like the daily one — the item exists because a person may not want to
    /// wait for tomorrow's.
    Check,
    /// An update is known: open the assistant at the `update` screen, where
    /// download, install and the bundled server's install live, instead of
    /// re-checking.
    OpenScreen,
}

/// The pure half of the press: known update ⇒ open, unknown ⇒ check.
///
/// Keyed on the same non-empty rule as [`update_label`], because the two must
/// agree — a label that says "Update available" while the press runs a check
/// would re-check something it just announced, and the reverse would open a
/// screen off a label that promised only a check.
pub fn tray_update_action(available: Option<&str>) -> TrayUpdateAction {
    match available {
        Some(version) if !version.is_empty() => TrayUpdateAction::OpenScreen,
        _ => TrayUpdateAction::Check,
    }
}

/// Relabel the tray item after a check.
///
/// Silent where there is no tray: on a desktop with no StatusNotifier host the
/// icon is never drawn, and the assistant's own screen is the route there.
/// Failing loudly for a menu nobody can see would be noise.
pub fn set_update_available(app: &AppHandle, version: Option<&str>) {
    if let Some(item) = app.try_state::<UpdateItem>() {
        let _ = item.0.set_text(update_label(version));
    }
}

/// The tray's **Server Addresses…** id, and the screen it opens.
///
/// The item exists for a machine whose dashboard cannot be signed into (spec
/// 2026-09-18 § 14): an `https://` base URL marks the session cookie `Secure`,
/// and this app's `main` window is pinned to loopback http, so it can never
/// store a session again — and the value that caused it lived only on a page
/// that needs one. So this press must work when the server is DOWN, or not
/// running, or running and refusing every sign-in, which is exactly what
/// `reset::arm_and_raise` gives it: the assistant is a BUNDLED page, it opens
/// without asking the server anything, and it drives the CLI.
///
/// Named constants rather than inline literals for the same reason
/// [`UPDATE_SCREEN`] is one: the test below pins the word the dispatch actually
/// passes, and the LABEL is pinned against the page's own `SETTINGS_LABEL` — a
/// tray item and the screen it opens must not disagree about what they are for.
const SETTINGS_ID: &str = "tray:settings";
const SETTINGS_SCREEN: &str = "settings";
const SETTINGS_LABEL: &str = "Server Addresses…";

/// The tray's "Open in Browser" id.
///
/// Distinct from the menu bar's (`menu.rs`) ON PURPOSE, and the reason is the
/// one this module's `on_menu` already documents for the zoom items: a Tauri
/// menu event is GLOBAL, so an id handled here AND in `lib.rs`'s app-level
/// handler fires twice — which for this item means two browser tabs per click.
const BROWSER_ID: &str = "tray:browser";

/// Build the tray icon. Failure is not fatal — an app without a tray still works.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    // Always enabled: `open_home` answers for both states of the machine, so
    // there is nothing left for an enabled flag to protect against — and an
    // item disabled until the first probe was the one thing on a broken
    // machine's tray that could not be pressed.
    let open = MenuItem::with_id(app, "tray:open", "Open Subshell Server", true, None::<&str>)?;
    // Directly under it, because it is the same destination through a
    // different door: this window's page, in the browser the person keeps
    // their profiles and passwords in. Always enabled for the same reason
    // "Open Subshell Server" is — the Rust side falls back to `/` and to a
    // fresh probe's origin, so there is no state in which this needs a probe
    // to know whether it can be pressed.
    let browser = MenuItem::with_id(app, BROWSER_ID, "Open in Browser", true, None::<&str>)?;
    // Beside the two doors home, and always enabled for the same reason they
    // are: it raises a bundled page, which needs no probe and no server. On a
    // machine signed out of its own dashboard this is the only route to the
    // value that signed it out — the recovery screen's link is the other, and
    // a machine whose server is answering never shows that screen.
    let settings = MenuItem::with_id(app, SETTINGS_ID, SETTINGS_LABEL, true, None::<&str>)?;
    // The two names for one idea, each the one that platform's users read.
    let keep_label = if cfg!(target_os = "macos") {
        "Keep Running in Menu Bar"
    } else {
        "Keep Running in Tray"
    };
    // Seeded from the CLAMPED preference, not the stored one: where no tray
    // answered, the app will not honour `true`, and a check mark saying it
    // would is a check mark that lies.
    let checked = crate::control::close_to_tray_now(&app.state::<SettingsState>());
    let keep = CheckMenuItem::with_id(app, "tray:keep", keep_label, true, checked, None::<&str>)?;
    app.manage(KeepItem(keep.clone()));
    // On Linux this is the ONLY route to the text size: there is no menu bar
    // to hang ⌘+ on (a GTK one is per-window chrome), and the window showing a
    // control plane's page cannot offer one either. On macOS it is a second
    // route to what the View menu already carries, which costs a submenu.
    let text_size = text_size_submenu(app)?;
    // Seeded from what the LAST check found, because the launch check runs
    // after this menu is built and may not run at all today — an item that
    // only ever said "Check for Updates…" until a check happened would hide a
    // waiting update for up to a day. Filtered through `notice_for`: a stored
    // version this app now IS is not an update notice, and this seed reads
    // stored state with no source consulted (review 2026-09-17).
    let seed = crate::app_update::notice_for(
        &app.package_info().version.to_string(),
        app.state::<SettingsState>().get().last_update_version.as_deref(),
    );
    let update = MenuItem::with_id(app, UPDATE_ID, update_label(seed.as_deref()), true, None::<&str>)?;
    app.manage(UpdateItem(update.clone()));
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &browser,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &update,
            &PredefinedMenuItem::separator(app)?,
            &text_size,
            &PredefinedMenuItem::separator(app)?,
            &keep,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    TrayIconBuilder::with_id("subshell")
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            tauri::Error::InvalidIcon(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no default window icon",
            ))
        })?)
        // NOT a template. A macOS template icon is drawn from the ALPHA
        // CHANNEL alone — the system discards every colour and fills the
        // silhouette to match the menu bar. That is the right convention for a
        // single app, and it was what this called for; but the whole point of
        // the two apps' icons is that their BACKGROUNDS differ, and under a
        // template both collapse to the same filled rounded square. The
        // shipped asset is a rounded tile at 96% opacity, so a template was
        // already rendering as a solid blob rather than the `/s` mark.
        //
        // The cost is that a coloured icon does not adapt to a light or dark
        // menu bar. The tile is a dark plate with a light glyph, which reads on
        // both, and telling two menu-bar items apart beats matching them.
        .icon_as_template(false)
        .tooltip("Subshell Server")
        .menu(&menu)
        // macOS/Windows only; on Linux this is inert and the menu is the whole
        // interaction, which is why nothing here depends on a click.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            // LEFT button, on RELEASE. `Click` fires for every button, so
            // matching it wholesale means a right-click both opens the menu
            // and un-hides the window the user just closed to the tray.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = crate::control::open_home(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// The tray's text-size submenu.
///
/// The items carry no accelerators: a tray menu is not a key-event target, and
/// an accelerator shown there would advertise a keystroke that the menu bar
/// (macOS) actually owns and that nothing owns at all on Linux.
fn text_size_submenu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    Submenu::with_items(
        app,
        "Text Size",
        true,
        &[
            &MenuItem::with_id(app, crate::zoom::IN_ID, "Bigger", true, None::<&str>)?,
            &MenuItem::with_id(app, crate::zoom::OUT_ID, "Smaller", true, None::<&str>)?,
            &MenuItem::with_id(app, crate::zoom::RESET_ID, "Normal", true, None::<&str>)?,
        ],
    )
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        // One opener for every route home (spec 2026-09-12 § 5.5): a fresh
        // probe decides between the dashboard and the assistant, so the tray
        // never has to know which of the two this machine is owed.
        "tray:open" => {
            let _ = crate::control::open_home(app);
        }
        // Rust-side, with no page involved: the act is launching another
        // program, and it works whether or not a window exists. `control`
        // reads the dashboard's own url for the path when there is one.
        BROWSER_ID => crate::control::open_current_in_browser(app),
        // The SAME raise the dashboard's deep links and the update item take,
        // and deliberately nothing more: no probe, no server question, no verb.
        // Whatever this machine is doing, the assistant comes up on the screen
        // that can edit the addresses and restart.
        SETTINGS_ID => {
            let _ = crate::reset::arm_and_raise(app, Some(SETTINGS_SCREEN.into()));
        }
        // Two states, two acts (spec 2026-09-17 § 5.2), and the SAME
        // non-empty rule the label was drawn from — read from the settings
        // file, which is what both the launch check and `set_update_available`
        // write, so label and press cannot disagree. Both read it through
        // `notice_for`: a stored version this app now runs is no notice, and
        // the press must not open a screen the label no longer promises
        // (review 2026-09-17 — the same filtered input to both keeps the
        // pure agreement test true of the real item, not just of the model).
        UPDATE_ID => {
            let stored = crate::app_update::notice_for(
                &app.package_info().version.to_string(),
                app.state::<SettingsState>().get().last_update_version.as_deref(),
            );
            match tray_update_action(stored.as_deref()) {
                // Nothing known: force today's check now rather than re-raising
                // a screen to ask a question that has no answer yet. Opens
                // nothing — the answer lands on this label, and a SECOND press
                // goes to the screen.
                TrayUpdateAction::Check => crate::app_update::check_now(app),
                // An update is known: raise the assistant AT the screen through
                // the SAME route the dashboard's deep link takes, where install
                // and restart live. No check is run here: re-checking what the
                // label just announced is the wrong act for this press.
                TrayUpdateAction::OpenScreen => {
                    let _ = crate::reset::arm_and_raise(app, Some(UPDATE_SCREEN.into()));
                }
            }
        }
        "tray:keep" => set_close_to_tray(app),
        // The TEXT SIZE items are deliberately absent. A menu event in Tauri
        // is global — the app-level handler in `lib.rs` sees this menu's items
        // too — so an id handled in both places steps the ladder TWICE per
        // click. Measured: two clicks of Bigger landed on 1.75.
        //
        // No other ids exist: the tray dispatches no DesktopAction, so nothing
        // here reaches the SPA's own action bridge (see `KeepItem`).
        _ => {}
    }
}

/// Store what the check item now shows, or put it back where no tray answered.
///
/// muda flips the item's own state BEFORE the event fires (measured against
/// muda 0.19.3 on both the macOS and the GTK backends), so the item is the
/// authority on what was just asked for and this reads it rather than
/// toggling a stored copy — two places deciding what "checked" means is how
/// a menu ends up disagreeing with itself.
///
/// Turning it ON is refused where no StatusNotifier host is registered: the
/// icon is silently invisible there and a window hidden into it would be
/// unreachable. The probe is re-run here rather than reused from build time
/// because installing an AppIndicator extension flips the answer with the app
/// already running. Turning it OFF is always allowed — that direction can only
/// make the window easier to reach.
fn set_close_to_tray(app: &AppHandle) {
    let Some(item) = app.try_state::<KeepItem>() else {
        return;
    };
    let on = item.0.is_checked().unwrap_or(false);
    if on && !tray_support().supported() {
        let _ = item.0.set_checked(false);
        return;
    }
    let _ = app.state::<SettingsState>().update(|s| s.close_to_tray = on);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tray's browser id is namespaced, and is NOT the menu bar's.
    ///
    /// A Tauri menu event is global: this menu's handler sees the menu bar's
    /// items and the app-level handler sees this menu's. Two items sharing an
    /// id therefore both fire on one click — which for the zoom ladder was
    /// measured as two steps per press, and for this item is two browser tabs.
    #[test]
    fn the_browser_id_is_this_menus_own() {
        assert!(BROWSER_ID.starts_with("tray:"));
        assert_ne!(BROWSER_ID, crate::control::MENU_BROWSER_ID);
        assert_ne!(BROWSER_ID, crate::zoom::IN_ID);
    }

    /// The label is the notice (spec 2026-09-17 § 5.2): a known update says
    /// so as a full sentence, and "no answer yet" and "checked, nothing
    /// newer" render identically — both mean there is nothing to announce,
    /// and the item's job reverts to being the early door.
    #[test]
    fn the_update_item_announces_or_asks() {
        assert_eq!(update_label(Some("0.8.0")), "Update available — Subshell Server 0.8.0");
        assert_eq!(update_label(None), "Check for Updates…");
        // An empty stored version is the "nothing known" case, not a version.
        assert_eq!(update_label(Some("")), "Check for Updates…");
    }

    /// The press routes by the SAME knowledge the label reads, not by a
    /// second reading that could drift: known ⇒ open the `update` screen
    /// where install lives; unknown ⇒ run the check.
    #[test]
    fn a_known_update_opens_the_screen_and_an_unknown_one_checks() {
        assert_eq!(tray_update_action(Some("0.8.0")), TrayUpdateAction::OpenScreen);
        assert_eq!(tray_update_action(None), TrayUpdateAction::Check);
        assert_eq!(tray_update_action(Some("")), TrayUpdateAction::Check);
    }

    /// Label and press must split on the same boundary — the one predicate
    /// both call. If the two ever disagree, a label that promises an update
    /// would re-check on press, or a label that promises a check would open
    /// a screen.
    #[test]
    fn the_label_and_the_press_announce_the_same_state() {
        for available in [Some("0.8.0"), Some(""), None] {
            let announced = update_label(available) != "Check for Updates…";
            let opens = tray_update_action(available) == TrayUpdateAction::OpenScreen;
            assert_eq!(announced, opens, "label and press disagree for {available:?}");
        }
    }

    /// The OpenScreen press names the update screen by WORD, and
    /// `reset::parse_screen` is what turns that word into the enum the
    /// deep-link route consumes. A rename on either side silently falls to
    /// `Home` — the assistant raised onto a screen nobody recognised, which
    /// bounced the person back to the dashboard they had just pressed a tray
    /// item away from: the exact failure `REQUESTED_SCREENS` exists for on the
    /// page side. Pinned HERE because this file owns the dispatch's word (the
    /// constant the arm passes, not a second copy a rename could walk past),
    /// and in `reset.rs` beside the parse.
    #[test]
    fn the_tray_press_names_a_screen_the_router_recognises() {
        assert_eq!(
            crate::reset::parse_screen(Some(UPDATE_SCREEN.to_string())),
            crate::reset::Screen::Update,
            "the tray's word must survive `parse_screen`, not fall back to Home"
        );
    }

    /// The settings item's word survives `parse_screen`, and its LABEL is the
    /// page's own — `ui/src/lib/settings-screen.ts`'s `SETTINGS_LABEL`, plus
    /// the ellipsis every tray item that opens a screen carries. A tray item
    /// and the screen it opens disagreeing about what they are for is the same
    /// small betrayal `RESET_LABEL` exists to prevent, and the two halves are
    /// in different languages, so only a containment test holds them together.
    #[test]
    fn the_settings_item_names_the_screen_and_the_pages_own_label() {
        assert_eq!(
            crate::reset::parse_screen(Some(SETTINGS_SCREEN.to_string())),
            crate::reset::Screen::Settings,
            "the tray's word must survive `parse_screen`, not fall back to Home"
        );
        let page = include_str!("../../ui/src/lib/settings-screen.ts");
        assert!(
            page.contains(&format!(
                "export const SETTINGS_LABEL = \"{}\";",
                SETTINGS_LABEL.trim_end_matches('…')
            )),
            "the tray item and the screen must carry one label"
        );
    }
}
