//! Included by both desktop build scripts. Building never launches the helper.
use std::path::PathBuf;
use std::process::Command;

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
    let bundle = manifest.join("resources/Subshell Display Helper.app");
    let contents = bundle.join("Contents");
    std::fs::create_dir_all(contents.join("MacOS")).expect("helper bundle directory");
    std::fs::copy(source.join("Info.plist"), contents.join("Info.plist")).expect("helper Info.plist");
    let architecture = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        _ => panic!("unsupported display helper architecture"),
    };
    let mut sources: Vec<_> = std::fs::read_dir(&source)
        .expect("helper sources")
        .map(|entry| entry.expect("helper source entry").path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "swift"))
        .collect();
    sources.sort();
    let status = Command::new("/usr/bin/xcrun")
        .args(["swiftc", "-O", "-target", &format!("{architecture}-apple-macos14.0")])
        .args(sources)
        .arg("-o")
        .arg(contents.join("MacOS/subshell-display-helper"))
        .status()
        .expect("start Swift compiler");
    assert!(status.success(), "display helper compilation failed");
    let identity = std::env::var("APPLE_SIGNING_IDENTITY").unwrap_or_else(|_| "-".into());
    assert!(std::env::var("PROFILE").as_deref() != Ok("release") || identity != "-",
        "release display helpers require APPLE_SIGNING_IDENTITY; ad-hoc signatures cannot preserve macOS permission grants");
    let mut sign = Command::new("/usr/bin/codesign");
    sign.args([
        "--force",
        "--sign",
        &identity,
        "--identifier",
        "dev.subshell.display-helper",
    ]);
    if identity != "-" {
        sign.args(["--options", "runtime", "--timestamp"]);
        if let Ok(keychain) = std::env::var("APPLE_SIGNING_KEYCHAIN") {
            sign.args(["--keychain", &keychain]);
        }
    }
    assert!(
        sign.arg(&bundle).status().expect("sign display helper").success(),
        "display helper signing failed"
    );
}
