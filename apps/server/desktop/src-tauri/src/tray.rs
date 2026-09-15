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

/// The "Check for Updates…" item, held so the launch check can relabel it.
///
/// A tray item is the whole of the launch check's OUTPUT (spec 2026-09-15
/// § 7.2): no window opens on its own, no badge appears, nothing is
/// downloaded. The item exists either way and is always pressable — a check
/// someone asks for must work whether or not the background one has run, or
/// the only way to look would be to wait a day.
pub struct UpdateItem(MenuItem<Wry>);

/// The tray's "Check for Updates…" id.
const UPDATE_ID: &str = "tray:update";

/// The item's label, with the version when the last check found one.
///
/// Pure, so the one thing a person reads about updates is testable without a
/// tray, a menu or a display server.
pub fn update_label(available: Option<&str>) -> String {
    match available {
        Some(version) if !version.is_empty() => format!("Check for Updates… ({version} available)"),
        _ => "Check for Updates…".to_string(),
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
    // waiting update for up to a day.
    let update = MenuItem::with_id(
        app,
        UPDATE_ID,
        update_label(app.state::<SettingsState>().get().last_update_version.as_deref()),
        true,
        None::<&str>,
    )?;
    app.manage(UpdateItem(update.clone()));
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &browser,
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
        // Raises the assistant AT the screen through the SAME route the
        // dashboard's deep link takes, and performs no check itself: the
        // screen's own first render asks, so there is one place that decides
        // what "checking" looks like and one place that can fail.
        UPDATE_ID => {
            let _ = crate::reset::arm_and_raise(app, Some("app-update".into()));
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
}
