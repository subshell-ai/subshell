# Node link encryption — design (2026-09-24)

Encrypt every byte that crosses the node ↔ control-plane link (`/ws/node`),
regardless of how the server is deployed. Motivation is operational, not
theoretical: a high share of installs will run the server on plain `http://`
with no TLS in front, and today the node link then carries launch argv (bearer
tokens included), commands, and live pane bytes in clear text on the network.
The node never sees a browser's "Not secure" chip, so the exposure is
invisible by construction. Decisions recorded here were made by the operator
this session: hard cutover via a protocol bump (no plaintext fallback for new
nodes), and "use maintained libraries, roll nothing" (which retired the
original hand-rolled Noise design).

## 1. Scope

**In:** the `/ws/node` WebSocket, both directions, all frames — commands,
`ready`/heartbeats/events, capture results, relayed pane output, log reads,
runtime reports.

**Out (the remaining plaintext-on-LAN list, stated so nobody rediscovers it):**

1. Browser/dashboard ↔ server HTTP+WS — the server must read these bytes to
   serve them; confidentiality there is TLS's job (§12 prerequisite, unchanged).
2. `GET /api/downloads/node/*` and the install one-liners — binaries are
   publisher-signed (the digest gate is integrity, and §11.12 stands); update
   tokens are 10-minute, single-use, hashed-at-rest.
3. The node's loopback dashboard — local socket, no wire.

## 2. The library

`libsodium-wrappers-sumo` pinned (v0.8.4 at writing; WASM + pure JS; the
registry lists Bun as a supported runtime, and it bundles cleanly through
`bun build --compile`, which native-addon options like `noise-handshake`'s do
not promise across our three cross-compiled targets). Two official libsodium
constructions do all cryptographic work:

- `crypto_kx_client_session_keys` / `crypto_kx_server_session_keys` — a
  one-round, two-message key exchange: two ephemeral×static X25519 DHs plus a
  hash binding, yielding independent `rx`/`tx` keys per connection.
- `crypto_secretstream_xchacha20poly1305` — a ratcheting authenticated
  byte-stream cipher (pull/push API, per-message rekey built in) for the frame
  stream itself.

Nothing crypto-shaped is written in this repo: no pattern state machine, no
cipher plumbing, no nonce handling. We only choose the constructions and wire
them to our identities. Version-pin per `.claude/rules/dependencies.md`; the
wave's new `audit:deps` CI gate watches it from day one.

Rejected alternatives (recorded so they don't resurface): `noise-handshake`
(maintained, genuine Noise, but native sodium bindings inside a cross-compiled
Bun binary are the packaging-risk class this repo has already been bitten by);
`noise-protocol` (unpublished since 2023); `@libp2p/noise` (real and current,
but drags the libp2p stack for one pattern); hand-rolled Noise_IK on
`node:crypto` (the operator vetoed self-written protocol code).

## 3. Keys and provisioning

- **Server static** — a second boot-generated keypair beside the existing
  signing one: `<dataDir>/node-encryption.json`, 0600, same lifecycle and
  rotation semantics as `node-signing.json` (rotation breaks every pin by
  design; docs already carry that warning for the signing key). Deliberately
  NOT derived from the signing keypair: domain separation, one key one job.
- **Node static** — an X25519 keypair generated **at enroll** by the agent;
  the private half lives in the 0600 `config.json`, the public half is sent in
  the enroll request and stored in a new `nodes.encryptPublicKey` column
  (migration file + the static map in `db/migrate.ts` — the both-places rule).
- **Server encryption pubkey** — new field in the enroll response
  (`controlEncryptPublicKey`), pinned into `config.json` exactly as
  `controlPublicKey` is today. Rotation consequence mirrors signing-key
  rotation: pins break, machines re-provision.
- `REQUIRED_FIELDS` in the agent's `config.ts` does NOT gain the new fields:
  a legacy config updated in place lacks them until §5's self-heal run.

## 4. The handshake (per connection)

1. The WS upgrade still authenticates with the `Authorization: Bearer`
   node key — unchanged; encryption is not the authenticator.
2. Node generates a fresh kx keypair (per-connection ephemeral). Text frame
   `{t:"kx", eph, pub}` where `pub` is its long-term node static.
3. Server checks `pub` against the row's `encryptPublicKey` (for registered
   nodes; see §5 for first-registration), generates its own fresh kx keypair,
   derives session keys, replies `{t:"kx", eph}`.
4. Both derive `crypto_kx_*_session_keys`. The node's first **secretstream
   push** carries the binding payload `{nodeId, nodeKey, protocolVersion}`;
   the server verifies nodeId against the bearer's row, the key by hash
   compare, and the long-term static already matched at step 3. The server's
   first push is `{t:"ok"}` — if the node cannot decrypt-and-read it, the
   pinned server static was wrong and the socket closes.
5. Every subsequent frame, both directions, is a binary secretstream message.
   The existing `parseNodeFrame` path runs unchanged behind decryption; WS
   `maxPayload` plus `NODE_MAX_FRAME_BYTES` still bound sizes (plaintext cap
   checked post-decrypt, ciphertext cap pre).

Properties: mutual authentication anchored on the pinned/provisioned statics
(an on-path attacker who can't break the pin can't complete the handshake),
per-connection forward secrecy (fresh ephemerals, both halves erased after
derivation), and downgrade-proofing: a protocol-14 client never writes a
plaintext frame, and a registered row's socket is refused before `ready` if it
skips the handshake — so "force plaintext" has no reachable path.

Rekeying: the secretstream ratchet covers per-message rekey by construction;
we add no schedule of our own. A TCP/proxy-buffered reconnect re-handshakes
from step 2, which is a fresh forward-secret session.

## 5. Migration — hard cutover, self-healing

`NODE_PROTOCOL_VERSION` bumps **13 → 14**. The server classifies every
connection by the node row's state, checked at upgrade time:

- **Row has `encryptPublicKey`** → handshake required; any pre-handshake
  non-`kx` frame closes 4410 (`handshake required`). No plaintext path exists.
- **Row has none (every node enrolled before this ships)** → the row is in
  **legacy** mode: it speaks today's plaintext and is treated exactly as a
  version-floor refusal is today — **held**: offline for every purpose but
  `update`. Its first connection runs one extra step: an authenticated
  `{t:"register", pub}` frame (trust root: the bearer key, the same one that
  authenticates every legacy frame and that enrollment itself vouched for).
  The server stores the pubkey and answers with `{t:"register-ok",
  controlEncryptPublicKey}` into the config; the agent reconnects encrypted.
  A legacy row that never registers stays held-updatable — which is its state
  after any protocol bump anyway.
- `POST /api/nodes/:id/key_rotate` additionally clears `encryptPublicKey`, so
  rotation re-provisions the encryption identity through the same self-heal.

The registration step lives in the NEW binary — today's agent cannot send
`{t:"register"}` it does not know, so the ordered reality is: legacy binary
connects exactly as today (held, updatable), receives its update over the
signed-command path, and the new binary — finding no encryption keys in its
config — registers on its first connect and reconnects encrypted. A freshly
enrolled node skips all of this (keys arrive at enroll). New agent + old
server = the register frame simply 404s as an unknown type and the agent
reconnects plaintext against a pre-bump server.

No node is ever re-enrolled by hand.

## 6. Failure modes

- Handshake malformed / pubkey mismatch / binding-payload mismatch / step-4
  ack undecryptable → close **4410** with a reason the agent relays to its own
  log (the 4403/4406 doctrine; `4410` is a new constant, collision-checked
  against the existing close-code table at spec-writing time). The socket never
  reaches `ready`.
- Frame overflow (either cap) → existing oversized handling; ciphertext
  corruption → `pull` throws → close 4410 (never resync — the stream's
  integrity is the contract).
- Replay of an old handshake/binding onto a fresh socket: each connection's
  session keys are fresh; a foreign socket replaying old captured bytes cannot
  derive keys (its ephemeral DH differs), so replay is inert by construction —
  stated, not assumed; a test pins it.
- Server restart mid-handshake: nothing persisted before registration/`ready`;
  the agent reconnects per its backoff loop (60 s cap).

## 7. Testing

- Round-trip: real WS pair (server route harness + agent's connect code under
  test seams), full encrypted attach → `ready` → command → result, and a
  pane-byte relay frame both directions.
- Cutover matrix: registered row refuses plaintext (4410); legacy row holds;
  register self-heal completes and the second connect is encrypted; rotate
  clears and re-provisions; held update path unregressed.
- Negative: wrong pin, wrong bearer in binding payload, replayed frames,
  oversized ciphertext.
- Vectors: libsodium's published `crypto_kx` known-answer pairs against our
  derivation call shape (the library is trusted; our *wiring* is what's
  pinned).
- Perf sanity: 17-byte header per frame against 64 KiB captures — negligible;
  a keystroke-rate stream stays within the existing latency envelope (Wave D
  budgets).

## 8. Documentation aftercare

- `docs/security.md`: §1's "not defended against network-level attackers"
  narrows to the honest remainder (the §1 out-list); §4's "signing proves …
  never confidentiality" gains the new rule; §6 node-link bullets rewritten;
  §12 checklist's node-link prerequisite satisfied.
- `.claude/rules/security-context.md`: the Nodes section's signing bullet and
  the handshake doctrine (rules-to-code-by form, pointer not prose).
- `docs/security-overview.md`: the "Machines that run your agents" section
  upgrades to always-encrypted; shortfall 5 narrows.
- `apps/docs`: add-node/managing-a-node one-liners; reference pages for the
  new config fields + `node-encryption.json`.
- Changesets: `@internal/server` + `@internal/node` **minor** (protocol bump +
  new dependency + new config fields).

## 9. Explicit non-goals

PQ hygiene (kx is classic X25519; when a PQ story is wanted it's a
`libsodium`-successor conversation, not a bolt-on), per-message replay windows
beyond TCP's own (the stream ratchet is the mechanism), encrypting the
out-list in §1 here, and any change to command signing — signatures still
prove authenticity independently of encryption, so a bug in one is not fatal
to the other.

## Decisions log

- Hard cutover via protocol 14 — operator, 2026-09-24.
- Libraries over hand-rolled protocol code — operator, 2026-09-24
  ("use existing libraries"); libsodium chosen per §2's reasoning.
- Release-signature verifier stays hand-rolled-with-fixtures (no maintained
  library exists for tauri's `ED` armor variant; documented exception).
```