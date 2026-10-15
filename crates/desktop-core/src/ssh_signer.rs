//! A short-lived SSH agent that authorizes exactly one host-bound login.
//!
//! The browser sees only public wire replies. OpenSSH's verified session bind
//! and host-bound userauth keep an untrusted relay from repurposing the key.
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use signature::{RandomizedSigner, SignatureEncoding, Signer, Verifier};
use ssh_key::{Algorithm, HashAlg, PrivateKey, PublicKey, Signature};
use std::{
    collections::HashMap,
    io::Read,
    path::Path,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

pub const MAX_BYTES: usize = 65536;
pub const LIFETIME: Duration = Duration::from_secs(90);
const FAILURE: &[u8] = &[5];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Owner {
    pub window: String,
    pub origin: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selected {
    pub id: String,
    pub public_key: String,
    pub expires_at: u64,
}

#[derive(Serialize)]
pub struct Reply {
    pub response: String,
    pub done: bool,
}

pub fn decode(value: &str) -> Result<Vec<u8>, String> {
    if value.len() > (MAX_BYTES * 4 / 3 + 4) {
        return Err("The SSH request is too large.".into());
    }
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| "The SSH request isn't valid base64.")?;
    if bytes.len() > MAX_BYTES {
        return Err("The SSH request is too large.".into());
    }
    Ok(bytes)
}

pub fn load_key(path: &Path) -> Result<PrivateKey, String> {
    // Open nonblocking first: picking a FIFO must not hang a GUI thread before
    // metadata can reject it. O_NOFOLLOW also refuses a symlink swapped in
    // between the picker and this open; normal symlinks are intentionally refused.
    #[cfg(unix)]
    let mut file = {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
            .open(path)
    }
    .map_err(|_| "Couldn't open that SSH key. Choose a regular private key file.")?;
    #[cfg(not(unix))]
    let mut file = std::fs::File::open(path).map_err(|_| "Couldn't open that SSH key file.")?;
    let metadata = file.metadata().map_err(|_| "Couldn't check that SSH key file.")?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES as u64 {
        return Err("Choose a regular SSH private key file smaller than 64 KiB.".into());
    }
    let mut bytes = Zeroizing::new(Vec::with_capacity(MAX_BYTES + 1));
    (&mut file)
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Couldn't read that SSH key file.")?;
    if bytes.len() > MAX_BYTES {
        return Err("That SSH key file is too large.".into());
    }
    PrivateKey::from_openssh(&*bytes).map_err(|_| "That file isn't a supported OpenSSH private key.".into())
}

pub fn host_key(encoded: &str) -> Result<(Vec<u8>, String), String> {
    let bytes = decode(encoded)?;
    let key = PublicKey::from_bytes(&bytes).map_err(|_| "The SSH host key isn't valid.")?;
    if key.to_bytes().map_err(|_| "The SSH host key isn't valid.")? != bytes {
        return Err("The SSH host key isn't valid.".into());
    }
    Ok((bytes, key.fingerprint(HashAlg::Sha256).to_string()))
}

pub fn random_id() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    STANDARD.encode(bytes)
}

struct Session {
    owner: Owner,
    user: String,
    host_key: Vec<u8>,
    public_key: Vec<u8>,
    key: PrivateKey,
    expires: Instant,
    binding: Option<Vec<u8>>,
}

#[derive(Default)]
pub struct Signers {
    sessions: HashMap<String, Session>,
}

impl Signers {
    pub fn insert(
        &mut self,
        owner: Owner,
        user: String,
        host_key: Vec<u8>,
        key: PrivateKey,
        deadline: Instant,
    ) -> Result<Selected, String> {
        if deadline <= Instant::now() || deadline > Instant::now() + LIFETIME {
            return Err("The local SSH key request expired.".into());
        }
        if key.is_encrypted() {
            return Err("Unlock the SSH key first.".into());
        }
        match key.algorithm() {
            Algorithm::Ed25519 | Algorithm::Ecdsa { .. } | Algorithm::Rsa { .. } => {}
            _ => return Err("Choose an Ed25519, ECDSA, or RSA SSH key.".into()),
        }
        let public_key = key
            .public_key()
            .to_bytes()
            .map_err(|_| "Couldn't read the key's public identity.")?;
        self.close_owner(&owner.window);
        let id = random_id();
        let selected = Selected {
            id: id.clone(),
            public_key: STANDARD.encode(&public_key),
            expires_at: (SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default()
                + deadline.saturating_duration_since(Instant::now()))
            .as_millis() as u64,
        };
        self.sessions.insert(
            id,
            Session {
                owner,
                user,
                host_key,
                public_key,
                key,
                expires: deadline,
                binding: None,
            },
        );
        Ok(selected)
    }

    pub fn expire(&mut self) {
        self.sessions.retain(|_, s| s.expires > Instant::now());
    }
    pub fn close_owner(&mut self, window: &str) {
        self.sessions.retain(|_, s| s.owner.window != window);
    }
    pub fn close(&mut self, owner: &Owner, id: &str) {
        if self.sessions.get(id).is_some_and(|s| s.owner == *owner) {
            self.sessions.remove(id);
        }
    }

    pub fn request(&mut self, owner: &Owner, id: &str, encoded: &str) -> Reply {
        self.request_with_clock(owner, id, encoded, Instant::now)
    }

    fn request_with_clock(
        &mut self,
        owner: &Owner,
        id: &str,
        encoded: &str,
        mut now: impl FnMut() -> Instant,
    ) -> Reply {
        let started = now();
        self.sessions.retain(|_, session| session.expires > started);
        let mut done = !self.sessions.contains_key(id);
        let mut response = (|| {
            let bytes = decode(encoded).ok()?;
            let session = self.sessions.get_mut(id)?;
            if session.owner != *owner {
                return None;
            }
            let mut r = Reader(&bytes);
            let response = match r.byte()? {
                11 if r.finished() => {
                    let mut out = vec![12];
                    out.extend(1u32.to_be_bytes());
                    put(&mut out, &session.public_key);
                    put(&mut out, b"Subshell one-time SSH key");
                    out
                }
                27 => session.bind(&mut r)?,
                13 => {
                    let response = session.sign(&mut r)?;
                    done = true;
                    response
                }
                _ => return None,
            };
            Some(response)
        })();
        // Verification/signing can cross the deadline while the native timer
        // waits for this mutex. Recheck even failed operations, discard any
        // late signature, and release every expired key before returning.
        let finished = now();
        if self.sessions.get(id).is_some_and(|session| session.expires <= finished) {
            response = None;
            done = true;
        }
        self.sessions.retain(|_, session| session.expires > finished);
        let response = response.unwrap_or_else(|| FAILURE.to_vec());
        // Remove before the caller receives a signature, under the same mutex
        // the native wrapper holds throughout this operation.
        if done {
            self.close(owner, id);
        }
        Reply {
            response: STANDARD.encode(response),
            done,
        }
    }
}

impl Session {
    fn bind(&mut self, r: &mut Reader<'_>) -> Option<Vec<u8>> {
        if r.string()? != b"session-bind@openssh.com" || self.binding.is_some() || r.string()? != self.host_key {
            return None;
        }
        let session = r.string()?;
        if !(16..=128).contains(&session.len()) {
            return None;
        }
        let signature_bytes = r.string()?;
        // ssh-key's TryFrom decodes a signature but does not check trailing
        // bytes. Validate the two-string wire frame before handing it over.
        let mut sr = Reader(signature_bytes);
        sr.string()?;
        sr.string()?;
        if !sr.finished() || r.byte()? != 0 || !r.finished() {
            return None;
        }
        let signature = Signature::try_from(signature_bytes).ok()?;
        let key = PublicKey::from_bytes(&self.host_key).ok()?;
        Verifier::verify(&key, session, &signature).ok()?;
        self.binding = Some(session.to_vec());
        Some(vec![6])
    }

    fn sign(&self, r: &mut Reader<'_>) -> Option<Vec<u8>> {
        if r.string()? != self.public_key {
            return None;
        }
        let data = r.string()?;
        let flags = r.u32()?;
        if !r.finished() {
            return None;
        }
        let mut auth = Reader(data);
        if auth.string()? != self.binding.as_ref()?.as_slice()
            || auth.byte()? != 50
            || auth.string()? != self.user.as_bytes()
            || auth.string()? != b"ssh-connection"
            || auth.string()? != b"publickey-hostbound-v00@openssh.com"
            || auth.byte()? != 1
        {
            return None;
        }
        let algorithm = auth.string()?;
        if auth.string()? != self.public_key || auth.string()? != self.host_key || !auth.finished() {
            return None;
        }
        let signature = match self.key.key_data() {
            ssh_key::private::KeypairData::Rsa(key) => {
                // ssh-key 0.6.7's conversion passes p twice to the RSA
                // backend. Use its parsed components with rsa's validated
                // constructor, retaining q and enabling signature blinding.
                let private = rsa::RsaPrivateKey::from_components(
                    rsa::BigUint::try_from(&key.public.n).ok()?,
                    rsa::BigUint::try_from(&key.public.e).ok()?,
                    rsa::BigUint::try_from(&key.private.d).ok()?,
                    vec![
                        rsa::BigUint::try_from(&key.private.p).ok()?,
                        rsa::BigUint::try_from(&key.private.q).ok()?,
                    ],
                )
                .ok()?;
                private.validate().ok()?;
                if rsa::traits::PublicKeyParts::size(&private) < 256 {
                    return None;
                }
                let (hash, raw) = match (flags, algorithm) {
                    (2, b"rsa-sha2-256") => (
                        HashAlg::Sha256,
                        rsa::pkcs1v15::SigningKey::<sha2::Sha256>::new(private)
                            .try_sign_with_rng(&mut OsRng, data)
                            .ok()?
                            .to_vec(),
                    ),
                    (4, b"rsa-sha2-512") => (
                        HashAlg::Sha512,
                        rsa::pkcs1v15::SigningKey::<sha2::Sha512>::new(private)
                            .try_sign_with_rng(&mut OsRng, data)
                            .ok()?
                            .to_vec(),
                    ),
                    _ => return None,
                };
                Signature::new(Algorithm::Rsa { hash: Some(hash) }, raw).ok()?
            }
            _ => {
                if flags != 0 || algorithm != self.key.algorithm().as_str().as_bytes() {
                    return None;
                }
                self.key.try_sign(data).ok()?
            }
        };
        let wire = Vec::<u8>::try_from(signature).ok()?;
        let mut response = vec![14];
        put(&mut response, &wire);
        Some(response)
    }
}

struct Reader<'a>(&'a [u8]);
impl<'a> Reader<'a> {
    fn byte(&mut self) -> Option<u8> {
        let (&byte, rest) = self.0.split_first()?;
        self.0 = rest;
        Some(byte)
    }
    fn u32(&mut self) -> Option<u32> {
        let bytes = self.0.get(..4)?.try_into().ok()?;
        self.0 = &self.0[4..];
        Some(u32::from_be_bytes(bytes))
    }
    fn string(&mut self) -> Option<&'a [u8]> {
        let len = self.u32()? as usize;
        let bytes = self.0.get(..len)?;
        self.0 = &self.0[len..];
        Some(bytes)
    }
    fn finished(&self) -> bool {
        self.0.is_empty()
    }
}
fn put(out: &mut Vec<u8>, value: &[u8]) {
    out.extend((value.len() as u32).to_be_bytes());
    out.extend(value);
}

/// Bound the CPU work of a selected encrypted file before accepting a password.
pub fn unlock_key(key: &PrivateKey, passphrase: &str) -> Result<PrivateKey, String> {
    if let ssh_key::Kdf::Bcrypt { rounds, .. } = key.kdf() {
        if *rounds > 1024 {
            return Err("This key's encryption takes too long for a temporary login. Choose a key with fewer than 1,025 bcrypt rounds.".into());
        }
    }
    key.decrypt(passphrase)
        .map_err(|_| "Couldn't unlock that SSH key. Check its passphrase and choose the key again.".into())
}

pub use zeroize::Zeroizing as Secret;

#[cfg(test)]
mod tests {
    use super::*;
    fn owner() -> Owner {
        Owner {
            window: "main".into(),
            origin: "https://plane.example".into(),
        }
    }
    fn key() -> PrivateKey {
        PrivateKey::random(&mut OsRng, Algorithm::Ed25519).unwrap()
    }
    fn fixture() -> (Signers, Selected, PrivateKey, PrivateKey) {
        let private = key();
        let host = key();
        let mut signers = Signers::default();
        let selected = signers
            .insert(
                owner(),
                "alice".into(),
                host.public_key().to_bytes().unwrap(),
                private.clone(),
                Instant::now() + LIFETIME,
            )
            .unwrap();
        (signers, selected, private, host)
    }
    fn bind(host: &PrivateKey, session: &[u8]) -> Vec<u8> {
        let mut request = vec![27];
        put(&mut request, b"session-bind@openssh.com");
        put(&mut request, &host.public_key().to_bytes().unwrap());
        put(&mut request, session);
        put(
            &mut request,
            &Vec::<u8>::try_from(host.try_sign(session).unwrap()).unwrap(),
        );
        request.push(0);
        request
    }
    fn auth(private: &PrivateKey, host: &PrivateKey, session: &[u8], user: &[u8]) -> Vec<u8> {
        let mut data = Vec::new();
        put(&mut data, session);
        data.push(50);
        put(&mut data, user);
        put(&mut data, b"ssh-connection");
        put(&mut data, b"publickey-hostbound-v00@openssh.com");
        data.push(1);
        put(&mut data, private.algorithm().as_str().as_bytes());
        put(&mut data, &private.public_key().to_bytes().unwrap());
        put(&mut data, &host.public_key().to_bytes().unwrap());
        data
    }
    fn sign(private: &PrivateKey, data: &[u8]) -> Vec<u8> {
        let mut request = vec![13];
        put(&mut request, &private.public_key().to_bytes().unwrap());
        put(&mut request, data);
        request.extend(0u32.to_be_bytes());
        request
    }
    fn request(signers: &mut Signers, selected: &Selected, bytes: &[u8]) -> Reply {
        signers.request(&owner(), &selected.id, &STANDARD.encode(bytes))
    }
    const SESSION: &[u8] = &[42; 32];
    #[test]
    fn one_verified_hostbound_signature_then_key_is_gone() {
        let (mut signers, selected, private, host) = fixture();
        let identities = request(&mut signers, &selected, &[11]);
        let bytes = STANDARD.decode(identities.response).unwrap();
        let mut r = Reader(&bytes);
        assert_eq!(r.byte(), Some(12));
        assert_eq!(r.u32(), Some(1));
        assert_eq!(r.string().unwrap(), private.public_key().to_bytes().unwrap());
        r.string().unwrap();
        assert!(r.finished());
        assert_eq!(request(&mut signers, &selected, &bind(&host, SESSION)).response, "Bg==");
        let data = auth(&private, &host, SESSION, b"alice");
        let signed = request(&mut signers, &selected, &sign(&private, &data));
        assert!(signed.done);
        let bytes = STANDARD.decode(signed.response).unwrap();
        let mut r = Reader(&bytes);
        assert_eq!(r.byte(), Some(14));
        let signature = Signature::try_from(r.string().unwrap()).unwrap();
        assert!(r.finished());
        Verifier::verify(private.public_key(), &data, &signature).unwrap();
        assert!(signers.sessions.is_empty());
        let reused = request(&mut signers, &selected, &sign(&private, &data));
        assert_eq!(reused.response, "BQ==");
        assert!(reused.done);
    }
    #[test]
    fn forged_or_mismatched_host_bindings_never_arm_signer() {
        let (mut signers, selected, _, host) = fixture();
        let mut forged = bind(&host, SESSION);
        let last = forged.len() - 2;
        forged[last] ^= 1;
        assert_eq!(request(&mut signers, &selected, &forged).response, "BQ==");
        assert_eq!(
            request(&mut signers, &selected, &bind(&key(), SESSION)).response,
            "BQ=="
        );
        assert!(signers.sessions[&selected.id].binding.is_none());
    }
    #[test]
    fn forwarding_trailing_bytes_and_rebinding_are_refused() {
        let (mut signers, selected, _, host) = fixture();
        let mut forwarded = bind(&host, SESSION);
        *forwarded.last_mut().unwrap() = 1;
        assert_eq!(request(&mut signers, &selected, &forwarded).response, "BQ==");
        let mut trailing = bind(&host, SESSION);
        trailing.push(0);
        assert_eq!(request(&mut signers, &selected, &trailing).response, "BQ==");
        assert_eq!(request(&mut signers, &selected, &bind(&host, SESSION)).response, "Bg==");
        assert_eq!(
            request(&mut signers, &selected, &bind(&host, &[7; 32])).response,
            "BQ=="
        );
        assert_eq!(signers.sessions[&selected.id].binding.as_deref(), Some(SESSION));
    }
    #[test]
    fn unbound_wrong_user_wrong_session_wrong_host_wrong_key_and_raw_data_fail() {
        let (mut signers, selected, private, host) = fixture();
        let data = auth(&private, &host, SESSION, b"alice");
        assert_eq!(
            request(&mut signers, &selected, &sign(&private, &data)).response,
            "BQ=="
        );
        request(&mut signers, &selected, &bind(&host, SESSION));
        for data in [
            auth(&private, &host, SESSION, b"bob"),
            auth(&private, &host, &[7; 32], b"alice"),
            auth(&private, &key(), SESSION, b"alice"),
            auth(&key(), &host, SESSION, b"alice"),
            b"sign this arbitrary challenge".to_vec(),
        ] {
            assert_eq!(
                request(&mut signers, &selected, &sign(&private, &data)).response,
                "BQ=="
            );
        }
        assert_eq!(request(&mut signers, &selected, &sign(&key(), &data)).response, "BQ==");
        assert_eq!(signers.sessions.len(), 1);
    }
    #[test]
    fn ordinary_unhostbound_userauth_and_unrecognized_requests_fail() {
        let (mut signers, selected, private, host) = fixture();
        request(&mut signers, &selected, &bind(&host, SESSION));
        let mut data = Vec::new();
        put(&mut data, SESSION);
        data.push(50);
        put(&mut data, b"alice");
        put(&mut data, b"ssh-connection");
        put(&mut data, b"publickey");
        data.push(1);
        put(&mut data, b"ssh-ed25519");
        put(&mut data, &private.public_key().to_bytes().unwrap());
        for packet in [sign(&private, &data), vec![17], vec![11, 0], vec![27], vec![13]] {
            assert_eq!(request(&mut signers, &selected, &packet).response, "BQ==");
        }
    }
    #[test]
    fn rsa_sha256_and_sha512_flags_are_respected_and_sha1_is_refused() {
        let rsa = rsa::RsaPrivateKey::new(&mut OsRng, 2048).unwrap();
        let private = PrivateKey::new(
            ssh_key::private::KeypairData::Rsa(ssh_key::private::RsaKeypair::try_from(rsa).unwrap()),
            "",
        )
        .unwrap();
        let host = key();
        for (flags, algorithm, expected_hash) in [
            (2u32, b"rsa-sha2-256".as_slice(), HashAlg::Sha256),
            (4u32, b"rsa-sha2-512".as_slice(), HashAlg::Sha512),
        ] {
            let mut signers = Signers::default();
            let selected = signers
                .insert(
                    owner(),
                    "alice".into(),
                    host.public_key().to_bytes().unwrap(),
                    private.clone(),
                    Instant::now() + LIFETIME,
                )
                .unwrap();
            request(&mut signers, &selected, &bind(&host, SESSION));
            let mut data = Vec::new();
            put(&mut data, SESSION);
            data.push(50);
            put(&mut data, b"alice");
            put(&mut data, b"ssh-connection");
            put(&mut data, b"publickey-hostbound-v00@openssh.com");
            data.push(1);
            put(&mut data, algorithm);
            put(&mut data, &private.public_key().to_bytes().unwrap());
            put(&mut data, &host.public_key().to_bytes().unwrap());
            let mut packet = sign(&private, &data);
            // A legacy (SHA1) flags field and a mismatching SHA2 flags field
            // must both fail while leaving the valid one-use request possible.
            assert_eq!(request(&mut signers, &selected, &packet).response, "BQ==");
            let end = packet.len();
            packet[end - 4..].copy_from_slice(&(6 - flags).to_be_bytes());
            assert_eq!(request(&mut signers, &selected, &packet).response, "BQ==");
            packet[end - 4..].copy_from_slice(&flags.to_be_bytes());
            let reply = request(&mut signers, &selected, &packet);
            assert!(reply.done);
            let bytes = STANDARD.decode(reply.response).unwrap();
            let mut r = Reader(&bytes);
            assert_eq!(r.byte(), Some(14));
            let signature = Signature::try_from(r.string().unwrap()).unwrap();
            assert_eq!(
                signature.algorithm(),
                Algorithm::Rsa {
                    hash: Some(expected_hash)
                }
            );
            Verifier::verify(private.public_key(), &data, &signature).unwrap();
        }
    }

    #[test]
    fn origin_and_window_scope_apply_to_requests_and_close() {
        let (mut signers, selected, _, _) = fixture();
        for other in [
            Owner {
                window: "main".into(),
                origin: "https://evil.example".into(),
            },
            Owner {
                window: "node".into(),
                origin: owner().origin,
            },
        ] {
            assert_eq!(signers.request(&other, &selected.id, "Cw==").response, "BQ==");
            signers.close(&other, &selected.id);
            assert_eq!(signers.sessions.len(), 1);
        }
        signers.close(&owner(), &selected.id);
        signers.close(&owner(), &selected.id);
        assert!(signers.sessions.is_empty());
    }
    #[test]
    fn expiration_and_navigation_release_without_another_request() {
        let (mut signers, selected, _, _) = fixture();
        signers.sessions.get_mut(&selected.id).unwrap().expires = Instant::now();
        signers.expire();
        assert!(signers.sessions.is_empty());
        assert!(request(&mut signers, &selected, &[11]).done);
        let (mut signers, _, _, _) = fixture();
        signers.close_owner("main");
        assert!(signers.sessions.is_empty());
    }
    #[test]
    fn operation_crossing_deadline_discards_success_and_releases_key_on_failure_too() {
        for valid in [true, false] {
            let (mut signers, selected, private, host) = fixture();
            request(&mut signers, &selected, &bind(&host, SESSION));
            let packet = if valid {
                sign(&private, &auth(&private, &host, SESSION, b"alice"))
            } else {
                sign(&private, b"invalid auth payload")
            };
            let deadline = signers.sessions[&selected.id].expires;
            let mut times = [deadline - Duration::from_millis(1), deadline].into_iter();
            let reply = signers.request_with_clock(&owner(), &selected.id, &STANDARD.encode(packet), || {
                times.next().unwrap()
            });
            assert_eq!(reply.response, "BQ==");
            assert!(reply.done);
            assert!(signers.sessions.is_empty());
        }
    }

    #[test]
    fn malformed_and_oversized_payloads_fail_without_signing() {
        let (mut signers, selected, _, _) = fixture();
        for data in [
            vec![13, 255, 255, 255, 255],
            vec![11; MAX_BYTES + 1],
            vec![27, 0, 0, 0, 255],
        ] {
            assert_eq!(request(&mut signers, &selected, &data).response, "BQ==");
        }
        assert_eq!(signers.request(&owner(), &selected.id, "!!!").response, "BQ==");
        assert_eq!(signers.sessions.len(), 1);
    }
    #[test]
    fn concurrent_signatures_have_one_winner() {
        let (mut signers, selected, private, host) = fixture();
        request(&mut signers, &selected, &bind(&host, SESSION));
        let packet = STANDARD.encode(sign(&private, &auth(&private, &host, SESSION, b"alice")));
        let state = std::sync::Arc::new(std::sync::Mutex::new(signers));
        let id = selected.id;
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let state = state.clone();
                let id = id.clone();
                let packet = packet.clone();
                std::thread::spawn(move || state.lock().unwrap().request(&owner(), &id, &packet))
            })
            .collect();
        let responses: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(responses.iter().filter(|r| r.response != "BQ==").count(), 1);
        assert!(state.lock().unwrap().sessions.is_empty());
    }
    #[test]
    fn encrypted_key_unlock_stays_native_and_wrong_password_fails() {
        let key = key();
        let encrypted = key.encrypt(&mut OsRng, "secret").unwrap();
        assert!(encrypted.is_encrypted());
        assert!(unlock_key(&encrypted, "wrong").is_err());
        assert_eq!(unlock_key(&encrypted, "secret").unwrap().public_key(), key.public_key());
    }
    #[cfg(unix)]
    #[test]
    fn selected_files_are_bounded_regular_files_and_never_symlinks() {
        use std::os::unix::fs::symlink;
        let dir = std::env::temp_dir().join(format!("subshell-key-{}", random_id().replace('/', "_")));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("key");
        std::fs::write(&path, vec![b'x'; MAX_BYTES + 1]).unwrap();
        assert!(load_key(&path).is_err());
        assert!(load_key(&dir).is_err());
        let link = dir.join("link");
        symlink(&path, &link).unwrap();
        assert!(load_key(&link).is_err());
        std::fs::write(&path, key().to_openssh(ssh_key::LineEnding::LF).unwrap().as_bytes()).unwrap();
        assert!(load_key(&path).is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
