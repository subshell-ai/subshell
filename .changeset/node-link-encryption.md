---
"@internal/server": minor
"@internal/node": minor
---

The node ↔ control-plane link is now encrypted end to end. Every `/ws/node` connection negotiates a fresh key with libsodium's `crypto_kx` — each side authenticates against the long-term identity it pinned at pairing — and after that the socket carries only ratcheted `crypto_secretstream` ciphertext, never resynced. A server on plain `http://` no longer puts launch commands, pane bytes, or bearer tokens on the network in the clear; whoever can see the node's network can no longer read it.

This is a hard protocol cutover (13 → 14, minimum node version 0.17.0) with no plaintext fallback. Deploy order: server first, then nodes. Nodes enrolled before the link existed pair themselves on their first connect after updating — the agent mints its keypair and registers it over the socket its bearer key already authenticates — and rotating a node's key re-provisions the link identity through the same self-heal. A node that skips or fails the handshake is refused with close code 4410 and retries with its backoff, never silently degraded to plaintext.
