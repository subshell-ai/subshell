//! Explicit real-wire check: requires local OpenSSH client + sshd executables.
//! Run with `cargo test --test ssh_signer_openssh -- --ignored`.
#![cfg(unix)]
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::rngs::OsRng;
use ssh_key::{Algorithm, PrivateKey};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    },
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use subshell_desktop_core::ssh_signer::{self, Owner, Signers};
use wait_timeout::ChildExt;

struct Fixture {
    root: PathBuf,
    daemon: Option<Child>,
    stopped: Arc<AtomicBool>,
    agent: Option<std::thread::JoinHandle<()>>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        let _ = UnixStream::connect(self.root.join("agent.sock"));
        if let Some(agent) = self.agent.take() {
            let _ = agent.join();
        }
        if let Some(mut daemon) = self.daemon.take() {
            let _ = daemon.kill();
            let _ = daemon.wait();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
#[ignore = "requires an installed OpenSSH sshd; run explicitly for SSH signer changes"]
fn real_openssh_accepts_one_native_hostbound_signature() {
    let root = std::env::temp_dir().join(format!(
        "subshell-native-wire-{}",
        ssh_signer::random_id().replace('/', "_")
    ));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let mut fixture = Fixture {
        root: root.clone(),
        daemon: None,
        stopped: Arc::new(AtomicBool::new(false)),
        agent: None,
    };
    let host = PrivateKey::random(&mut OsRng, Algorithm::Ed25519).unwrap();
    let private = PrivateKey::random(&mut OsRng, Algorithm::Ed25519).unwrap();
    fs::write(
        root.join("hostkey"),
        host.to_openssh(ssh_key::LineEnding::LF).unwrap().as_bytes(),
    )
    .unwrap();
    fs::set_permissions(root.join("hostkey"), fs::Permissions::from_mode(0o600)).unwrap();
    let public = private.public_key().to_openssh().unwrap();
    fs::write(root.join("authorized_keys"), &public).unwrap();
    fs::write(root.join("identity.pub"), &public).unwrap();
    let user_output = Command::new("id").arg("-un").output().unwrap();
    assert!(user_output.status.success());
    let user = String::from_utf8(user_output.stdout).unwrap().trim().to_owned();
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    fs::write(
        root.join("known_hosts"),
        format!("[127.0.0.1]:{port} {}\n", host.public_key().to_openssh().unwrap()),
    )
    .unwrap();
    let config = format!("Port {port}\nListenAddress 127.0.0.1\nAddressFamily inet\nHostKey {}\nPidFile {}\nAuthorizedKeysFile {}\nStrictModes no\nUsePAM no\nUseDNS no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nPermitRootLogin yes\nPrintMotd no\nLogLevel VERBOSE\n",root.join("hostkey").display(),root.join("sshd.pid").display(),root.join("authorized_keys").display());
    fs::write(root.join("sshd_config"), config).unwrap();
    let daemon_path = ["/usr/sbin/sshd", "/usr/local/sbin/sshd", "/opt/homebrew/sbin/sshd"]
        .into_iter()
        .find(|path| std::path::Path::new(path).is_file())
        .expect("install sshd before running this explicit test");
    fixture.daemon = Some(
        Command::new(daemon_path)
            .args(["-D", "-e", "-f"])
            .arg(root.join("sshd_config"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create(root.join("sshd.log")).unwrap())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while TcpStream::connect(("127.0.0.1", port)).is_err() {
        if Instant::now() > deadline || fixture.daemon.as_mut().unwrap().try_wait().unwrap().is_some() {
            panic!(
                "isolated sshd did not start: {}",
                fs::read_to_string(root.join("sshd.log")).unwrap()
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let listener = UnixListener::bind(root.join("agent.sock")).unwrap();
    let owner = Owner {
        window: "main".into(),
        origin: "https://plane.example".into(),
    };
    let mut signers = Signers::default();
    let selected = signers
        .insert(
            owner.clone(),
            user.clone(),
            host.public_key().to_bytes().unwrap(),
            private,
            Instant::now() + ssh_signer::LIFETIME,
        )
        .unwrap();
    let selected_id = selected.id.clone();
    let signers = Arc::new(Mutex::new(signers));
    let state = signers.clone();
    let stopped = fixture.stopped.clone();
    let signed = Arc::new(AtomicUsize::new(0));
    let signed_count = signed.clone();
    fixture.agent = Some(std::thread::spawn(move || {
        for connection in listener.incoming() {
            if stopped.load(Ordering::SeqCst) {
                break;
            }
            let mut connection = connection.unwrap();
            connection.set_read_timeout(Some(Duration::from_millis(250))).unwrap();
            loop {
                if stopped.load(Ordering::SeqCst) {
                    return;
                }
                let mut length = [0u8; 4];
                match connection.read_exact(&mut length) {
                    Ok(()) => {}
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) =>
                    {
                        continue
                    }
                    Err(_) => break,
                }
                let length = u32::from_be_bytes(length) as usize;
                assert!(length <= ssh_signer::MAX_BYTES);
                let mut payload = vec![0u8; length];
                connection.read_exact(&mut payload).unwrap();
                let reply = state
                    .lock()
                    .unwrap()
                    .request(&owner, &selected.id, &STANDARD.encode(&payload));
                let response = STANDARD.decode(reply.response).unwrap();
                if response.first() == Some(&14) {
                    signed_count.fetch_add(1, Ordering::SeqCst);
                }
                connection.write_all(&(response.len() as u32).to_be_bytes()).unwrap();
                connection.write_all(&response).unwrap();
            }
        }
    }));
    let mut ssh = Command::new("ssh")
        .args([
            "-F",
            "/dev/null",
            "-o",
            "BatchMode=yes",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "PubkeyAuthentication=host-bound",
            "-o",
            "PreferredAuthentications=publickey",
            "-o",
            "ForwardAgent=no",
            "-o",
            "GlobalKnownHostsFile=/dev/null",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ConnectTimeout=5",
        ])
        .arg("-o")
        .arg(format!("IdentityAgent={}", root.join("agent.sock").display()))
        .arg("-o")
        .arg(format!("UserKnownHostsFile={}", root.join("known_hosts").display()))
        .arg("-i")
        .arg(root.join("identity.pub"))
        .arg("-p")
        .arg(port.to_string())
        .arg(format!("{user}@127.0.0.1"))
        .arg("printf local-key-ok")
        .stdin(Stdio::null())
        .stdout(fs::File::create(root.join("ssh.out")).unwrap())
        .stderr(fs::File::create(root.join("ssh.err")).unwrap())
        .spawn()
        .unwrap();
    let status = ssh.wait_timeout(Duration::from_secs(10)).unwrap();
    if status.is_none() {
        let _ = ssh.kill();
        let _ = ssh.wait();
    }
    assert!(
        status.is_some_and(|status| status.success()),
        "OpenSSH login failed: {}\nsshd: {}",
        fs::read_to_string(root.join("ssh.err")).unwrap(),
        fs::read_to_string(root.join("sshd.log")).unwrap()
    );
    assert_eq!(fs::read_to_string(root.join("ssh.out")).unwrap(), "local-key-ok");
    assert_eq!(signed.load(Ordering::SeqCst), 1);
    // The second connection gets no identity: the native private key has
    // already been released, even while the fixture's agent socket lives.
    assert!(
        signers
            .lock()
            .unwrap()
            .request(
                &Owner {
                    window: "main".into(),
                    origin: "https://plane.example".into()
                },
                &selected_id,
                "Cw=="
            )
            .done
    );
}
