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

/// The deployment target every helper build is compiled against.
const DEPLOYMENT_TARGET: &str = "macos14.0";

/// The compiler switches, in one place so {@link flag_parts} can cover them.
/// A flag is as much a part of the bundle's content as a source byte is: a
/// stamp that predates a change to one would otherwise keep shipping the old
/// binary on every machine that has built once, while a fresh clone gets the
/// new one, which is the drift the content gating exists to prevent.
const COMPILE_FLAGS: &[&str] = &["-O"];

/// The hardened-runtime switches, added only when there is a real identity to
/// sign with (an ad-hoc seal cannot survive them, and dev builds must not
/// depend on a timestamp authority being reachable).
const SIGN_FLAGS: &[&str] = &["--options", "runtime", "--timestamp"];

/// The `swiftc` invocation. Pure, so the test can prove the fingerprint covers
/// every flag it passes.
fn swiftc_argv(architecture: &str, sources: &[PathBuf], out: &Path) -> Vec<String> {
    let mut argv = vec!["swiftc".to_string()];
    argv.extend(COMPILE_FLAGS.iter().map(|flag| (*flag).to_string()));
    argv.push("-target".to_string());
    argv.push(format!("{architecture}-apple-{DEPLOYMENT_TARGET}"));
    argv.extend(sources.iter().map(|path| path.display().to_string()));
    argv.push("-o".to_string());
    argv.push(out.display().to_string());
    argv
}

/// The `codesign` invocation. Pure, for the same reason.
fn codesign_argv(identity: &str, keychain: &str, bundle: &Path) -> Vec<String> {
    let mut argv = vec![
        "--force".to_string(),
        "--sign".to_string(),
        identity.to_string(),
        "--identifier".to_string(),
        HELPER_ID.to_string(),
    ];
    if identity != "-" {
        argv.extend(SIGN_FLAGS.iter().map(|flag| (*flag).to_string()));
        if !keychain.is_empty() {
            argv.push("--keychain".to_string());
            argv.push(keychain.to_string());
        }
    }
    argv.push(bundle.display().to_string());
    argv
}

/// The flags and the helper's own identity, as fingerprint input.
fn flag_parts() -> Vec<u8> {
    let mut line = COMPILE_FLAGS.join(" ");
    line.push_str(" -target ");
    line.push_str(DEPLOYMENT_TARGET);
    line.push(' ');
    line.push_str(&SIGN_FLAGS.join(" "));
    line.push_str(" --identifier ");
    line.push_str(HELPER_ID);
    line.into_bytes()
}

/// The version lines out of `swiftc --version`, and nothing else.
///
/// The probe also prints a `Target:` line and, on some toolchains, paths.
/// Keeping only what names the compiler makes this stable across runs on one
/// machine, which the stamp cache needs, and different across the upgrades that
/// change the bytes it produces.
fn toolchain_version_lines(output: &str) -> String {
    output
        .lines()
        .filter(|line| line.contains("Apple Swift version") || line.contains("swift-driver version"))
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("\n")
}

/// The compiler that produced the bundle, as fingerprint input.
///
/// A flag is as much a part of the bundle's content as a source byte, and so is
/// the toolchain: an Xcode or Command Line Tools upgrade leaves every other input
/// untouched while changing what `swiftc` emits, so a stamp blind to it keeps a
/// developer's machine running the previous compiler's binary indefinitely. A
/// probe that cannot run is its own stable value rather than a panic: the compile
/// below is where a missing toolchain earns its error, with the compiler's words.
fn toolchain_part() -> Vec<u8> {
    let probed = Command::new("/usr/bin/xcrun")
        .args(["swiftc", "--version"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_default();
    match toolchain_version_lines(&probed) {
        lines if lines.is_empty() => b"toolchain:unavailable".to_vec(),
        lines => format!("toolchain:{lines}").into_bytes(),
    }
}

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

/// Where vite puts the panel page, relative to the workspace root.
fn panel_dist(root: &Path) -> PathBuf {
    root.join("packages/helper-panel/dist")
}

/// Every regular file under `dir`, sorted by its path relative to `dir`, so
/// the fingerprint and the copy do not depend on the order the OS hands out
/// directory entries.
fn tree_files(dir: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else { continue };
            // A symlinked or nested directory is not something this bundle
            // should carry; only real files inside the tree are copied.
            if file_type.is_dir() {
                stack.push(path);
            } else if file_type.is_file() {
                found.push(path);
            }
        }
    }
    found.sort();
    found
}

/// What a debug bundle carries when the page was never built: a message that
/// names the command instead of a blank window. The release path refuses to
/// build at all, so this text can never reach a person who downloaded Subshell.
const PLACEHOLDER: &str = "<!doctype html>\n\
<html lang=\"en\">\n\
<meta charset=\"utf-8\">\n\
<meta name=\"color-scheme\" content=\"dark\">\n\
<title>Subshell virtual display helper</title>\n\
<p>The panel was not built. Run <code>bunx turbo run build \
--filter=@internal/helper-panel</code>, then rebuild this helper.</p>\n";

/// The sentence every "no panel" path shares, so the fix is named in one place.
fn missing_panel_message(dist: &Path) -> String {
    format!(
        "{} has no index.html: build the display helper's panel before bundling it \
         (`bunx turbo run build --filter=@internal/helper-panel`).",
        dist.display()
    )
}

/// Every file of the panel's build, as `(relative path, bytes)` sorted by path.
///
/// The error is a value rather than a panic so it is quotable in a test, and so
/// the release/debug split can decide what to do with it.
fn dist_files(dist: &Path) -> Result<Vec<(String, Vec<u8>)>, String> {
    if !dist.join("index.html").is_file() {
        return Err(missing_panel_message(dist));
    }
    Ok(tree_files(dist)
        .into_iter()
        .map(|path| {
            let rel = path.strip_prefix(dist).expect("path under the panel dist");
            let bytes = std::fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
            (rel.to_string_lossy().into_owned(), bytes)
        })
        .collect())
}

/// What goes into `Contents/Resources/panel`.
///
/// A release must not ship a helper whose consent page was never built: the
/// panel is the only place a person can say yes, and a bundle without it is a
/// dark window. A debug build carries the placeholder instead, because the CI
/// Rust lanes and a bare `cargo clippy` run with no `bun install` at all, and
/// failing them over a file no Rust test reads would trade a real guard for a
/// red lane nobody can act on.
fn panel_files(root: &Path, release: bool) -> Vec<(String, Vec<u8>)> {
    let dist = panel_dist(root);
    if let Ok(files) = dist_files(&dist) {
        return files;
    }
    let reason = missing_panel_message(&dist);
    assert!(
        !release,
        "{reason} A release must not ship a helper whose consent page was never built."
    );
    println!("cargo:warning={reason}");
    vec![("index.html".to_string(), PLACEHOLDER.as_bytes().to_vec())]
}

/// Make `to` hold exactly `files`, writing only what differs and removing what
/// the list no longer has. The removal matters: vite names its assets by
/// content hash, so appending would leave every bundle carrying the pages of
/// its predecessors, and the signature would cover all of them.
fn sync_panel(files: &[(String, Vec<u8>)], to: &Path) -> bool {
    let mut wrote = false;
    for (name, bytes) in files {
        wrote = write_if_changed(bytes, &to.join(name)) || wrote;
    }
    for stale in tree_files(to) {
        let rel = stale.strip_prefix(to).expect("path under the panel directory");
        if !files.iter().any(|(name, _)| Path::new(name) == rel) {
            let _ = std::fs::remove_file(&stale);
            wrote = true;
        }
    }
    wrote
}

/// Write `wanted` to `to` only when the bytes differ, so an unchanged rebuild
/// leaves no new mtime for the dev watcher to chase. Returns whether it wrote.
fn write_if_changed(wanted: &[u8], to: &Path) -> bool {
    if std::fs::read(to).is_ok_and(|existing| existing == wanted) {
        return false;
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).unwrap_or_else(|error| panic!("create {}: {error}", parent.display()));
    }
    std::fs::write(to, wanted).unwrap_or_else(|error| panic!("write {}: {error}", to.display()));
    true
}

/// The same, from a file on disk.
fn copy_if_changed(from: &Path, to: &Path) -> bool {
    let wanted = std::fs::read(from).unwrap_or_else(|error| panic!("read {}: {error}", from.display()));
    write_if_changed(&wanted, to)
}

pub fn build() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("cargo manifest"));
    let root = manifest.ancestors().nth(4).expect("desktop workspace root");
    let source = root.join("native/display-helper");
    println!("cargo:rerun-if-changed={}", source.display());
    // The page is part of the bundle, so a panel rebuild has to re-run this
    // script. Cargo watches a directory recursively, and the fingerprint below
    // carries the bytes anyway.
    let dist = panel_dist(root);
    println!("cargo:rerun-if-changed={}", dist.display());
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
    let release = std::env::var("PROFILE").as_deref() == Ok("release");
    // The page is bundle content, so its bytes decide whether this pass has to
    // touch anything. Read once, then carried into both the fingerprint and the
    // copy, which is what keeps the two from disagreeing.
    let panel = panel_files(root, release);
    let mut parts = read_parts(&sources, &source.join("Info.plist"), architecture, &identity, &keychain);
    parts.push(flag_parts());
    parts.push(toolchain_part());
    for (name, bytes) in &panel {
        parts.push(name.clone().into_bytes());
        parts.push(bytes.clone());
    }
    let bytes: Vec<&[u8]> = parts.iter().map(Vec::as_slice).collect();
    let stamp_value = fingerprint(&bytes).to_string();
    let out_dir = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    let stamp = out_dir.join("display-helper.stamp");
    let staged = bundle.join("Contents/MacOS/subshell-display-helper");
    let staged_plist = bundle.join("Contents/Info.plist");
    let bundled_panel = bundle.join("Contents/Resources/panel");
    if std::fs::read_to_string(&stamp).is_ok_and(|stored| stored == stamp_value)
        && staged.is_file()
        && staged_plist.is_file()
        && bundled_panel.join("index.html").is_file()
        // ...and the seal it was signed with. An outside hand (a sync tool, a
        // cleanup, a crash between copying and stamping) can leave the bundle
        // otherwise complete but unsigned, and every later pass would call that
        // current because the bytes still match.
        && bundle.join("Contents/_CodeSignature").is_dir()
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
    let compiler = swiftc_argv(
        architecture,
        &sources,
        &stage_contents.join("MacOS/subshell-display-helper"),
    );
    let status = Command::new("/usr/bin/xcrun")
        .args(&compiler)
        .status()
        .expect("start Swift compiler");
    assert!(status.success(), "display helper compilation failed");
    // Carried into the stage BEFORE signing, so the signature covers the page
    // and a swapped asset fails `codesign --verify` the way a swapped binary does.
    sync_panel(&panel, &stage_contents.join("Resources/panel"));
    assert!(!release || identity != "-",
        "release display helpers require APPLE_SIGNING_IDENTITY; ad-hoc signatures cannot preserve macOS permission grants");
    let signer = codesign_argv(&identity, &keychain, &stage);
    assert!(
        Command::new("/usr/bin/codesign")
            .args(&signer)
            .status()
            .expect("sign display helper")
            .success(),
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
    // The page into the bundle, from the same bytes that were signed a moment
    // ago. Per file rather than wholesale, so an unchanged rebuild stamps no
    // mtime for `tauri dev` to chase.
    sync_panel(&panel, &bundled_panel);
    // Record the fingerprint whether or not anything was copied, so the next
    // pass short-circuits before the swiftc call.
    std::fs::write(&stamp, stamp_value).expect("write helper stamp");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fingerprint_covers_every_flag_the_commands_actually_pass() {
        // The drift this guards: someone adds a switch to an argv builder and
        // forgets the fingerprint, so machines that already built once keep the
        // old bundle while a fresh clone gets the new one.
        let covered = String::from_utf8(flag_parts()).expect("utf-8 flags");
        let argv = swiftc_argv("arm64", &[PathBuf::from("a.swift")], &PathBuf::from("out"));
        for token in &["-O", "-target", DEPLOYMENT_TARGET, "swiftc"] {
            assert!(argv.iter().any(|arg| arg.contains(token)), "swiftc passes {token}");
        }
        for flag in COMPILE_FLAGS
            .iter()
            .chain(["-target"].iter())
            .chain([DEPLOYMENT_TARGET].iter())
        {
            assert!(covered.contains(flag), "the fingerprint omits the compiler flag {flag}");
        }
        let adhoc = codesign_argv("-", "", &PathBuf::from("bundle"));
        let real = codesign_argv("Developer ID Application: X", "", &PathBuf::from("bundle"));
        assert!(
            !adhoc.iter().any(|arg| arg == "--options"),
            "an ad-hoc seal gets no hardened runtime"
        );
        for flag in SIGN_FLAGS {
            assert!(real.iter().any(|arg| arg == *flag), "a real identity passes {flag}");
            assert!(covered.contains(flag), "the fingerprint omits the sign flag {flag}");
        }
        assert!(
            covered.contains(HELPER_ID),
            "the fingerprint omits the bundle identifier"
        );
        // The other direction, which is the half that bites: a switch added to
        // a builder without a name in the constants above changes what lands
        // in the bundle while the fingerprint, and so the replacement check,
        // stays put. Every dash-lead token either command passes must appear in
        // one of the declared lists.
        let mut declared: Vec<String> = COMPILE_FLAGS.iter().map(|flag| (*flag).to_string()).collect();
        declared.extend(SIGN_FLAGS.iter().map(|flag| (*flag).to_string()));
        declared.extend(["-target", "-o", "--force", "--sign", "--identifier", "--keychain"].map(str::to_string));
        for probe in [
            argv,
            codesign_argv("Developer ID Application: X", "keychain", &PathBuf::from("bundle")),
        ] {
            for token in probe {
                if token.starts_with('-') {
                    assert!(
                        declared.contains(&token),
                        "an undeclared flag {token} reaches the bundle without reaching the fingerprint"
                    );
                }
            }
        }
    }

    #[test]
    fn the_fingerprint_sees_the_compiler_that_produced_the_bundle() {
        // The one input above that no source byte carries: an Xcode or Command
        // Line Tools upgrade changes what `swiftc` emits while every file, flag,
        // and page stays exactly as it was, and a stamp blind to it lets a
        // developer's machine keep running the previous compiler's binary.
        let base = fingerprint(&[b"Consent.swift", b"toolchain:Apple Swift version 6.0"]);
        assert_eq!(
            base,
            fingerprint(&[b"Consent.swift", b"toolchain:Apple Swift version 6.0"])
        );
        assert_ne!(
            base,
            fingerprint(&[b"Consent.swift", b"toolchain:Apple Swift version 6.2"])
        );
        // What is kept is the compiler's name and version only, so a probe that
        // also prints a target triple still agrees with the run before it.
        let verbose = "swift-driver version 1.127.18\nApple Swift version 6.2 (swiftlang-6.2.0.1.2)\nTarget: arm64-apple-macosx14.0\n";
        assert_eq!(
            toolchain_version_lines(verbose),
            "swift-driver version 1.127.18\nApple Swift version 6.2 (swiftlang-6.2.0.1.2)"
        );
        assert!(toolchain_version_lines(verbose).contains("Swift version 6.2"));
        // An unreadable probe is empty rather than a crash in the build script.
        assert_eq!(toolchain_version_lines(""), "");
        assert_eq!(toolchain_version_lines("xcrun: error: unable to find utility"), "");
    }

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

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("subshell-helper-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn write(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn dist_files_lists_the_built_page_and_refuses_an_absent_build_by_command() {
        let empty = scratch("dist-empty");
        let error = dist_files(&empty).expect_err("a dist with no page must not pass");
        assert!(
            error.contains("bunx turbo run build --filter=@internal/helper-panel"),
            "{error}"
        );

        let dist = scratch("dist-built");
        write(&dist.join("index.html"), b"<html>");
        write(&dist.join("assets/index-abc.js"), b"js");
        write(&dist.join("assets/index-abc.css"), b"css");
        let files = dist_files(&dist).unwrap();
        let names: Vec<&str> = files.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, ["assets/index-abc.css", "assets/index-abc.js", "index.html"]);
        assert_eq!(files[2].1, b"<html>");
        std::fs::remove_dir_all(empty).unwrap();
        std::fs::remove_dir_all(dist).unwrap();
    }

    #[test]
    fn a_debug_bundle_carries_a_placeholder_that_names_the_build_and_a_release_refuses() {
        // The natural reading of "the bundle has no panel" is that someone
        // deleted it, so both paths have to say what to run instead.
        let root = scratch("panel-missing");
        let files = panel_files(&root, false);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, "index.html");
        let page = String::from_utf8(files[0].1.clone()).expect("utf-8 placeholder");
        assert!(
            page.contains("bunx turbo run build --filter=@internal/helper-panel"),
            "{page}"
        );

        // The release path refuses rather than placeholdering. Quietly, and
        // with the directory removed, because a panic that prints a stack and
        // leaves a temp tree behind is noise a looped run accumulates.
        let hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let refused = std::panic::catch_unwind(|| panel_files(&root, true));
        std::panic::set_hook(hook);
        assert!(
            refused.is_err(),
            "a release must not ship a helper whose consent page was never built"
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn sync_panel_replaces_stale_assets_and_writes_nothing_when_already_current() {
        let to = scratch("sync-to");
        let v1: Vec<(String, Vec<u8>)> = vec![
            ("index.html".into(), b"v1".to_vec()),
            ("assets/new.js".into(), b"js".to_vec()),
        ];
        // A previous vite pass emitted a differently hashed file; the bundle
        // must not accumulate the pages of its predecessors.
        write(&to.join("assets/old.js"), b"stale");

        assert!(sync_panel(&v1, &to), "new files must be written");
        assert!(!to.join("assets/old.js").exists(), "the stale hashed asset is pruned");
        assert_eq!(std::fs::read(to.join("index.html")).unwrap(), b"v1");
        assert!(
            !sync_panel(&v1, &to),
            "an identical set must leave no new mtime for the dev watcher"
        );

        let v2: Vec<(String, Vec<u8>)> = vec![("index.html".into(), b"v2".to_vec())];
        assert!(sync_panel(&v2, &to));
        assert_eq!(std::fs::read(to.join("index.html")).unwrap(), b"v2");
        assert!(!to.join("assets/new.js").exists(), "a dropped asset leaves with it");
        std::fs::remove_dir_all(to).unwrap();
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
