//! RSA operations use AWS-LC, never ssh-key's optional RustCrypto RSA backend.
use openssl::{
    bn::BigNum,
    hash::MessageDigest,
    pkey::{PKey, Private, Public},
    rsa::{Padding, Rsa, RsaPrivateKeyBuilder},
    sign::{Signer, Verifier},
};
use ssh_key::{private::RsaKeypair, public::RsaPublicKey, Algorithm, HashAlg, Mpint, Signature};

fn number(value: &Mpint) -> Option<BigNum> {
    let bytes = value.as_positive_bytes()?;
    if bytes.is_empty() || bytes.len() > 1024 {
        return None;
    }
    BigNum::from_slice(bytes).ok()
}

fn public_parts(key: &RsaPublicKey) -> Option<(BigNum, BigNum)> {
    let n = number(&key.n)?;
    let e = number(&key.e)?;
    if !(2048..=8192).contains(&n.num_bits()) || !n.is_odd() || e.num_bits() > 33 || e.num_bits() < 2 || !e.is_odd() {
        return None;
    }
    Some((n, e))
}

pub(super) fn public(key: &RsaPublicKey) -> Option<PKey<Public>> {
    let (n, e) = public_parts(key)?;
    PKey::from_rsa(Rsa::from_public_components(n, e).ok()?).ok()
}

pub(super) fn private(key: &RsaKeypair) -> Option<PKey<Private>> {
    let (n, e) = public_parts(&key.public)?;
    // OpenSSH doesn't store dP/dQ. Give AWS-LC the essential components and
    // let it manage the private operation, rather than deriving CRT values in
    // application code or using the affected RustCrypto backend. The file's
    // cached iqmp is unused. RSA_check_key verifies n=p*q and d/e consistency.
    let rsa = RsaPrivateKeyBuilder::new(n, e, number(&key.private.d)?)
        .ok()?
        .set_factors(number(&key.private.p)?, number(&key.private.q)?)
        .ok()?
        .build();
    if !rsa.check_key().ok()? {
        return None;
    }
    PKey::from_rsa(rsa).ok()
}

fn digest(hash: HashAlg) -> Option<MessageDigest> {
    Some(match hash {
        HashAlg::Sha256 => MessageDigest::sha256(),
        HashAlg::Sha512 => MessageDigest::sha512(),
        _ => return None,
    })
}

pub(super) fn sign(key: &PKey<Private>, data: &[u8], algorithm: &[u8], flags: u32) -> Option<Signature> {
    let hash = match (algorithm, flags) {
        (b"rsa-sha2-256", 2) => HashAlg::Sha256,
        (b"rsa-sha2-512", 4) => HashAlg::Sha512,
        _ => return None,
    };
    let mut signer = Signer::new(digest(hash)?, key).ok()?;
    signer.set_rsa_padding(Padding::PKCS1).ok()?;
    let bytes = signer.sign_oneshot_to_vec(data).ok()?;
    Signature::new(Algorithm::Rsa { hash: Some(hash) }, bytes).ok()
}

pub(super) fn verify(key: &RsaPublicKey, data: &[u8], signature: &Signature) -> Option<()> {
    let Algorithm::Rsa { hash: Some(hash) } = signature.algorithm() else {
        return None;
    };
    let key = public(key)?;
    let mut verifier = Verifier::new(digest(hash)?, &key).ok()?;
    verifier.set_rsa_padding(Padding::PKCS1).ok()?;
    verifier.verify_oneshot(signature.as_bytes(), data).ok()?.then_some(())
}

#[cfg(test)]
pub(super) fn fixture_key(bits: u32) -> ssh_key::PrivateKey {
    let rsa = Rsa::generate(bits).unwrap();
    let mpint = |n: &openssl::bn::BigNumRef| Mpint::from_positive_bytes(&n.to_vec()).unwrap();
    ssh_key::PrivateKey::new(
        ssh_key::private::KeypairData::Rsa(RsaKeypair {
            public: RsaPublicKey {
                n: mpint(rsa.n()),
                e: mpint(rsa.e()),
            },
            private: ssh_key::private::RsaPrivateKey {
                d: mpint(rsa.d()),
                iqmp: mpint(rsa.iqmp().unwrap()),
                p: mpint(rsa.p().unwrap()),
                q: mpint(rsa.q().unwrap()),
            },
        }),
        "test-only",
    )
    .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rsa_backend_is_aws_lc() {
        // A dependency-feature change must not silently select system OpenSSL.
        assert!(openssl::version::version().contains("AWS-LC"));
    }

    #[test]
    fn validates_components_and_bounds_before_accepting_private_keys() {
        let key = fixture_key(2048);
        let parts = key.key_data().rsa().unwrap();
        assert!(private(parts).is_some());
        for component in ["d", "p", "q", "n", "e"] {
            let mut bad = parts.clone();
            let target = match component {
                "d" => &mut bad.private.d,
                "p" => &mut bad.private.p,
                "q" => &mut bad.private.q,
                "n" => &mut bad.public.n,
                _ => &mut bad.public.e,
            };
            *target = Mpint::from_bytes(&[3]).unwrap();
            assert!(private(&bad).is_none(), "accepted invalid {component}");
        }
        let mut oversized = parts.clone();
        oversized.private.d = Mpint::from_positive_bytes(&[1; 1025]).unwrap();
        assert!(private(&oversized).is_none());
        oversized.public.n = Mpint::from_positive_bytes(&[1; 1025]).unwrap();
        assert!(public(&oversized.public).is_none());
        let small = fixture_key(1024);
        assert!(private(small.key_data().rsa().unwrap()).is_none());
        assert!(public(small.public_key().key_data().rsa().unwrap()).is_none());
    }

    #[test]
    fn verifies_only_sha2_signatures_for_the_exact_host_and_message() {
        let host = fixture_key(2048);
        let other = fixture_key(2048);
        let key = private(host.key_data().rsa().unwrap()).unwrap();
        for (algorithm, flags) in [(b"rsa-sha2-256".as_slice(), 2), (b"rsa-sha2-512".as_slice(), 4)] {
            let signature = sign(&key, b"session-id", algorithm, flags).unwrap();
            assert!(verify(host.public_key().key_data().rsa().unwrap(), b"session-id", &signature).is_some());
            assert!(verify(
                host.public_key().key_data().rsa().unwrap(),
                b"different-session",
                &signature
            )
            .is_none());
            assert!(verify(other.public_key().key_data().rsa().unwrap(), b"session-id", &signature).is_none());
            assert!(sign(&key, b"session-id", algorithm, 6 - flags).is_none());
        }
        assert!(sign(&key, b"session-id", b"ssh-rsa", 0).is_none());
        // The SSH signature parser rejects legacy SHA-1 before verification.
        assert!(Signature::new(Algorithm::Rsa { hash: None }, vec![0; 256]).is_err());
    }
}
