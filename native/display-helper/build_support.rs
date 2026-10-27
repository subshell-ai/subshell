//! Included by both desktop build scripts. Building never launches the helper.
//!
//! Staging is CONTENT-GATED on purpose. `tauri dev` watches the whole
//! `src-tauri` directory, and the staged bundle lives inside it
//! (`src-tauri/resources/Subshell Display Helper.app`), so a build script that
//! rewrites those files on every pass triggers its own watcher forever: one
//! edit under `native/display-helper` used to livelock `bun run
//! dev:desktop-client` in "File … changed. Rebuilding application…" loops.
//! The fingerprint (kept in `OUT_DIR`, outside the watched tree) plus
//! write-only-if-different copies make a rebuild touch the bundle exactly when
//! its bytes would change, so the loop settles after the one real update.
use std::path::{Path, PathBuf};
use std::process::Command;

const BUNDLE_NAME: &str = "Subshell Display Helper.app";
const HELPER_ID: &str = "dev.subshell.display-helper";

/// FNV-1a over every byte that decides the bundle's content. Cheap, stable,
/// and dependency-free; a mismatch costs one rebuild, never correctness.
fn fingerprint(parts: &[&[u8]]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for part in parts {
        for byte in part.iter().chain([0xff].iter()) {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100_0000_01b3);
        }
    }
    hash
}

fn read_parts(sources: &[PathBuf], plist: &Path, architecture: &str, identity: &str, keychain: &str) -> Vec<Vec<u8>> {
    let mut parts: Vec<Vec<u8>> = vec![
        architecture.as_bytes().to_vec(),
        identity.as_bytes().to_vec(),
        keychain.as_bytes().to_vec(),
    ];
    for path in sources {
        parts.push(
            path.file_name()
                .expect("named source file")
                .to_string_lossy()
                .into_owned()
                .into_bytes(),
        );
        parts.push(std::fs::read(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display())));
    }
    parts.push(std::fs::read(plist).unwrap_or_else(|error| panic!("read {}: {error}", plist.display())));
    parts
}

/// Copy `from` over `to` only when the bytes differ, so an unchanged rebuild
/// leaves no new mtime for the dev watcher to chase. Returns whether it wrote.
fn copy_if_changed(from: &Path, to: &Path) -> bool {
    let wanted = std::fs::read(from).unwrap_or_else(|error| panic!("read {}: {error}", from.display()));
    if std::fs::read(to).is_ok_and(|existing| existing == wanted) {
        return false;
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).unwrap_or_else(|error| panic!("create {}: {error}", parent.display()));
    }
    std::fs::write(to, wanted).unwrap_or_else(|error| panic!("write {}: {error}", to.display()));
    true
}

pub fn build() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("cargo manifest"));
    let root = manifest.ancestors().nth(4).expect("desktop workspace root");
    let source = root.join("native/display-helper");
    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rerun-if-env-changed=APPLE_SIGNING_IDENTITY");
    println!("cargo:rerun-if-env-changed=APPLE_SIGNING_KEYCHAIN");
    let bundle = manifest.join("resources").join(BUNDLE_NAME);
    let architecture = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        _ => panic!("unsupported display helper architecture"),
    };
    let identity = std::env::var("APPLE_SIGNING_IDENTITY").unwrap_or_else(|_| "-".into());
    let keychain = std::env::var("APPLE_SIGNING_KEYCHAIN").unwrap_or_default();
    let mut sources: Vec<_> = std::fs::read_dir(&source)
        .expect("helper sources")
        .map(|entry| entry.expect("helper source entry").path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "swift"))
        .collect();
    sources.sort();
    let parts = read_parts(&sources, &source.join("Info.plist"), architecture, &identity, &keychain);
    let bytes: Vec<&[u8]> = parts.iter().map(Vec::as_slice).collect();
    let stamp_value = fingerprint(&bytes).to_string();
    let out_dir = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    let stamp = out_dir.join("display-helper.stamp");
    let staged = bundle.join("Contents/MacOS/subshell-display-helper");
    let staged_plist = bundle.join("Contents/Info.plist");
    if std::fs::read_to_string(&stamp).is_ok_and(|stored| stored == stamp_value)
        && staged.is_file()
        && staged_plist.is_file()
    {
        // Nothing about the bundle changed since the last pass: touch no file,
        // which is what keeps `tauri dev` from rebuilding itself forever.
        return;
    }

    // Build and sign in OUT_DIR (outside the watched tree), then sync the
    // bytes in. Signing a half-written bundle in place would leave the
    // watcher seeing a valid signature over old contents for one instant.
    let stage = out_dir.join(BUNDLE_NAME);
    let stage_contents = stage.join("Contents");
    if stage.exists() {
        std::fs::remove_dir_all(&stage).expect("clear staged helper");
    }
    std::fs::create_dir_all(stage_contents.join("MacOS")).expect("staged helper directory");
    std::fs::copy(source.join("Info.plist"), stage_contents.join("Info.plist")).expect("staged helper Info.plist");
    let status = Command::new("/usr/bin/xcrun")
        .args(["swiftc", "-O", "-target", &format!("{architecture}-apple-macos14.0")])
        .args(&sources)
        .arg("-o")
        .arg(stage_contents.join("MacOS/subshell-display-helper"))
        .status()
        .expect("start Swift compiler");
    assert!(status.success(), "display helper compilation failed");
    assert!(std::env::var("PROFILE").as_deref() != Ok("release") || identity != "-",
        "release display helpers require APPLE_SIGNING_IDENTITY; ad-hoc signatures cannot preserve macOS permission grants");
    let mut sign = Command::new("/usr/bin/codesign");
    sign.args(["--force", "--sign", &identity, "--identifier", HELPER_ID]);
    if identity != "-" {
        sign.args(["--options", "runtime", "--timestamp"]);
        if !keychain.is_empty() {
            sign.args(["--keychain", &keychain]);
        }
    }
    assert!(
        sign.arg(&stage).status().expect("sign display helper").success(),
        "display helper signing failed"
    );

    std::fs::create_dir_all(bundle.join("Contents/MacOS")).expect("helper bundle directory");
    let mut wrote = copy_if_changed(&stage_contents.join("Info.plist"), &staged_plist);
    wrote = copy_if_changed(&stage_contents.join("MacOS/subshell-display-helper"), &staged) || wrote;
    for entry in std::fs::read_dir(stage_contents.join("_CodeSignature")).expect("staged code signature") {
        let path = entry.expect("signature entry").path();
        wrote = copy_if_changed(
            &path,
            &bundle
                .join("Contents/_CodeSignature")
                .join(path.file_name().expect("named")),
        ) || wrote;
    }
    // A previous staging pass may have left a stale file (a renamed source, an
    // older signature layout); drop anything the current bundle does not have.
    if let Ok(entries) = std::fs::read_dir(bundle.join("Contents/_CodeSignature")) {
        for entry in entries.flatten() {
            if !stage_contents.join("_CodeSignature").join(entry.file_name()).is_file() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    // Record the fingerprint whether or not anything was copied, so the next
    // pass short-circuits before the swiftc call.
    std::fs::write(&stamp, stamp_value).expect("write helper stamp");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fingerprint_follows_every_input_byte_and_their_order() {
        let base = fingerprint(&[b"Consent.swift", b"let x = 1"]);
        assert_eq!(base, fingerprint(&[b"Consent.swift", b"let x = 1"]));
        assert_ne!(base, fingerprint(&[b"Consent.swift", b"let x = 2"]));
        assert_ne!(base, fingerprint(&[b"Settings.swift", b"let x = 1"]));
        assert_ne!(base, fingerprint(&[b"let x = 1", b"Consent.swift"]));
    }

    #[test]
    fn an_unchanged_rebuild_touches_nothing_and_a_changed_one_writes() {
        let directory = std::env::temp_dir().join(format!("subshell-helper-stage-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let from = directory.join("from");
        let to = directory.join("to");
        std::fs::write(&from, b"v1").unwrap();
        assert!(copy_if_changed(&from, &to), "a missing target must be written");
        assert!(
            !copy_if_changed(&from, &to),
            "identical bytes must not rewrite the file"
        );
        let before = std::fs::metadata(&to).unwrap().modified().unwrap();
        std::fs::write(&from, b"v2-longer").unwrap();
        assert!(copy_if_changed(&from, &to));
        assert_eq!(std::fs::read(&to).unwrap(), b"v2-longer");
        assert!(std::fs::metadata(&to).unwrap().modified().unwrap() > before);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn read_parts_carries_sources_plist_arch_and_identity() {
        let directory = std::env::temp_dir().join(format!("subshell-helper-parts-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let source = directory.join("Consent.swift");
        let plist = directory.join("Info.plist");
        std::fs::write(&source, b"final class HelperConsent {}").unwrap();
        std::fs::write(&plist, b"<plist/>").unwrap();
        let first = read_parts(std::slice::from_ref(&source), &plist, "arm64", "-", "");
        let second = read_parts(std::slice::from_ref(&source), &plist, "x86_64", "-", "");
        assert_ne!(
            fingerprint(&first.iter().map(Vec::as_slice).collect::<Vec<_>>()),
            fingerprint(&second.iter().map(Vec::as_slice).collect::<Vec<_>>())
        );
        let signed = read_parts(&[source], &plist, "arm64", "Developer ID Application: X", "");
        assert_ne!(
            fingerprint(&first.iter().map(Vec::as_slice).collect::<Vec<_>>()),
            fingerprint(&signed.iter().map(Vec::as_slice).collect::<Vec<_>>())
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
