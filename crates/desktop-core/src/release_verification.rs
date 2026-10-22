//! Bind desktop update bytes to the publisher's component, version and platform.
//! The updater's bundle signature alone also accepts an older signed bundle
//! relabeled by an untrusted latest.json. Verify the release manifest as well.

use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;
use std::collections::HashMap;

pub const MANIFEST_LIMIT: usize = 1024 * 1024;
pub const SIGNATURE_LIMIT: usize = 16 * 1024;

#[derive(Deserialize)]
struct Manifest {
    component: String,
    version: String,
    assets: HashMap<String, String>,
}

/// Construct the published filename locally, rather than trusting a download URL.
/// Matches desktopArtifactFileName and updaterArtifactName in the release pipeline.
pub fn artifact_name(component: &str, version: &str, os: &str, arch: &str) -> Result<String, String> {
    let product = match component {
        "desktop-server" => "Server",
        "desktop-client" => "Client",
        _ => return Err("Unknown desktop release component.".into()),
    };
    match (os, arch) {
        ("macos", "aarch64") => Ok(format!("Subshell-{product}-Desktop-{version}-darwin-arm64.app.tar.gz")),
        ("macos", "x86_64") => Ok(format!("Subshell-{product}-Desktop-{version}-darwin-x64.app.tar.gz")),
        ("linux", "x86_64") => Ok(format!(
            "subshell-{}-desktop_{version}_amd64.deb",
            product.to_lowercase()
        )),
        _ => Err("No desktop update artifact is published for this platform.".into()),
    }
}

/// Only a verified manifest can construct this installation check.
pub struct VerifiedArtifact {
    digest: String,
}

impl VerifiedArtifact {
    pub fn from_manifest(
        bytes: &[u8],
        signature: &str,
        publisher: &str,
        component: &str,
        version: &str,
        artifact: &str,
    ) -> Result<Self, String> {
        if bytes.len() > MANIFEST_LIMIT || signature.len() > SIGNATURE_LIMIT {
            return Err("Release verification metadata exceeds its size limit.".into());
        }
        let key =
            PublicKey::decode(&armor(publisher)?).map_err(|e| format!("The publisher public key is invalid: {e}"))?;
        let sig = Signature::decode(&armor(signature)?)
            .map_err(|e| format!("The release manifest signature is invalid: {e}"))?;
        key.verify(bytes, &sig, false)
            .map_err(|e| format!("The release manifest failed publisher verification: {e}"))?;
        // Parse precisely the bytes that verified, never a reserialized document.
        let manifest: Manifest =
            serde_json::from_slice(bytes).map_err(|e| format!("The signed release manifest is invalid: {e}"))?;
        if manifest.component != component || manifest.version != version {
            return Err("The signed release manifest names a different app or version.".into());
        }
        let digest = manifest
            .assets
            .get(artifact)
            .filter(|digest| {
                digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            .ok_or("The signed release manifest has no valid digest for this platform's update.")?;
        Ok(Self { digest: digest.clone() })
    }

    /// Call before installing, with the same buffer passed to the installer.
    pub fn verify_bytes(&self, bytes: &[u8]) -> Result<(), String> {
        let digest: String = openssl::sha::sha256(bytes).iter().map(|b| format!("{b:02x}")).collect();
        if digest != self.digest {
            return Err(
                "The downloaded update does not match the signed release manifest. Nothing was installed.".into(),
            );
        }
        Ok(())
    }
}

/// Tauri wraps minisign armor in base64; the CLI also accepts ordinary armor.
fn armor(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.starts_with("untrusted comment: ") {
        return Ok(value.to_owned());
    }
    let decoded = STANDARD
        .decode(value)
        .map_err(|e| format!("Invalid publisher signature encoding: {e}"))?;
    String::from_utf8(decoded).map_err(|e| format!("Invalid publisher signature text: {e}"))
}
