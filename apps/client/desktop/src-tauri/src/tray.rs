//! The system tray.
//!
//! Honest about Linux: `TrayIconEvent` is never emitted there (Tauri's own
//! docs: "Unsupported. The event is not emitted even though the icon is shown
//! and will still show a context menu on right click"), and whether the icon
//! is DRAWN at all depends on a StatusNotifier host being registered on the
//! session bus — KDE has one, a stock GNOME does not. Where none is, the icon
//! is SILENTLY INVISIBLE, with no error and no event. Three rules follow, and
//! all three are load-bearing:
//!
//! - Every tray action also exists in the window UI or the menu bar. The tray
//!   is a shortcut, never the only route to anything — which is why this menu
//!   is two items and neither of them drives the CLI.
//! - `close_to_tray` DEFAULTS ON (2026-09-07), and both the setter and the
//!   window-close handler gate on `subshell_desktop_core::tray`'s PROBE of that
//!   bus rather than on the platform — so a KDE user gets the feature and a
//!   stock GNOME user cannot hide a window into an icon nothing renders: the
//!   clamp, not the default, is what makes the ON default safe.
//!   `single-instance`
//!   — relaunching — is the only way back from that, which is why the check is
//!   re-run at the moment of hiding.
//! - A `Menu` is attached even though nothing here needs one: on some Linux
//!   implementations an icon with no menu may not register at all.
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

/// The tray icon's id.
///
/// Explicit, and distinct from `apps/server/desktop`'s `subshell`: the two apps
/// can be installed side by side, and an id is how anything later (a
/// `tray_by_id` lookup, a tooltip update) addresses this icon rather than the
/// other app's.
const TRAY_ID: &str = "subshell-node";

/// The menu ids. Namespaced so they can never collide with a predefined
/// item's id.
const OPEN_ID: &str = "tray:open";
/// "Open in Browser".
///
/// Distinct from the menu bar's (`control::MENU_BROWSER_ID`) for the reason
/// the text-size items are absent from this handler: a Tauri menu event is
/// GLOBAL, so an id handled here AND in `lib.rs`'s app-level handler fires
/// twice per click — two browser tabs, in this item's case.
const BROWSER_ID: &str = "tray:browser";
const NODE_ID: &str = "tray:node";
const KEEP_ID: &str = "tray:keep";
const ABOUT_ID: &str = "tray:about";
/// "Check for Updates…" — this APP, not the node agent it wraps.
const UPDATE_ID: &str = "tray:update";

/// The "Check for Updates…" item, held so the launch check can relabel it.
///
/// A tray item is the whole of the launch check's OUTPUT (spec 2026-09-15
/// § 7.2): no window opens on its own, no badge appears, nothing is
/// downloaded. The item exists either way and is always pressable — a check
/// someone asks for must work whether or not the background one has run, or
/// the only way to look would be to wait a day.
pub struct UpdateItem(MenuItem<Wry>);

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
/// icon is never drawn, and the node window's own screen is the route there.
/// Failing loudly for a menu nobody can see would be noise.
pub fn set_update_available(app: &AppHandle, version: Option<&str>) {
    if let Some(item) = app.try_state::<UpdateItem>() {
        let _ = item.0.set_text(update_label(version));
    }
}

/// The "Keep Running in Menu Bar" check item, held so the menu handler can
/// read the state muda has already toggled onto it.
///
/// This preference used to be a switch on the node page, read through
/// `node_settings` and written through `node_set_close_to_tray`. Both are gone
/// (spec 2026-09-12 § 6.4): the preference is ABOUT the tray, so it belongs in
/// the tray, and putting it there removes the two commands rather than moving
/// them to another screen — which matters more here than in the server app,
/// because the node page became an assistant that asks one question per
/// screen and a preference is not a question.
pub struct KeepItem(CheckMenuItem<Wry>);

/// Build the tray icon. Failure is not fatal — an app without a tray still works.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    // Two items, one per window, because the two are genuinely different
    // destinations: the plane's UI, and this machine's own node settings. The
    // second is also the only way BACK to the node page once a client has
    // settled on a plane and opens there every time.
    let open = MenuItem::with_id(app, OPEN_ID, "Open Subshell Client", true, None::<&str>)?;
    // Directly under it: the same plane, through the browser the person keeps
    // their profiles and passwords in. Always enabled — the Rust side falls
    // back to `/`, and the one state it cannot serve (no plane opened yet) is
    // one the person can see for themselves.
    let browser = MenuItem::with_id(app, BROWSER_ID, "Open in Browser", true, None::<&str>)?;
    let node = MenuItem::with_id(app, NODE_ID, "This machine…", true, None::<&str>)?;
    // The two names for one idea, each the one that platform's users read.
    let keep_label = if cfg!(target_os = "macos") {
        "Keep Running in Menu Bar"
    } else {
        "Keep Running in Tray"
    };
    // Seeded from the CLAMPED preference, not the stored one: where no tray
    // answered, the app will not honour `true`, and a check mark saying it
    // would is a check mark that lies. That clamp is what makes this app's ON
    // default safe, so the item must show the clamped value or it contradicts
    // the behaviour it is supposed to describe.
    let checked = crate::control::close_to_tray_now(&app.state::<SettingsState>());
    let keep = CheckMenuItem::with_id(app, KEEP_ID, keep_label, true, checked, None::<&str>)?;
    app.manage(KeepItem(keep.clone()));
    // On Linux this is the ONLY route to the text size: there is no menu bar
    // to hang ⌘+ on (a GTK one is per-window chrome), and the window showing
    // the plane's page holds one command that opens a browser and nothing
    // that could change the text size, so it cannot offer one either. On
    // macOS it is a second route to what the View menu already carries, which
    // costs a submenu.
    let text_size = text_size_submenu(app)?;
    // macOS has the system's own About panel in the app menu; this is the
    // route everywhere else, where a GTK menu bar is per-window chrome rather
    // than a system bar and the app would otherwise never say what it is.
    // Present on both, because the tray is the one menu both platforms share
    // and a second platform branch buys nothing here.
    let about = MenuItem::with_id(app, ABOUT_ID, "About Subshell Client", true, None::<&str>)?;
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
            &node,
            &PredefinedMenuItem::separator(app)?,
            &update,
            &PredefinedMenuItem::separator(app)?,
            &text_size,
            &about,
            &PredefinedMenuItem::separator(app)?,
            &keep,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    TrayIconBuilder::with_id(TRAY_ID)
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
        .tooltip("Subshell Client")
        .menu(&menu)
        // macOS/Windows only; on Linux this is inert and the menu is the whole
        // interaction, which is why nothing here depends on a click.
        .show_menu_on_left_click(false)
        // The TEXT SIZE items are deliberately absent from this match. A menu
        // event in Tauri is global — the app-level handler in `lib.rs` sees
        // this menu's items too — so an id handled in both places steps the
        // ladder TWICE per click. Measured: two clicks of Bigger landed on
        // 1.75. Everything else here is safe only because no other id is
        // shared between the two menus.
        .on_menu_event(|app, event| match event.id.as_ref() {
            OPEN_ID => crate::windows::focus_any(app),
            // Rust-side, no page involved: this app tells the plane's page
            // nothing, so a menu item that needed the page to act could not
            // exist here at all.
            BROWSER_ID => crate::control::open_current_in_browser(app),
            NODE_ID => crate::windows::focus_node(app),
            ABOUT_ID => crate::windows::show_node_screen(app, "about"),
            // Raises the node window AT the screen through the same route
            // About takes, and performs no check itself: the screen's own
            // first render asks, so there is one place that decides what
            // "checking" looks like and one place that can fail.
            UPDATE_ID => crate::windows::show_node_screen(app, "app-update"),
            KEEP_ID => set_close_to_tray(app),
            _ => {}
        })
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
                crate::windows::focus_any(tray.app_handle());
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

/// Store what the check item now shows, or put it back where no tray answered.
///
/// muda flips the item's own state BEFORE the event fires (measured against
/// muda 0.19.3 on both the macOS and the GTK backends, by
/// `apps/server/desktop`'s Task 20), so the item is the authority on what was
/// just asked for and this reads it rather than toggling a stored copy — two
/// places deciding what "checked" means is how a menu ends up disagreeing with
/// itself. `is_checked()` from a menu handler does not deadlock; that was
/// verified there too, and is not re-derived here.
///
/// Turning it ON is refused where no StatusNotifier host is registered: the
/// icon is silently invisible there and a window hidden into it would be
/// unreachable, with `single-instance` the only way back. The probe is re-run
/// here rather than reused from build time because installing an AppIndicator
/// extension flips the answer with the app already running. Turning it OFF is
/// always allowed — that direction can only make a window easier to reach.
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

    // Two apps, one tray. An id shared with `apps/server/desktop` would make
    // `tray_by_id` ambiguous the first time either app grows one.
    #[test]
    fn the_tray_id_is_this_apps_own() {
        assert_eq!(TRAY_ID, "subshell-node");
        assert_ne!(TRAY_ID, "subshell");
    }

    // Namespaced so they cannot collide with a predefined item's id.
    #[test]
    fn the_about_id_is_its_own() {
        assert_ne!(ABOUT_ID, OPEN_ID);
    }

    #[test]
    fn the_menu_ids_are_namespaced() {
        assert!(OPEN_ID.starts_with("tray:"));
        assert!(NODE_ID.starts_with("tray:"));
        assert!(KEEP_ID.starts_with("tray:"));
        assert!(BROWSER_ID.starts_with("tray:"));
        assert_ne!(OPEN_ID, NODE_ID);
        assert_ne!(OPEN_ID, KEEP_ID);
        assert_ne!(NODE_ID, KEEP_ID);
        assert_ne!(BROWSER_ID, OPEN_ID);
        assert_ne!(BROWSER_ID, NODE_ID);
    }

    /// The two menus' browser ids differ.
    ///
    /// A Tauri menu event is global: this handler sees the menu bar's items
    /// and the app-level handler sees this menu's. One id in both fires twice
    /// per click — measured as two zoom steps for the text-size ladder, and
    /// here it would be two browser tabs.
    #[test]
    fn the_browser_id_is_not_the_menu_bars() {
        assert_ne!(BROWSER_ID, crate::control::MENU_BROWSER_ID);
        assert_ne!(BROWSER_ID, crate::zoom::IN_ID);
    }
}
