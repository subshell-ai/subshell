# Desktop release verification fixtures

The text payloads stand in for update bundles; no test installs or executes them.
The manifest names the newer payload's SHA-256 for each supported server platform.
The older payload also has a valid signature from the same throwaway publisher,
which demonstrates why verifying only a bundle signature cannot bind its version.

Generated with the repository's Tauri CLI (`signer generate --ci -p ''`, then
`signer sign -f <temporary-key> -p '' <file>`). Only the public key, signatures
and payloads are retained. The temporary private key was deleted.
