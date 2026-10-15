---
"@internal/server": minor
"@internal/node": patch
"@internal/desktop-server": minor
"@internal/desktop-client": minor
---

Connect an SSH subshell using a key selected on your own machine in a browser or desktop app. The key stays in the local signer, authorizes one host-bound authentication, and is released after use or a short timeout. Add native key selection and encrypted-key unlock, an authenticated temporary signing bridge, browser signing with explicit website-trust and memory-cleanup warnings, and guidance on verification and cleanup.

The desktop picker supports Ed25519, ECDSA and RSA private and host keys. Native RSA uses AWS-LC instead of the RustCrypto RSA backend; browser RSA uses Web Crypto. Failed browser attempts retain the selected file and passphrase for retry until the signing flow succeeds or the form is closed.
