use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use subshell_desktop_core::release_verification::{artifact_name, VerifiedArtifact};

const MANIFEST: &[u8] = include_bytes!("fixtures/desktop-release/release-manifest.json");
const SIGNATURE: &str = include_str!("fixtures/desktop-release/release-manifest.json.sig");
const PUBLISHER: &str = include_str!("fixtures/desktop-release/publisher.pub");
const BUNDLE: &[u8] = include_bytes!("fixtures/desktop-release/bundle.txt");
const OLD_BUNDLE: &[u8] = include_bytes!("fixtures/desktop-release/old-bundle.txt");
const OLD_SIGNATURE: &str = include_str!("fixtures/desktop-release/old-bundle.txt.sig");
const ASSET: &str = "subshell-server-desktop_9.9.9_amd64.deb";

fn check(
    manifest: &[u8],
    signature: &str,
    component: &str,
    version: &str,
    asset: &str,
) -> Result<VerifiedArtifact, String> {
    VerifiedArtifact::from_manifest(manifest, signature, PUBLISHER, component, version, asset)
}

#[test]
fn correctly_signed_release_accepts_only_its_exact_bytes() {
    let checked = check(MANIFEST, SIGNATURE, "desktop-server", "9.9.9", ASSET).unwrap();
    assert!(checked.verify_bytes(BUNDLE).is_ok());
    assert!(checked.verify_bytes(b"attacker-controlled bytes").is_err());
    assert!(checked.verify_bytes(&[]).is_err());
}

#[test]
fn a_valid_publisher_signature_cannot_relabel_an_older_bundle() {
    // Reproduce the old trust boundary: Tauri accepts these genuinely signed
    // bytes even when unsigned latest.json advertises them as a newer release.
    let decode = |value: &str| String::from_utf8(STANDARD.decode(value.trim()).unwrap()).unwrap();
    PublicKey::decode(&decode(PUBLISHER))
        .unwrap()
        .verify(OLD_BUNDLE, &Signature::decode(&decode(OLD_SIGNATURE)).unwrap(), true)
        .unwrap();
    let checked = check(MANIFEST, SIGNATURE, "desktop-server", "9.9.9", ASSET).unwrap();
    assert!(checked.verify_bytes(OLD_BUNDLE).is_err());
}

#[test]
fn signed_identity_cannot_be_substituted_for_another_app_version_or_asset() {
    for (component, version, asset) in [
        ("desktop-client", "9.9.9", ASSET),
        ("desktop-server", "10.0.0", ASSET),
        ("desktop-server", "9.9.9", "unknown.deb"),
    ] {
        assert!(check(MANIFEST, SIGNATURE, component, version, asset).is_err());
    }
}

#[test]
fn missing_tampered_and_foreign_signatures_fail_closed() {
    for signature in ["", "not a signature", OLD_SIGNATURE] {
        assert!(check(MANIFEST, signature, "desktop-server", "9.9.9", ASSET).is_err());
    }
    let edited = String::from_utf8(MANIFEST.to_vec()).unwrap().replace("9.9.9", "10.0.0");
    assert!(check(edited.as_bytes(), SIGNATURE, "desktop-server", "10.0.0", ASSET).is_err());
    let foreign =
        include_str!("../../../packages/subshell-protocol/src/__tests__/fixtures/release-signature/other-pubkey.txt");
    assert!(VerifiedArtifact::from_manifest(MANIFEST, SIGNATURE, foreign, "desktop-server", "9.9.9", ASSET).is_err());
}

#[test]
fn platform_names_match_published_updater_assets() {
    for (os, arch) in [("linux", "x86_64"), ("macos", "aarch64"), ("macos", "x86_64")] {
        let name = artifact_name("desktop-server", "9.9.9", os, arch).unwrap();
        assert!(check(MANIFEST, SIGNATURE, "desktop-server", "9.9.9", &name).is_ok());
        assert_ne!(name, artifact_name("desktop-client", "9.9.9", os, arch).unwrap());
    }
    assert_eq!(
        artifact_name("desktop-server", "9.9.9", "linux", "x86_64").unwrap(),
        ASSET
    );
    assert!(artifact_name("cli-server", "9.9.9", "linux", "x86_64").is_err());
    assert!(artifact_name("desktop-server", "9.9.9", "linux", "aarch64").is_err());
}
