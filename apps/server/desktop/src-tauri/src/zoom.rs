//! Text size: this app's level, and the windows it applies to.
//!
//! The ladder itself is `subshell_desktop_core::zoom`, which also explains why
//! the level is owned by RUST rather than by the page — the short version is
//! that Tauri's built-in zoom hotkeys are a page script invoking a command,
//! and `set_zoom` called from here never touches the IPC ACL at all.
//!
//! One level for the whole app rather than one per window: the assistant and
//! the dashboard are two screens of one product, and a size chosen on one that
//! did not reach the other would read as the setting being broken.

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

/// Which rung a GTK keyval names, whatever modifiers brought it.
///
/// A separate pure decision because the modifier half is GTK's own: entries
/// register under Control, and GTK's default accel mask DISCARDS Shift at
/// activation, so Ctrl+Shift+= (how a US layout types `+`) reaches the same
/// entry. Alt/Super are refused at registration instead, so a compositor
/// chord never walks this ladder.
/// Give one window the Ctrl ladder: `Ctrl+=` / `Ctrl+-` / `Ctrl+0`.
///
/// The menu bar that carries these accelerators is macOS-only BY DESIGN — a
/// GTK menu bar is per-window chrome, not a system bar — which left the
/// tray's Text Size submenu as the only zoom door on Linux, and NO door at
/// all where no StatusNotifier host answers (a plain GNOME). Window
/// accelerators restore the keys without giving Linux a menu bar: they live
/// on the GtkWindow, fire before the page sees the keystroke, and route
/// through the SAME `handle` the menus do, so the ladder, the save, and the
/// refit cannot drift.
#[cfg(target_os = "linux")]
pub fn attach_accelerators(window: &tauri::WebviewWindow) {
    use gtk::prelude::{AccelGroupExtManual, GtkWindowExt};
    use subshell_desktop_core::zoom::Accel;

    // Every GTK call below is MAIN-THREAD ONLY. The doors that open a window
    // (the handoff's Start, the tray, the watch's re-point) run their command
    // handlers on tokio workers, where `AccelGroup::new` PANICS — measured
    // 2026-09-25: the dashboard window logged `attach ENTER main` and died
    // there, so it had no ladder at all while the boot-opened assistant,
    // attached from the main thread, worked. Re-run THIS call on the main
    // thread rather than duplicating its body; the re-check lands true there.
    if !gtk::is_initialized_main_thread() {
        let next = window.clone();
        if let Err(err) = window.run_on_main_thread(move || attach_accelerators(&next)) {
            eprintln!("subshell: could not reach the main thread to attach the text-size keys: {err}");
        }
        return;
    }

    // Once per WINDOW IDENTITY, not per label: a dashboard destroyed by reset
    // gets a new id and re-registers, while the same window arriving through
    // every door (boot, the wizard's handoff, the tray) registers exactly
    // once. Measured cost of getting this wrong is a ladder that steps twice
    // per press — the 2026-09-12 bug in a new costume.
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
    // where the property exists it is switched off per webview, so the window
    // group owns those keys on every engine. On the engine this was measured
    // on (Ubuntu 26.04, 2026-09-25) the property is ABSENT — the miss is the
    // `find_property` guard doing its job, not a skipped fix.
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
        eprintln!("subshell: could not reach {label}'s webview to disable its private zoom: {err}");
    }
}

/// No-op off Linux, so the window-build sites call it unconditionally.
#[cfg(not(target_os = "linux"))]
pub fn attach_accelerators(_window: &tauri::WebviewWindow) {}

/// Route a zoom menu id, from either menu.
///
/// Returns whether the id was one of ours, so its ONE caller can hand
/// everything else on to the menu bar's dispatch — which matters beyond
/// tidiness: that dispatch opens a window when none is on screen, and ⌘0 on a
/// machine whose server is down must not be the thing that launches the
/// assistant.
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
            eprintln!("subshell: could not save the text size: {err}");
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
