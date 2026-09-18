//! The native About panel, on both platforms (spec 2026-09-17 § 6).
//!
//! The assistant's Show Details used to carry the whole About block — name,
//! version, licence, and the Website / Licence / Publisher links — because on
//! a machine whose server is down it was the only surface that could say what
//! this app is. The native panel now owns that job: on macOS it rides the app
//! menu (`menu.rs`), on Linux it is a one-item window menu bar on the
//! dashboard. What stays in the assistant is the ONE fact the log-text
//! paragraph still needs beside it — `This app — Subshell Server {version}`.
//!
//! Distinct from the SPA's own About dialog (which is about the product and
//! the server build): this panel is about the APP binary, and it is the only
//! surface that knows the app's version — the SPA cannot read it from a page
//! the server serves.
//!
//! The strings are `desktop-core`'s `legal` constants, the same ones the
//! assistant's About block opened: `scripts/license-fields.ts` holds them
//! equal to the TypeScript copy and the root `LICENSE`, so a third copy here
//! would be the one the detector cannot see.

use subshell_desktop_core::legal::{COMPANY_URL, COPYRIGHT_HOLDER, COPYRIGHT_LINE, LICENSE_SUMMARY, LICENSE_URL};
use tauri::menu::AboutMetadata;
use tauri::AppHandle;

// The one-item menu bar exists only where there is no macOS app menu to hang
// About on; macOS compiles this module down to the metadata alone, and an
// ungated import here is an `unused_imports` error there — the same
// cfg-stripping hazard both desktop AGENTS.md files warn about.
#[cfg(not(target_os = "macos"))]
use tauri::menu::{Menu, PredefinedMenuItem};
#[cfg(not(target_os = "macos"))]
use tauri::Wry;

/// Assemble the panel's metadata from the two runtime facts.
///
/// Pure, so the content of the one surface whose entire job is to say what
/// this software is and who owns it is testable without a display.
///
/// `name` and `version` come from `PackageInfo` rather than being left unset
/// for a bundle fallback: on macOS the fallback would print the same values,
/// but muda's GTK `AboutDialog` shows ONLY what the metadata carries, so an
/// unset version is a dialog with no version on the platform this spec added
/// the panel for. `env!("CARGO_PKG_VERSION")` is NOT that value — the crate
/// is 0.1.0 while the app ships its `package.json` version — which is why
/// these are arguments and not constants.
///
/// There is ONE link slot, and an About box's website conventionally means
/// the publisher — so the licence URL rides inside the licence text instead
/// of competing for it. Not clickable there, but present, which is what the
/// obligation to state the terms actually needs.
pub fn metadata(app_name: &str, app_version: &str) -> AboutMetadata<'static> {
    // Every field is an owned `String`, so nothing borrows the arguments and
    // the result is `'static` — which is also what `PredefinedMenuItem::about`
    // wants from a caller that has no borrowed version of its own.
    AboutMetadata {
        name: Some(app_name.to_string()),
        version: Some(app_version.to_string()),
        copyright: Some(COPYRIGHT_LINE.into()),
        license: Some(format!("{LICENSE_SUMMARY}\n{LICENSE_URL}")),
        website: Some(COMPANY_URL.into()),
        website_label: Some(COPYRIGHT_HOLDER.into()),
        ..Default::default()
    }
}

/// The metadata with this build's own name and version.
pub fn from_app(app: &AppHandle) -> AboutMetadata<'static> {
    metadata(&app.package_info().name, &app.package_info().version.to_string())
}

/// The Linux window menu bar: the About item, and nothing else (spec § 6).
///
/// A GTK menu bar is per-window chrome rather than a system bar — which is
/// why this app has no Linux menu BAR — but it is also the only place the
/// panel can live when there is no macOS app menu to hang it on. One item,
/// because every other act on the macOS menu bar already has a Linux route
/// (the tray, the page itself); About had none, and the assistant's details
/// disclosure just gave up its About block to this panel.
///
/// muda's GTK backend shows a real `AboutDialog` from the metadata on click,
/// in the backend's own connect_activate — no id reaches `on_menu_event`, so
/// nothing here needs routing.
#[cfg(not(target_os = "macos"))]
pub fn window_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let about = PredefinedMenuItem::about(app, Some("About Subshell Server"), Some(from_app(app)))?;
    Menu::with_items(app, &[&about])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The panel says what the licence boundary IS, in the app's own words:
    /// version passed through, the copyright line and licence summary from
    /// the shared legal constants, and the licence URL inside the licence
    /// text because the single website slot belongs to the publisher.
    #[test]
    fn the_metadata_carries_the_two_runtime_facts_and_the_shared_strings() {
        let m = metadata("Subshell Server", "0.8.0");
        assert_eq!(m.name.as_deref(), Some("Subshell Server"));
        assert_eq!(m.version.as_deref(), Some("0.8.0"));
        assert_eq!(m.copyright.as_deref(), Some(COPYRIGHT_LINE));
        assert_eq!(m.copyright.as_deref(), Some("Copyright 2026 Disaresta, LLC"));
        let license = m.license.clone().unwrap_or_default();
        assert!(license.starts_with("AGPL-3.0-only (control plane), Apache-2.0 elsewhere"));
        assert!(license.contains(LICENSE_URL));
        assert_eq!(m.website.as_deref(), Some(COMPANY_URL));
        assert_eq!(m.website_label.as_deref(), Some(COPYRIGHT_HOLDER));
    }
}
