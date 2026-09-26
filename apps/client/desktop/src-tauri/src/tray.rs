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
//!   opens windows, names addresses and changes its own labels, and drives no
//!   CLI.
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

use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
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
const NODE_ID: &str = "tray:node";
/// "Reset…" (issue #232): the tray door to the page's OWN reset dialog, the
/// sibling of the Server app's tray item. The dialog arms itself the moment
/// it opens, so this item raises a screen and asks nothing of its own. The
/// machine caught mid-first-run (wrong install, no rail to stand on) gets
/// the same typed-hostname confirmation as the rail door.
const RESET_ID: &str = "tray:reset";
const KEEP_ID: &str = "tray:keep";
const ABOUT_ID: &str = "tray:about";
/// "Check for Updates…" — this APP, not the node agent it wraps.
const UPDATE_ID: &str = "tray:update";

/// The plane-list tray ruling (operator, 2026-09-22): the two flat items
/// ("Open Subshell Client", "Open in Browser") did not say WHICH plane they
/// opened, which stopped being acceptable the day the list grew past one.
/// The tray now mirrors the Control Plane section: a **Control Plane**
/// submenu of the saved addresses — the node's own connected one first, the
/// same pinned-row rule as the page — each opening **Open in App | Open in
/// Browser**. The ids carry the canonical URL, so a click acts on exactly
/// the address the person read, even if the list was curated between the
/// build and the click.
const PLANE_APP_PREFIX: &str = "tray:plane-app:";
const PLANE_BROWSER_PREFIX: &str = "tray:plane-browser:";
const CONTROL_PLANE_TITLE: &str = "Control Plane";
/// The empty-list child's id — a disabled label, never a press target.
const PLANE_NONE_ID: &str = "tray:plane-none";
/// "Open Last" — the address of the last deliberate plane open, through the
/// DOOR that open used, app window or system browser (operator ruling,
/// 2026-09-22: "have Control Plane have a Open Last option which would open
/// the last used url with the opening method used"). The record lives in
/// settings (`last_plane_open`), written by every opener on success and
/// cleared by reset with the list.
const PLANE_LAST_ID: &str = "tray:plane-last";

/// The tray's plane list, pure (the pinned row's rule, in the page's shape):
/// the connected address FIRST when this machine is a node, then the stored
/// planes, defensively deduped. `connected` arrives canonicalized (or not at
/// all — an unparseable stored config is nobody's pinned entry) and stored
/// entries were canonicalized at add time, so equality here is the whole
/// dedupe. Rust refuses to store the node's own address, so the dedupe arm
/// is belt-and-braces against a CLI enrollment leaving two spellings, which
/// is exactly the case the page's pinned row also guards.
pub fn plane_entries(planes: &[String], connected: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(url) = connected {
        out.push(url.to_string());
    }
    for url in planes {
        if !out.iter().any(|seen| seen == url) {
            out.push(url.clone());
        }
    }
    out
}

/// The Control Plane submenu, read LIVE: the stored list from the app's own
/// settings, the connected address from the node's config file — no probe,
/// no window, nothing async. Refreshed by [`refresh`] on every change to
/// either (plane add/remove, enroll, un-enroll).
fn control_plane_submenu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let settings = app.state::<SettingsState>().get();
    let entries = plane_entries(&settings.planes, crate::control::tray_connected_url().as_deref());
    // First child, above every address: one press replays the last open —
    // its URL AND its door. Enabled exactly when an open has been recorded;
    // disabled is honest ("you have not opened a plane yet this install"),
    // and the record is live state, so reset greys it again with the list.
    let open_last = MenuItem::with_id(
        app,
        PLANE_LAST_ID,
        "Open Last",
        settings.last_plane_open.is_some(),
        None::<&str>,
    )?;
    if entries.is_empty() {
        // Named rather than hidden: a tray that silently omits the section
        // reads as a bug; a greyed line says what is true. Open Last can
        // still stand above it — an address can leave the list without
        // un-happening the visit — so the submenu is never wholly dead.
        let none = MenuItem::with_id(app, PLANE_NONE_ID, "No control planes yet", false, None::<&str>)?;
        return Submenu::with_items(app, CONTROL_PLANE_TITLE, true, &[&open_last, &none]);
    }
    let separator = PredefinedMenuItem::separator(app)?;
    let mut submenus: Vec<Submenu<Wry>> = Vec::new();
    for url in &entries {
        let in_app = MenuItem::with_id(
            app,
            format!("{PLANE_APP_PREFIX}{url}"),
            "Open in App",
            true,
            None::<&str>,
        )?;
        let in_browser = MenuItem::with_id(
            app,
            format!("{PLANE_BROWSER_PREFIX}{url}"),
            "Open in Browser",
            true,
            None::<&str>,
        )?;
        submenus.push(Submenu::with_items(app, url.clone(), true, &[&in_app, &in_browser])?);
    }
    let mut items: Vec<&dyn IsMenuItem<Wry>> = vec![&open_last, &separator];
    items.extend(submenus.iter().map(|s| s as &dyn IsMenuItem<Wry>));
    Submenu::with_items(app, CONTROL_PLANE_TITLE, true, &items)
}

/// The "Check for Updates…" item, held so the launch check can relabel it.
///
/// A tray item is the whole of the launch check's OUTPUT (spec 2026-09-15
/// § 7.2): no window opens on its own, no badge appears, nothing is
/// downloaded. The item exists either way and is always pressable — a check
/// someone asks for must work whether or not the background one has run, or
/// the only way to look would be to wait a day.
pub struct UpdateItem(MenuItem<Wry>);

/// The item's label: a full notice when the last check found an update, the
/// ask otherwise.
///
/// The old form was a SUFFIX — "Check for Updates… (0.8.0 available)" — which
/// made the notice a decoration on the request. The sibling app dropped it on
/// 2026-09-17 (spec § 5.2) and this one kept it until 2026-09-18; the two are
/// one product and a person running both should not meet two grammars for one
/// fact. Now the two states are two different items: an update that is KNOWN
/// says so as a sentence.
///
/// Both labels open the same window, and both are honest about it: "Check for
/// Updates…" opens a screen that checks — the macOS convention — and the notice
/// opens the screen that installs what it names.
///
/// Pure, so the one thing a person reads about updates is testable without a
/// tray, a menu or a display server.
pub fn update_label(available: Option<&str>) -> String {
    match available {
        Some(version) if !version.is_empty() => format!("Update available: Subshell Client {version}"),
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

/// The tray's full menu, built from the machine's live state: the plane
/// submenu reads the stored list and the node's config right here, the
/// update item seeds from the last check's stored notice, the keep item
/// from the clamped preference. `refresh` re-runs exactly this and swaps
/// it in, which is only honest because nothing here is remembered between.
fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    // The two windows, told apart by what they OPEN (operator ruling
    // 2026-09-22): the Control Plane submenu opens PLANES, by address; this
    // opens the client's own window — this machine's bundled node page —
    // which the plane submenu can never reach. The label is the verb the
    // old "This machine…" lacked.
    let node = MenuItem::with_id(app, NODE_ID, "Open Client App", true, None::<&str>)?;
    let control_plane = control_plane_submenu(app)?;
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
    // Placed directly above Quit, the Server app's tray rule for the one
    // item that must be findable without reading the rest of the menu.
    let reset = MenuItem::with_id(app, RESET_ID, "Reset…", true, None::<&str>)?;
    // Seeded from what the LAST check found, because the launch check runs
    // after this menu is built and may not run at all today — an item that
    // only ever said "Check for Updates…" until a check happened would hide a
    // waiting update for up to a day. Filtered through `notice_for`: this
    // seed paints STORED state with no source consulted, which is precisely
    // where an installed-update lie survives (a hand-replaced bundle never
    // clears the field).
    let update = MenuItem::with_id(
        app,
        UPDATE_ID,
        update_label(
            subshell_desktop_core::version::notice_for(
                &app.package_info().version.to_string(),
                app.state::<SettingsState>().get().last_update_version.as_deref(),
            )
            .as_deref(),
        ),
        true,
        None::<&str>,
    )?;
    app.manage(UpdateItem(update.clone()));
    Menu::with_items(
        app,
        &[
            &control_plane,
            &node,
            &PredefinedMenuItem::separator(app)?,
            &update,
            &PredefinedMenuItem::separator(app)?,
            &text_size,
            &about,
            &PredefinedMenuItem::separator(app)?,
            &keep,
            &PredefinedMenuItem::separator(app)?,
            &reset,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )
}

/// Rebuild the tray menu after the plane list or the node's connection
/// changed — `node_plane_add`, `node_plane_remove`, `node_enroll` and
/// `node_unenroll` all call this on their way out, because each is exactly
/// one of those two facts moving.
///
/// Silent where there is no tray, the `set_update_available` rule: a menu
/// nobody can see is worth neither an error nor a log line. The ids are
/// re-derived from the same live reads, and the item handles behind
/// `KeepItem`/`UpdateItem` are re-managed by `tray_menu`, so the labels
/// survive a refresh honest.
pub fn refresh(app: &AppHandle) {
    let Ok(menu) = tray_menu(app) else {
        return;
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// Build the tray icon. Failure is not fatal — an app without a tray still works.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let menu = tray_menu(app)?;
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
            NODE_ID => crate::windows::focus_node(app),
            // The plane opens carry their address in the id, so the click
            // acts on exactly the URL the person read. Both arms RE-VALIDATE
            // (windows::open_plane parses and checks the scheme; the browser
            // helper runs the same `validate_server_url` every opener uses):
            // an id string is data, never a trusted URL. Rust-side, no page
            // involved — this app tells the plane's page nothing, so a menu
            // item that needed the page to act could not exist here at all.
            id if id.starts_with(PLANE_APP_PREFIX) => {
                if let Err(err) = crate::windows::open_plane(app, &id[PLANE_APP_PREFIX.len()..]) {
                    eprintln!("tray: {err}");
                }
            }
            id if id.starts_with(PLANE_BROWSER_PREFIX) => {
                crate::control::tray_open_in_browser(app, &id[PLANE_BROWSER_PREFIX.len()..]);
            }
            // The replay: the stored address through the stored door, which
            // means the same openers and the same re-validation — a stored
            // string is data, exactly like an id. Re-opening re-records the
            // same pair (every open does; harmless for a replay), and the
            // replay must NOT repaint the tray: this is the tray's own
            // handler (see `record_plane_open`).
            PLANE_LAST_ID => {
                if let Some(record) = app.state::<SettingsState>().get().last_plane_open {
                    if record.browser {
                        crate::control::tray_open_in_browser(app, &record.url);
                    } else if let Err(err) = crate::windows::open_plane(app, &record.url) {
                        eprintln!("tray: {err}");
                    }
                }
            }
            ABOUT_ID => crate::windows::show_node_screen(app, "about"),
            // Raises the node window AT the screen through the same route
            // About takes, and performs no check itself: the screen's own
            // first render asks, so there is one place that decides what
            // "checking" looks like and one place that can fail.
            //
            // `update`, not `app-update`: there is one update screen now, and
            // it updates this app AND the agent that app ships, because each
            // bundle carries the CLI it wraps and the two were never
            // independent acts (spec 2026-09-18 § 4). The old id is deleted
            // rather than aliased — this product has no installed base to keep
            // compatible — so a page that still asked for it would simply be
            // ignored, which is the same thing an unknown id has always been.
            UPDATE_ID => crate::windows::show_node_screen(app, "update"),
            // Raises the node page at the reset dialog through the SAME route
            // About takes (stash + open + emit); the dialog arms a fresh plan
            // when it MOUNTS. A second press on an already-open dialog raises
            // the window around the same dialog: the page's open flag is a
            // boolean, and React re-runs nothing for a value that did not
            // change. The dialog stays honest to the machine as it was when
            // it opened; a plan taken since then is seen by closing and
            // pressing again.
            RESET_ID => crate::windows::show_node_screen(app, "reset"),
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

    #[test]
    fn the_menu_ids_are_namespaced() {
        for id in [
            NODE_ID,
            KEEP_ID,
            ABOUT_ID,
            UPDATE_ID,
            RESET_ID,
            PLANE_NONE_ID,
            PLANE_LAST_ID,
        ] {
            assert!(id.starts_with("tray:"), "{id}");
        }
        // The plane ids are prefixes: what follows is a URL, so the whole
        // id can never equal any fixed id, and the two arms of the handler
        // must not shadow each other — neither prefix may be a prefix of the
        // other, or one arm would swallow the other's clicks.
        for prefix in [PLANE_APP_PREFIX, PLANE_BROWSER_PREFIX] {
            assert!(prefix.starts_with("tray:"), "{prefix}");
        }
        assert!(!PLANE_APP_PREFIX.starts_with(PLANE_BROWSER_PREFIX));
        assert!(!PLANE_BROWSER_PREFIX.starts_with(PLANE_APP_PREFIX));
    }

    /// The plane ids belong to no other menu.
    ///
    /// A Tauri menu event is GLOBAL: this handler sees the menu bar's items
    /// and `lib.rs`'s app-level handler sees this menu's. One id in two menus
    /// fires twice per click — measured as two zoom steps for the text-size
    /// ladder, and here a shared browser id would be two tabs (or a window
    /// AND a tab) per press.
    #[test]
    fn the_plane_ids_are_not_the_menu_bars() {
        let sample = "https://plane.example";
        for prefix in [PLANE_APP_PREFIX, PLANE_BROWSER_PREFIX] {
            let id = format!("{prefix}{sample}");
            assert_ne!(id, crate::control::MENU_BROWSER_ID);
            assert_ne!(id, crate::zoom::IN_ID);
            assert_ne!(id, NODE_ID);
        }
        assert_ne!(PLANE_NONE_ID, crate::control::MENU_BROWSER_ID);
    }

    /// The pinned-row rule, pinned: the connected address FIRST, then the
    /// stored list, each address once. The page renders the same shape, and
    /// the tray must not lead a person to press the plane twice.
    #[test]
    fn the_connected_plane_leads_the_list() {
        let stored = vec!["https://b.example".to_string(), "https://a.example".to_string()];
        assert_eq!(
            plane_entries(&stored, Some("https://c.example")),
            vec!["https://c.example", "https://b.example", "https://a.example"]
        );
    }

    #[test]
    fn a_listed_plane_is_never_listed_twice() {
        // The case Rust's add-refusal prevents and CLI enrollment does not:
        // the stored list holding the node's own address.
        let stored = vec!["https://a.example".to_string(), "https://b.example".to_string()];
        assert_eq!(
            plane_entries(&stored, Some("https://a.example")),
            vec!["https://a.example", "https://b.example"]
        );
    }

    #[test]
    fn the_list_without_a_node_is_the_stored_order() {
        let stored = vec!["https://b.example".to_string(), "https://a.example".to_string()];
        assert_eq!(
            plane_entries(&stored, None),
            vec!["https://b.example", "https://a.example"]
        );
        assert!(plane_entries(&[], None).is_empty());
        assert_eq!(
            plane_entries(&[], Some("https://only.example")),
            vec!["https://only.example"]
        );
    }

    /// The label is the NOTICE, in the sibling app's grammar (2026-09-18).
    /// Both apps are one product and one publisher, so a person running both
    /// must not meet two wordings for the same fact — this one carried the
    /// retired suffix form ("Check for Updates… (0.8.0 available)") for a day
    /// after the server app dropped it.
    ///
    /// "no answer yet" and "checked, nothing newer" render identically, and
    /// deliberately: both mean there is nothing to announce, and the item's job
    /// reverts to being the early door.
    #[test]
    fn the_update_item_announces_or_asks() {
        assert_eq!(update_label(Some("0.8.0")), "Update available: Subshell Client 0.8.0");
        assert_eq!(update_label(None), "Check for Updates…");
        // An empty stored version is the "nothing known" case, not a version.
        assert_eq!(update_label(Some("")), "Check for Updates…");
    }

    /// It names THIS app. The two labels are built from the same shape, so a
    /// copy-paste from the sibling would read "Subshell Server" on a menu bar
    /// belonging to the client — and both may be installed on one machine,
    /// which is the whole reason their identities are four-way distinct.
    #[test]
    fn the_notice_names_this_app_and_not_the_other() {
        let notice = update_label(Some("1.2.3"));
        assert!(notice.contains("Subshell Client"), "{notice}");
        assert!(!notice.contains("Subshell Server"), "{notice}");
    }
}
