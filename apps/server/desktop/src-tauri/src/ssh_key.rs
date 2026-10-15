//! Desktop-only local key bridge. No command accepts a filesystem path.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Mutex,
};
use std::time::{Duration, Instant};
use subshell_desktop_core::ssh_signer::{self, Owner, Reply, Secret, Selected, Signers};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

const DEV_PORT: u16 = 5178;
const UNLOCK: &str = "ssh-key-unlock";
const REFUSAL: &str = "This page can't use local SSH keys. Return to your control plane and try again.";

struct Unlock {
    sender: mpsc::Sender<Secret<String>>,
    deadline: Instant,
}
#[derive(Default)]
pub struct State {
    signers: Mutex<Signers>,
    // The committed document, never WebKit's provisional active URL.
    page: Mutex<Option<(String, String)>>,
    unlock: Mutex<Option<Unlock>>,
    picking: AtomicBool,
}

impl State {
    fn change_page(&self, change: impl FnOnce(&mut Option<(String, String)>)) {
        let mut page = self.page.lock().unwrap_or_else(|e| e.into_inner());
        change(&mut page);
        self.signers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .close_owner("main");
        // Registration holds the same page mutex, so a canceled generation
        // cannot install a fresh passphrase receiver after this revocation.
        self.unlock.lock().unwrap_or_else(|e| e.into_inner()).take();
    }

    fn cancel_flow(&self, expected: &(String, String)) -> bool {
        let mut page = self.page.lock().unwrap_or_else(|e| e.into_inner());
        if page.as_ref() != Some(expected) {
            return false;
        }
        close_page(&mut page, false);
        self.signers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .close_owner("main");
        self.unlock.lock().unwrap_or_else(|e| e.into_inner()).take();
        true
    }

    fn register_unlock(&self, expected: &(String, String), pending: Unlock) -> Result<(), String> {
        let page = self.page.lock().unwrap_or_else(|e| e.into_inner());
        if page.as_ref() != Some(expected) || pending.deadline <= Instant::now() {
            return Err(REFUSAL.into());
        }
        *self.unlock.lock().unwrap_or_else(|e| e.into_inner()) = Some(pending);
        Ok(())
    }
}

pub fn committed(app: &AppHandle, url: &tauri::Url) {
    app.state::<State>()
        .change_page(|page| *page = Some((url.origin().ascii_serialization(), ssh_signer::random_id())));
    close_unlock_window(app);
}

pub fn closed(app: &AppHandle, label: &str, destroyed: bool) {
    let state = app.state::<State>();
    if label == "main" {
        state.change_page(|page| close_page(page, destroyed));
        close_unlock_window(app);
    } else if label == UNLOCK {
        state.unlock.lock().unwrap_or_else(|e| e.into_inner()).take();
    }
}

fn close_page(page: &mut Option<(String, String)>, destroyed: bool) {
    if destroyed {
        *page = None;
    } else if let Some((_, generation)) = page.as_mut() {
        *generation = ssh_signer::random_id();
    }
}

fn cancel_unlock(app: &AppHandle) {
    app.state::<State>()
        .unlock
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    close_unlock_window(app);
}

fn close_unlock_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(UNLOCK) {
        let _ = window.close();
    }
}

fn allowed_origin(_app: &AppHandle, _origin: &str) -> bool {
    crate::trust::window_state().is_trusted()
}

fn secure_origin(origin: &str) -> bool {
    let Ok(url) = origin.parse::<tauri::Url>() else {
        return false;
    };
    url.scheme() == "https"
        || (url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
}

fn bundled_unlock_url(url: &tauri::Url) -> bool {
    url.path() == "/ssh-key-unlock.html"
        && url.query().is_none()
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
            || (cfg!(debug_assertions)
                && url.scheme() == "http"
                && url.host_str() == Some("localhost")
                && url.port() == Some(DEV_PORT)))
}

fn owner(window: &WebviewWindow) -> Result<(Owner, String), String> {
    if window.label() != "main" {
        return Err(REFUSAL.into());
    }
    let app = window.app_handle();
    let state = app.state::<State>();
    let (origin, generation) = state
        .page
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or(REFUSAL)?;
    if !secure_origin(&origin) || !allowed_origin(app, &origin) {
        return Err(REFUSAL.into());
    }
    Ok((
        Owner {
            window: window.label().to_owned(),
            origin,
        },
        generation,
    ))
}

pub fn start_expiry(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(250));
        let state = app.state::<State>();
        state.signers.lock().unwrap_or_else(|e| e.into_inner()).expire();
        let expired = state
            .unlock
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|pending| pending.deadline <= Instant::now());
        if expired {
            cancel_unlock(&app);
        }
    });
}

#[tauri::command]
pub fn desktop_ssh_key_available(window: WebviewWindow) -> bool {
    owner(&window).is_ok()
}

#[tauri::command]
pub async fn desktop_ssh_key_pick(
    window: WebviewWindow,
    host: String,
    port: u16,
    user: String,
    host_key: String,
) -> Result<Option<Selected>, String> {
    let initial = owner(&window)?;
    if host.is_empty()
        || host.len() > 253
        || user.is_empty()
        || user.len() > 128
        || port == 0
        || !host.is_ascii()
        || !user.is_ascii()
        || host
            .chars()
            .chain(user.chars())
            .any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("Enter a valid SSH host, port, and username first.".into());
    }
    let (host_key, fingerprint) = ssh_signer::host_key(&host_key)?;
    let app = window.app_handle().clone();
    if app.state::<State>().picking.swap(true, Ordering::SeqCst) {
        return Err("Finish choosing the current SSH key first.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        struct Picking(AppHandle);
        impl Drop for Picking { fn drop(&mut self) { self.0.state::<State>().picking.store(false, Ordering::SeqCst); } }
        let _picking = Picking(app.clone());
        let approved = app.dialog().message(format!("Allow one SSH authentication as {user} on {host}, port {port}?\n\nHost fingerprint: {fingerprint}\nVerify this fingerprint through a trusted channel before continuing.\n\nThe selected key stays in this desktop app's memory for up to 90 seconds and is released after one signature. Subshell can use the resulting SSH connection as {user} if authentication succeeds.")).title("Use a local SSH key?").buttons(MessageDialogButtons::OkCancelCustom("Choose key".into(), "Cancel".into())).blocking_show();
        if !approved { return Ok(None); }
        if owner(&window)? != initial { return Err(REFUSAL.into()); }
        let mut picker = app.dialog().file().set_title("Choose an SSH private key").set_parent(&window);
        if let Some(home) = std::env::var_os("HOME") { picker = picker.set_directory(std::path::PathBuf::from(home).join(".ssh")); }
        let Some(path) = picker.blocking_pick_file() else { return Ok(None); };
        if owner(&window)? != initial { return Err(REFUSAL.into()); }
        let deadline = Instant::now() + ssh_signer::LIFETIME;
        let mut key = ssh_signer::load_key(&path.into_path().map_err(|_| "Choose a local SSH key file.")?)?;
        if key.is_encrypted() {
            let (sender, receiver) = mpsc::channel();
            app.state::<State>().register_unlock(&(initial.0.origin.clone(), initial.1.clone()), Unlock { sender, deadline })?;
            let unlock = WebviewWindowBuilder::new(&app, UNLOCK, WebviewUrl::App("ssh-key-unlock.html".into()))
                .title("Unlock this SSH key").inner_size(460.0, 280.0).resizable(false).center()
                // No navigation, popups or global event permissions: this
                // bundled form can only submit to its own one-use receiver.
                .on_navigation(bundled_unlock_url)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build().map_err(|_| { cancel_unlock(&app); "Couldn't open the local SSH key unlock window." })?;
            // Native construction must happen without the page lock, because
            // it can call UI callbacks. A cancellation during construction
            // already dropped the receiver's sender; close the late window
            // and release the loaded key before waiting for a password.
            if owner(&window).ok() != Some(initial.clone()) || Instant::now() >= deadline {
                cancel_unlock(&app);
                return Ok(None);
            }
            let passphrase = receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()));
            let _ = unlock.close();
            app.state::<State>().unlock.lock().unwrap_or_else(|e| e.into_inner()).take();
            let Ok(passphrase) = passphrase else { return Ok(None); };
            if owner(&window)? != initial || Instant::now() >= deadline { return Err(REFUSAL.into()); }
            key = ssh_signer::unlock_key(&key, &passphrase)?;
        }
        if owner(&window)? != initial || Instant::now() >= deadline { return Err("The local SSH key request expired. Choose the key again.".into()); }
        // Page changes and insertion use the same page mutex, so navigation
        // cannot leave a key inserted after its cancellation callback ran.
        let state = app.state::<State>();
        let page = state.page.lock().unwrap_or_else(|e| e.into_inner());
        if page.as_ref() != Some(&(initial.0.origin.clone(), initial.1)) { return Err(REFUSAL.into()); }
        let selected = state.signers.lock().unwrap_or_else(|e| e.into_inner()).insert(initial.0, user, host_key, key, deadline).map(Some);
        selected
    }).await.map_err(|_| "The local SSH key request couldn't finish.")?
}

#[tauri::command]
pub fn desktop_ssh_key_request(window: WebviewWindow, id: String, request: String) -> Result<Reply, String> {
    let (owner, generation) = owner(&window)?;
    let state = window.app_handle().state::<State>();
    let page = state.page.lock().unwrap_or_else(|e| e.into_inner());
    if page.as_ref() != Some(&(owner.origin.clone(), generation)) || !allowed_origin(window.app_handle(), &owner.origin)
    {
        return Err(REFUSAL.into());
    }
    let reply = state
        .signers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .request(&owner, &id, &request);
    Ok(reply)
}

#[tauri::command]
pub fn desktop_ssh_key_close(window: WebviewWindow, id: Option<String>) -> Result<(), String> {
    let (owner, generation) = owner(&window)?;
    let app = window.app_handle();
    let state = app.state::<State>();
    if let Some(id) = id {
        state
            .signers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .close(&owner, &id);
    } else if state.cancel_flow(&(owner.origin, generation)) {
        // No id exists while the native picker/unlock promise is pending.
        // Revoke its generation so a late OS selection cannot read a key.
        close_unlock_window(app);
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_ssh_key_unlock(window: WebviewWindow, passphrase: Option<String>) -> Result<(), String> {
    let cancel = passphrase.is_none();
    let passphrase = Secret::new(passphrase.unwrap_or_default());
    if window.label() != UNLOCK || !window.url().is_ok_and(|url| bundled_unlock_url(&url)) || passphrase.len() > 4096 {
        return Err("This window can't unlock an SSH key.".into());
    }
    let app = window.app_handle();
    let pending = app
        .state::<State>()
        .unlock
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
        .ok_or("This SSH key request has expired.")?;
    if pending.deadline <= Instant::now() {
        return Err("This SSH key request has expired.".into());
    }
    if cancel {
        return Ok(());
    }
    pending
        .sender
        .send(passphrase)
        .map_err(|_| "This SSH key request has expired.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_pending_cancel_revokes_receiver_and_generation_without_unloading_page() {
        let state = State::default();
        let expected = ("https://plane.example".to_owned(), "pending-generation".to_owned());
        state.change_page(|page| *page = Some(expected.clone()));
        let (sender, receiver) = mpsc::channel();
        state
            .register_unlock(
                &expected,
                Unlock {
                    sender,
                    deadline: Instant::now() + ssh_signer::LIFETIME,
                },
            )
            .unwrap();
        assert!(state.cancel_flow(&expected));
        assert!(matches!(receiver.try_recv(), Err(mpsc::TryRecvError::Disconnected)));
        assert!(state.unlock.lock().unwrap().is_none());
        let page = state.page.lock().unwrap().clone().unwrap();
        assert_eq!(page.0, expected.0);
        assert_ne!(page.1, expected.1);
        // A cancellation from the previous flow cannot revoke a later one.
        assert!(!state.cancel_flow(&expected));
        let (sender, _) = mpsc::channel();
        assert!(state
            .register_unlock(
                &expected,
                Unlock {
                    sender,
                    deadline: Instant::now() + ssh_signer::LIFETIME
                }
            )
            .is_err());
    }

    #[test]
    fn canceled_page_cannot_register_unlock_and_revocation_disconnects_registered_receiver() {
        let state = State::default();
        let expected = ("https://plane.example".to_owned(), "old-generation".to_owned());
        state.change_page(|page| *page = Some(expected.clone()));
        let (sender, receiver) = mpsc::channel();
        state
            .register_unlock(
                &expected,
                Unlock {
                    sender,
                    deadline: Instant::now() + ssh_signer::LIFETIME,
                },
            )
            .unwrap();
        // Models cancellation while the worker constructs its native window.
        // The exact production transition disconnects the waiting worker.
        state.change_page(|page| close_page(page, false));
        assert!(matches!(receiver.try_recv(), Err(mpsc::TryRecvError::Disconnected)));
        assert!(state.unlock.lock().unwrap().is_none());
        let (sender, receiver) = mpsc::channel();
        assert!(state
            .register_unlock(
                &expected,
                Unlock {
                    sender,
                    deadline: Instant::now() + ssh_signer::LIFETIME
                }
            )
            .is_err());
        assert!(matches!(receiver.try_recv(), Err(mpsc::TryRecvError::Disconnected)));
        assert!(state.unlock.lock().unwrap().is_none());
    }

    #[test]
    fn close_to_tray_revokes_pending_generation_but_keeps_loaded_origin() {
        let mut page = Some(("https://plane.example".into(), "initial-generation".into()));
        close_page(&mut page, false);
        let (origin, generation) = page.as_ref().unwrap();
        assert_eq!(origin, "https://plane.example");
        assert_ne!(generation, "initial-generation");
        close_page(&mut page, true);
        assert!(page.is_none());
    }

    #[test]
    fn local_keys_require_tls_except_loopback() {
        for origin in [
            "https://plane.example",
            "http://127.0.0.1:3080",
            "http://localhost:5174",
            "http://[::1]:3080",
        ] {
            assert!(secure_origin(origin), "{origin}");
        }
        for origin in [
            "http://plane.example",
            "http://192.168.1.2:3080",
            "http://localhost.evil.test",
            "file:///etc/passwd",
            "blob:https://plane.example/id",
            "null",
        ] {
            assert!(!secure_origin(origin), "{origin}");
        }
    }
    #[test]
    fn unlock_navigation_is_only_the_bundled_form() {
        assert!(bundled_unlock_url(
            &"tauri://localhost/ssh-key-unlock.html".parse().unwrap()
        ));
        for url in [
            "tauri://localhost/index.html",
            "https://evil.example/ssh-key-unlock.html",
            "http://localhost:3080/ssh-key-unlock.html",
            "tauri://localhost/ssh-key-unlock.html?payload=1",
        ] {
            assert!(!bundled_unlock_url(&url.parse().unwrap()));
        }
    }
}
