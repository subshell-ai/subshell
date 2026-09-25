//! Text size: this app's level, and the windows it applies to.
//!
//! The ladder itself is `subshell_desktop_core::zoom`, which also explains why
//! the level is owned by RUST rather than by the page — the short version is
//! that Tauri's built-in zoom hotkeys are a page script invoking a command,
//! and `set_zoom` called from here never touches the IPC ACL at all.
//!
//! One level for the whole app rather than one per window: the plane window
//! and the node assistant are two screens of one product, and a size chosen on
//! one that did not reach the other would read as the setting being broken.
//!
//! The plane window is the reason this could not have been done the built-in
//! way. It shows a control plane's OWN page, from an origin this app cannot
//! enumerate ahead of time, so the one command it is granted
//! (`desktop_open_in_browser`, a path and nothing else) is the whole of its
//! surface — the webview-zoom command Tauri's polyfill invokes is not on it,
//! and never will be. Driving `set_zoom` from Rust is what lets that window
//! follow the setting without widening that surface by one command.

use subshell_desktop_core::settings::SettingsState;
use subshell_desktop_core::zoom::{clamp_zoom, zoom_in, zoom_out, ZOOM_DEFAULT};
use tauri::{AppHandle, Manager};

/// Menu ids, shared by the macOS menu bar and the tray.
///
/// ONE set for both, and exactly one ROUTE for it: `lib.rs`'s app-level
/// `on_menu_event`. A Tauri menu event is global — that handler receives the
/// tray's items, and the tray's handler receives the menu bar's — so an id
/// matched in both places steps the ladder twice per click. Measured on
/// 2026-09-12: two clicks of Bigger landed on 1.75. Namespaced away from
/// `menu:` and `tray:` so the reverse cannot happen either.
pub const IN_ID: &str = "zoom:in";
pub const OUT_ID: &str = "zoom:out";
pub const RESET_ID: &str = "zoom:reset";

/// This app's text size, always a rung of the ladder.
pub fn level(app: &AppHandle) -> f64 {
    clamp_zoom(app.state::<SettingsState>().get().zoom)
}

/// Apply the current level to every window that exists, and re-fit the
/// geometry that depends on it.
pub fn apply(app: &AppHandle) {
    let level = level(app);
    for window in app.webview_windows().values() {
        let _ = window.set_zoom(level);
    }
    crate::windows::refit(app, level);
}

/// Give one window the Ctrl ladder: `Ctrl+=` / `Ctrl+-` / `Ctrl+0`.
///
/// The mirror of the server app's same half, for the same reason: the menu
/// bar carrying these accelerators is macOS-only by design (a GTK menu bar
/// is per-window chrome), so on Linux the tray submenu was the only door —
/// and no door at all where no tray host answers. Window accelerators
/// restore the keys on BOTH of this app's windows, the node assistant and
/// the plane window alike; the plane window in particular can never be
/// wired the built-in way (module header), and this route widens its grant
/// by nothing. The keyval table and rung decision are `desktop-core`'s,
/// pinned there; this is registration mechanics, routed through the SAME
/// `handle` the menus use.
#[cfg(target_os = "linux")]
pub fn attach_accelerators(window: &tauri::WebviewWindow) {
    use gtk::prelude::{AccelGroupExtManual, GtkWindowExt};
    use subshell_desktop_core::zoom::Accel;

    // Every GTK call below is MAIN-THREAD ONLY; the doors that open a window
    // run their handlers on tokio workers, where `AccelGroup::new` PANICS and
    // the window silently keeps no ladder. The server app carries the
    // measured story. Re-run THIS call on the main thread.
    if !gtk::is_initialized_main_thread() {
        let next = window.clone();
        if let Err(err) = window.run_on_main_thread(move || attach_accelerators(&next)) {
            eprintln!("subshell-client: could not reach the main thread to attach the text-size keys: {err}");
        }
        return;
    }

    // Once per WINDOW IDENTITY, not per label: the plane window arrives
    // through several doors, and the same window re-registering is a ladder
    // that steps twice per press. The server app carries the measured story.
    static ATTACHED: std::sync::Mutex<Vec<usize>> = std::sync::Mutex::new(Vec::new());
    let Ok(gtk_window) = window.gtk_window() else {
        // Not a GTK-backed window; the tray submenu remains the door.
        return;
    };
    let key =
        gtk::glib::translate::ToGlibPtr::<*mut gtk::ffi::GtkApplicationWindow>::to_glib_none(&gtk_window).0 as usize;
    {
        let mut guard = ATTACHED.lock().expect("zoom attach lock poisoned");
        if guard.contains(&key) {
            return;
        }
        guard.push(key);
    }

    let group = gtk::AccelGroup::new();
    let control = gtk::gdk::ModifierType::CONTROL_MASK;
    let app = window.app_handle().clone();
    // The table and the mapping are desktop-core's ONE decision, pinned by
    // its own test; this loop is registration mechanics only.
    for keyval in subshell_desktop_core::zoom::ACCEL_KEYVALS {
        let app = app.clone();
        group.connect_accel_group(
            keyval,
            control,
            gtk::AccelFlags::empty(),
            move |_group, _window, fired, _mods| match subshell_desktop_core::zoom::zoom_id_for_accel(fired) {
                Some(Accel::In) => handle(&app, IN_ID),
                Some(Accel::Out) => handle(&app, OUT_ID),
                Some(Accel::Reset) => handle(&app, RESET_ID),
                None => false,
            },
        );
    }

    // The window's accel groups are where GTK consults key events; mounting
    // the group there is the whole registration. Some WebKitGTK builds ship a
    // private page-zoom of their own for Ctrl+= (`enable-browser-accelerator-
    // keys`, ON by default and never plumbed through by tauri 2.11) that
    // consumes the chord inside the webview before the window ever sees it;
    // where the property exists it is switched off per webview. This matters
    // MORE here than in the server app: the plane window shows a page that
    // cannot be granted anything, so the window group is its only door.
    gtk_window.add_accel_group(&group);
    let label = window.label().to_string();
    if let Err(err) = window.with_webview(move |platform| {
        use gtk::glib::object::ObjectExt;
        let webview = platform.inner();
        // The property is spelled straight to GObject because the webkit2gtk
        // binding predates it; `set_property` PANICS on an unknown name, so
        // it is looked up first — a miss only means there was no private
        // ladder on this engine to switch off.
        if let Some(settings) = webkit2gtk::WebViewExt::settings(&webview) {
            if settings.find_property("enable-browser-accelerator-keys").is_some() {
                settings.set_property("enable-browser-accelerator-keys", false);
            }
        }
    }) {
        eprintln!("subshell-client: could not reach {label}'s webview to disable its private zoom: {err}");
    }
}

/// No-op off Linux, so the window-build sites call it unconditionally.
#[cfg(not(target_os = "linux"))]
pub fn attach_accelerators(_window: &tauri::WebviewWindow) {}

/// Route a zoom menu id, from either menu.
///
/// Returns whether the id was one of ours, so its ONE caller can hand
/// everything else on to the menu bar's dispatch.
///
/// A failed SAVE is reported and then ignored: the level still applies to this
/// session, because a window nobody can read is a worse answer to a full disk
/// than one that forgets the size at the next launch.
pub fn handle(app: &AppHandle, id: &str) -> bool {
    let current = level(app);
    let next = match id {
        IN_ID => zoom_in(current),
        OUT_ID => zoom_out(current),
        RESET_ID => ZOOM_DEFAULT,
        _ => return false,
    };
    if next != current {
        if let Err(err) = app.state::<SettingsState>().update(|s| s.zoom = next) {
            eprintln!("subshell-client: could not save the text size: {err}");
        }
        apply(app);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    // Namespaced, distinct, and not colliding with either menu's own prefix:
    // menu events are global, so every handler sees every id and a string
    // shared with a `menu:`/`tray:` item would be a menu entry that quietly
    // does two things.
    #[test]
    fn the_zoom_ids_are_namespaced_and_distinct() {
        for id in [IN_ID, OUT_ID, RESET_ID] {
            assert!(id.starts_with("zoom:"), "{id}");
        }
        assert_ne!(IN_ID, OUT_ID);
        assert_ne!(IN_ID, RESET_ID);
        assert_ne!(OUT_ID, RESET_ID);
    }
}
