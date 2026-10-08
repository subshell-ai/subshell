# SSH sealed agent relay (Milestone 2) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship relay mode: an SSH pane running on a keyless connecting machine B authenticates to an sshd-only destination D through machine A's ssh-agent over sealed envelopes the plane routes but cannot read, plus the machine-identity roster, grants/approval, host-key pins, and the "Set up Subshell here" upgrade that the parent spec's Milestone 2 requires.

**Architecture:** Reuse the E2EE channel crypto (`mcp-core` seal/open) and the TOFU byte-equality rule in a NEW always-strict node-side machine pin store. Per-machine ES256 signing keys (minted at enroll) prove origin; the peer's signing AND encryption keys are byte-pinned. Sealed agent traffic rides a new frame type on the existing app-layer-encrypted `/ws/node` link (the daemon's only authenticated transport), which the plane blind-routes by an opaque ref. Grants and their first-use approval, destination host pins, and a durable relay-session broker live on the plane; the ssh-agent proxy socket lives on B and the responder on A. The destination upgrade re-uses ordinary enrollment driven non-interactively over the open session.

**Tech stack:** Bun, TypeScript, Elysia, Kysely (SQLite), jose (JWE/JWS via `mcp-core`), libsodium `crypto_kx`/secretstream node link, node-ED25519/P-256 through WebCrypto, React SPA (`apps/server/web`), Playwright e2e, an sshd test fixture (M1).

## Global Constraints

Every task implicitly includes these; values are copied from `docs/superpowers/specs/2026-10-08-ssh-agent-relay-design.md` and the parent.

- The relay is its own branch `feat/ssh-anywhere-m2` off `feat/ssh-anywhere-3`; commit as `Theo Gravity <theo@suteki.nu>`. Never push or merge without the operator's explicit word; M1 stays unmerged.
- No key material, challenge, signature, or agent payload in any log, argv, audit row, or notification. Audit rows name ids/hosts/field-names only.
- `shellQuote` on every token of the built `ssh` command; the connection is one tmux shell string (never reasoned away). `SSH_AUTH_SOCK` is exported into the `ssh` invocation only, never the whole pane env. An agent-capable SSH pane is view-only to sharees.
- Outbound SSH stays gated per node (`ssh_enabled`, default off, fail-closed). Both relay roles require an agent node; `local` is not an A/B.
- Sealing reuses `packages/mcp-core/src/crypto.ts`; the machine pin store is a separate file, always strict, and NEVER honors `SUBSHELL_CHANNEL_PIN`. Pin the peer's signing AND encryption keys byte-equal.
- Origin = ES256 signature over the canonicalized inner payload, verified against the pinned machine key. Replay = per-direction monotonic `seq` + endpoint-contributed session nonces, both signed.
- Static imports only (the lone sanctioned `await import` is `plugin-runtime.ts`, untouched).
- New wire caps are constants in `packages/subshell-protocol/src/ssh-limits.ts` and are law: `SSH_RELAY_FRAME_MAX_BYTES = 131_072`, `SSH_RELAY_MAX_PER_NODE = 8`, `SSH_RELAY_LIFETIME_MS = 30_000`, `SSH_RELAY_TEARDOWN_GRACE_MS = 5_000`, `SSH_MAX_GRANT_FINGERPRINTS = 8` (a distinct name from `SSH_MAX_IDENTITY_REFS`).
- `NODE_PROTOCOL_VERSION` bumps 17 to 18 (M1 already consumed 16 for the gate and 17 for the ssh-launch grammar); relay frames and the open/close commands ship in that bump.
- Migrations continue at `0049` (`apps/server/api/src/db/migrations/`); never run an M2 migration against a live DB; the ceiling/strip-set fixtures used in M1 must include the new migrations.
- Voice: no U+2013/U+2014 in prose or shipped strings (`bun run lint:prose` gates it); UI copy is at most two sentences, role tokens only.
- Verification: focused files while iterating; the full trio (`bun run verify-types`, `lint:check`, `lint:prose`) plus `bun run test` at every task boundary; `bunx turbo build` before any server/web/e2e test that consumes `packages/`; happy-dom tests run from `apps/server/web`; run shell-spawning suites with `env -u SHELLOPTS -u BASHOPTS` and check bun's file count; never target the live `:3080`.

---

## File structure (what gets created or modified)

**Protocol (`packages/subshell-protocol/src/`)**
- Modify `node-frames.ts`: `NODE_PROTOCOL_VERSION` 18; new command arms `ssh_register_identity`, `ssh_agent_identities`, `ssh_relay_open`, `ssh_relay_close`; new relay frame kind + `SshRelayFrame`; dispatch in `parseNodeCommandBody`.
- Modify `ssh-frames.ts` / `ssh-results.ts`: validators + result shapes for the four new commands and the relay frame.
- Modify `ssh-limits.ts`: the five new constants.
- New `ssh-pin-store.ts`: shared fingerprint + byte-equality helpers (pure, no node builtin).
- New `ssh-relay.ts`: pure relay envelope codec (canonicalize/sign/verify/nonce/seq), sealing via injected `seal`/`open` (no `node:` import; Metro-safe).

**Node agent (`apps/node/agent/src/`)**
- Modify `identity.ts`: generate + persist (0600) an ES256 signing keypair beside the ECDH pair; report its public JWK.
- Modify `enroll.ts`, `commands/index.ts`, `commands/report.ts` (ready report), and link register path to carry/register the signing key.
- New `commands/ssh-identity.ts` (`ssh_register_identity`, `ssh_agent_identities` handlers, copying `commands/set-ssh-enabled.ts`).
- New `commands/ssh-relay.ts` (the A-side responder) + `machine-pin-store.ts` (node-local pin file).
- New `relay-proxy.ts` (the B-side agent proxy socket) wired into `commands/ssh-relay.ts`.
- Modify `ssh-shared.ts` for shared relay/socket helpers.

**Server API (`apps/server/api/src/`)**
- New `db/migrations/0049-ssh-relay-identity.ts` (identities `signingPublicKey`; `nodes.ssh_fingerprint` mirror block), `0050-ssh-grants.ts` (`ssh_key_grants`, `ssh_grant_requests`, `ssh_host_pins`).
- Modify `db/types/identities.db-types.ts`, `db/types/nodes.db-types.ts`; new `db/types/ssh-grants.db-types.ts`.
- Modify `db/repositories/identities.repository.ts` (signing slot); new `ssh-grants.repository.ts`.
- New `services/ssh-relay.service.ts` (broker, route, responder RPC, grant/approval logic), `services/ssh-grants.service.ts`, `services/ssh-host-pins.service.ts`.
- New `services/nodes/relay-frames.ts` (link relay frame pump) and modify `services/nodes/node-ws-handler.ts` + `link-session.ts` for the new frame type + pairing.
- Modify `api/nodes/enroll.route.ts` (register signing key), `rotate-node-key.route.ts` (clear signing slot), `nodes/node-view.ts` + `get-node.route.ts` (fingerprint carriage, owner/edit gate).
- New `api/ssh/grants.route.ts`, `approvals.route.ts`, `trust.route.ts`, `setup-here.route.ts`; modify `api/ssh/index.ts`.
- Modify `services/notify.service.ts` (`grant_approval` kind + owner-addressed send); new pending-approval expiry sweep hook.

**Pane runtime (`packages/pane-runtime/src/ssh/`)**
- Modify `ssh-render.ts`: a pinned-config render path (UserKnownHostsFile from the host-pin + `StrictHostKeyChecking yes`) used only in relay mode.

**SPA (`apps/server/web/src/`)**
- Modify `lib/ssh.ts` (grant/approval/trust/setup-here calls + types); new `components/ssh/grants-screen.tsx`, `pending-approvals.tsx`, `trust-card.tsx`; route + nav wiring.

**Backend client:** `packages/backend-client` re-exports the app type; rebuild after routes land.

**Tests + docs:** `apps/node/agent/src/**/__tests__`, `apps/server/api/src/**/__tests__`, `apps/server/web/src/**/__tests__`, `packages/subshell-protocol/src/__tests__`, `e2e/tests/23-ssh-relay.spec.ts`; `docs/security.md` §10 event list.

---

## Task 1: Signing keypair at the node + enroll registration

**Files:**
- Modify: `apps/node/agent/src/identity.ts`
- Modify: `apps/server/api/src/db/migrations/0049-ssh-relay-identity.ts` (create), `apps/server/api/src/db/types/identities.db-types.ts`, `apps/server/api/src/db/repositories/identities.repository.ts`
- Modify: `apps/server/api/src/api/nodes/enroll.route.ts`, `apps/node/agent/src/enroll.ts`
- Test: `apps/node/agent/src/__tests__/identity.test.ts`, `apps/server/api/src/api/nodes/__tests__/enroll.route.test.ts` (existing file), `apps/server/api/src/db/migrations/__tests__` ceiling

**Interfaces:**
- Produces: `identity.signingKeyPair: CryptoKeyPair` (ES256, P-256) persisted 0600 with a sibling `node-signing-identity.json`; `identity.signingPublicJwk: string`. Identities record gains `signingPublicKey: string | null`. `register({ principalId, publicKey, signingPublicKey, displayName })`.

- [ ] **Step 1: Write the failing node identity test.** In `identity.test.ts`, assert the loaded identity exposes an ES256 (`"ES256"`/P-256) public JWK on `signingPublicJwk`, that a second load returns the SAME signing key (persisted), and that the file is mode 0600.
- [ ] **Step 2: Run it, confirm FAIL** (`env -u SHELLOPTS -u BASHOPTS bun test apps/node/agent/src/__tests__/identity.test.ts`).
- [ ] **Step 3: Implement.** In `identity.ts`, after the ECDH pair, `generateKeyPair("ES256", { crv: "P-256", extractable: true })`, persist to `node-signing-identity.json` 0600 (write the private JWK, `chmod 0o600`), load-or-generate on ENOENT only (mirror the ECDH loader); export `signingPublicJwk`. Do NOT regenerate on any error other than ENOENT.
- [ ] **Step 4: Migration 0049** adds `signingPublicKey` (`text` nullable) to the identities table and an `ssh_fingerprint` (`text` nullable, JSON mirror block) to `nodes`; add both to `IdentityTable` / `NodesTable` types. Follow `0048-ssh-launch-and-saved-hosts.ts`.
- [ ] **Step 5: Enroll carries it.** In `enroll.ts` add `signingPublicKey: identity.signingPublicJwk` to the enroll body; in `enroll.route.ts` validate it is a P-256 public JWK (mirror the `publicKey` decode/length block) and pass it to `IdentitiesRepository.register({ ..., signingPublicKey })`. Extend `reregister-node.ts` to swap it atomically.
- [ ] **Step 6: Register + repo.** `identities.repository.ts.register` writes `signingPublicKey`; add it to the interface. Node-delete cascade unchanged (row-scoped).
- [ ] **Step 7: Ceiling test** add 0049 to the migration-count/strip-set fixtures; run `env -u SHELLOPTS -u BASHOPTS bun test apps/server/api/src/db` and the enroll test; PASS.
- [ ] **Step 8: Commit** `git commit -m "feat(ssh-relay): per-machine ES256 signing keypair, registered at enroll"`.

## Task 2: Machine pin store + fingerprint helpers

**Files:**
- Create: `packages/subshell-protocol/src/ssh-pin-store.ts`
- Create: `apps/node/agent/src/machine-pin-store.ts`
- Test: `packages/subshell-protocol/src/__tests__/ssh-pin-store.test.ts`, `apps/node/agent/src/__tests__/machine-pin-store.test.ts`

**Interfaces:**
- Produces (protocol): `fingerprintJwk(publicJwkString): string` (SHA-256 over DER `SubjectPublicKeyInfo`, `SHA256:` + base64url no-pad), `bytesOfJwk(jwk): Uint8Array` canonicalization. (agent) `class MachinePinStore` with `get(nodeId): { signing: string; encryption: string } | null`, `pin(nodeId, { signing, encryption })`, `check(nodeId, candidate): "ok" | "changed"`, file `<nodeDataDir>/ssh-machine-pins.json` 0600.

- [ ] **Step 1: Failing protocol test.** `fingerprintJwk` returns a stable `SHA256:` string; two serializations of the same key (different JWK member order) yield the SAME fingerprint (proves DER-SPKI, not JSON). Wrong bytes differ.
- [ ] **Step 2: FAIL run** on the new test path.
- [ ] **Step 3: Implement `ssh-pin-store.ts`.** Import no `node:` builtin; use WebCrypto `crypto.subtle.importKey("jwk", ...)` + `exportKey("spki", ...)` then `digest("SHA-256")`, format `SHA256:` + base64url(no pad). Export the pure helpers.
- [ ] **Step 4: Failing store test.** `MachinePinStore`: first `pin` succeeds; `check` with the same bytes = ok; with different = "changed"; the file is a SEPARATE path from the pane `peers.json`; and reading never consults `SUBSHELL_CHANNEL_PIN` (assert the env var has no effect).
- [ ] **Step 5: Implement `machine-pin-store.ts`.** JSON map `nodeId -> {signing, encryption}`; byte-equality on both halves via the stored raw public strings, not fingerprints; 0600 after write (chmod); no fallback to `peers.json`; a distinct reader function. No `SUBSHELL_CHANNEL_PIN` reference.
- [ ] **Step 6: PASS** both test files.
- [ ] **Step 7: Commit** `git commit -m "feat(ssh-relay): always-strict node machine pin store (both keys, no channel escape)"`.

## Task 3: `ssh_register_identity` link delivery for pre-M2 nodes

**Files:**
- Modify: `packages/subshell-protocol/src/ssh-frames.ts`, `node-frames.ts`, `ssh-results.ts`
- Create: `apps/node/agent/src/commands/ssh-identity.ts`
- Modify: `apps/node/agent/src/commands/index.ts`, `apps/server/api/src/services/nodes/*` (ready handler), a new `ssh-rpc` helper
- Test: `apps/server/api/src/services/nodes/__tests__/ssh-identity-register.test.ts`

**Interfaces:**
- Consumes: `MachinePinStore` (Task 2), signing slot (Task 1). Produces: signed command `ssh_register_identity` returning `{ signingPublicKey }`; server `deliverSigningKey(node): Promise<string|null>` that stores into the slot and, when a DIFFERENT key is already present, refuses (own-registration guard) and returns the existing.

- [ ] **Step 1: Failing test.** `deliverSigningKey` writes a first-time report, is idempotent on a re-report of the same bytes, and rejects a report of a different key (returns existing, writes nothing).
- [ ] **Step 2: FAIL run.**
- [ ] **Step 3: Command shape.** Add the `ssh_register_identity` arm to `parseNodeCommandBody` + `SSH_COMMAND_TYPES` (census) + an `ssh-results.ts` validator for `{ signingPublicKey }`. Handler mirrors `commands/set-ssh-enabled.ts`: read `identity.signingPublicJwk`, return it.
- [ ] **Step 4: Server side.** In the `ready` handler, when an online agent reports no `signingPublicKey` slot, `sendCommand("ssh_register_identity")` once and store the answer into the slot through `deliverSigningKey`. Idempotent, audited `node.ssh_identity.register` with `via:"link"` (add the event name to `docs/security.md` §10).
- [ ] **Step 5: PASS** + protocol test that `parseNodeCommandBody` narrows the new arm and the census count matches.
- [ ] **Step 6: Commit** `git commit -m "feat(ssh-relay): ssh_register_identity delivers signing keys for pre-M2 nodes"`.

## Task 4: Protocol bump + relay frame type + constants

**Files:**
- Modify: `packages/subshell-protocol/src/node-frames.ts`, `ssh-limits.ts`, `index.ts`
- Test: `packages/subshell-protocol/src/__tests__/node-frames.test.ts` (census), a new relay-frame codec test

**Interfaces:**
- Produces: `NODE_PROTOCOL_VERSION = 18`; frame kinds `ssh_relay_open`/`ssh_relay_close` (signed commands) and a `relay` link frame `{ ref, seq, direction, blob }`; the five caps (Global Constraints). `parseRelayFrame(value): RelayFrame | null`.

- [ ] **Step 1: Failing test.** `NODE_PROTOCOL_VERSION === 18`; `parseRelayFrame` accepts `{ref:"r1",seq:0,direction:"B2A",blob:<b64>}` and rejects over-cap blobs (`> SSH_RELAY_FRAME_MAX_BYTES`) and malformed; the open/close command arms validate.
- [ ] **Step 2: FAIL run.**
- [ ] **Step 3: Implement.** Bump the version; add the open/close command arms (validators name: session id, routing ref, both node ids + roles, peer signing + encryption public keys, grant id + selected fingerprint set, lifetime); add the `relay` frame + `parseRelayFrame` enforcing the cap. Export from `index.ts`.
- [ ] **Step 4: Wire the link pump.** In `apps/server/api/src/services/nodes/link-session.ts` + `node-ws-handler.ts`, accept the `relay` frame after `open`, key pairing by `ref`, and forward between A's and B's sockets without parsing `blob`. Refuse on a pre-18 agent via the existing exact-match gate.
- [ ] **Step 5: PASS** (protocol tests + a plane-side pairing unit test with two fake sockets).
- [ ] **Step 6: Commit** `git commit -m "feat(ssh-relay): protocol 18, relay open/close commands + blind relay frame"`.

## Task 5: Relay envelope codec (origin, seq, nonces)

**Files:**
- Create: `packages/subshell-protocol/src/ssh-relay.ts`
- Test: `packages/subshell-protocol/src/__tests__/ssh-relay.test.ts`

**Interfaces:**
- Consumes: `MachinePinStore` check, `crypto.ts` seal/open, the signing key. Produces: `canonicalize(msg): string`, `sealAgentRequest(...)`, `openAgentRequest(...)`, per-direction `SeqGate` (`accept(dir, seq): boolean` monotonic), nonce helpers.

- [ ] **Step 1: Failing test.** A message signed by A verifies against A's pinned key and fails against a swapped key; `SeqGate` accepts increasing `seq` per direction and rejects equal/decreasing; a canonicalized payload binds session id + ref + direction + seq + nonces + agent bytes (changing any fails verification); `open` by the wrong recipient id throws.
- [ ] **Step 2: FAIL run.**
- [ ] **Step 3: Implement `ssh-relay.ts`.** Canonicalize deterministically (sorted-key JSON with fixed number formatting, base64url blobs); ES256 `sign`/`verify` over the canonical string (WebCrypto, injected key); wrap in `seal`/`open` (recipient encryption key from the pin); expose `SeqGate`. No `node:` import (Metro-safe).
- [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** `git commit -m "feat(ssh-relay): sealed envelope codec with signed canonical payload + seq gate"`.

## Task 6: B-side agent proxy socket

**Files:**
- Create: `apps/node/agent/src/relay-proxy.ts`
- Modify: `apps/node/agent/src/commands/ssh-relay.ts` (new, B branch), `ssh-shared.ts`
- Test: `apps/node/agent/src/__tests__/relay-proxy.test.ts`

**Interfaces:**
- Consumes: `ssh-relay.ts` codec, the relay frame pump, the machine pin of A. Produces: `startAgentProxy({ paneId, peerNodeId, sessionRef }): { socketPath, close() }` speaking the ssh-agent Unix wire: each request → sealed relay frame (direction B2A, next `seq`); each reply frame → opened and written back; `close()` unbinds.

- [ ] **Step 1: Failing test.** Against a stub agent, `startAgentProxy` accepts an `SSH2_AGENTC_REQUEST_IDENTITIES` on the socket, emits one sealed relay frame with `seq:0 direction:"B2A"`, and writes the reply bytes back to the socket verbatim; a second `SIGN_REQUEST` gets `seq:1`.
- [ ] **Step 2: FAIL run.**
- [ ] **Step 3: Implement.** Unix socket in `<dataDir>/ssh/<paneId>/agent.sock` (0600), framed length-prefixed agent messages; seal each to A's pinned encryption key with the ES256 signature; hand the sealed blob to the link pump as a `relay` frame; on reply, verify A's signature (pin) + `SeqGate` then write back. Never export the socket path beyond `SSH_AUTH_SOCK` (the pane env exception).
- [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** `git commit -m "feat(ssh-relay): B-side ssh-agent proxy socket over sealed relay frames"`.

## Task 7: A-side responder (allow-list, filter, origin)

**Files:**
- Create: `apps/node/agent/src/commands/ssh-relay.ts` (A branch) + `relay-responder.ts`
- Test: `apps/node/agent/src/__tests__/relay-responder.test.ts`

**Interfaces:**
- Consumes: `MachinePinStore`, `ssh-relay.ts`, the relay open command (grant id + selected fingerprint set + peer keys). Produces (the shipped seam): `startRelayResponder(...)` + `openARelaySession(...)` + `deliverInboundRelayFrame(frame)` returning `{ onRelayFrame, close }` registered into `RelaySessions`. It probes A's agent scheme at open, verifies origin against the machine pin, `SeqGate`s, default-denies agent methods, and filters identity/sign to the grant's fingerprint set (scope-before-forward in the resolved scheme). Two refusal tiers: an agent-layer FAILURE reply (a refused method or an ungranted key) vs frame-level silence (an origin/seq/shape failure drops the frame with no reply). `relay-responder.ts` is split with `relay-agent-scheme.ts` (schemes/probe/grammar) and `relay-agent-socket.ts` (transport).

- [ ] **Step 1: Failing test.** A valid `REQUEST_IDENTITIES` forwarded to a stub agent returns a roster filtered to the grant's fingerprints; a `SIGN_REQUEST` whose blob hash is outside the set is refused (null) and never forwarded; `ADD_IDENTITY`/`REMOVE_ALL_IDENTITIES`/`EXTENSION` refused; a wrong-origin (bad B signature) request refused.
- [ ] **Step 2: FAIL run.**
- [ ] **Step 3: Implement `relay-responder.ts`.** Verify B's signature against the machine pin (reject otherwise); `SeqGate` accept; decode the inner agent request.

  **Agent numbering is probed, not hard-coded (operator ruling 2026-10-08).** The agent request/response codepoints are NOT a single fixed set the responder may bake in: OpenSSH's classic numbering (identities request 13 / answer 14 / sign request 15 / sign response 16) and the RFC 9987 numbering OpenSSH 10.x ships (identities 11 / answer 12 / sign 13 / sign response 14) COLLIDE - codepoint 13 is *identities* under classic but *sign* under RFC, and 14 is *answer* under classic but *sign response* under RFC. Measured on this fleet's `OpenSSH_10.2p1`: request 11 answers 12; request 13 and 15 both answer FAILURE(5). Therefore the responder MUST, once per relay-session open, **probe A's live agent** to learn which numbering it speaks, then classify and scope every request in that discovered scheme. Probe by sending a well-formed identities request in one scheme and reading the response code: a valid IDENTITIES_ANSWER (12 or 14) names the scheme; a FAILURE(5) to the candidate that would be *sign* under the other scheme confirms the choice. Cache the resolved scheme on the A-side session; never re-interpret a byte without it.

  Forward ONLY the two read methods the scheme names: the identities request and the sign request. Do NOT trust any remembered numeric value - derive the forward-decision from the probed scheme, and default-deny ANY request type the scheme does not name as identities or sign (ADD_IDENTITY, REMOVE_IDENTITY, REMOVE_ALL_IDENTITIES, EXPLICIT_* / EXTENSION, and any unrecognized byte). **Scoping runs BEFORE any forward, for whichever codepoint the probed scheme treats as sign:** on identities, drop entries whose `SHA256:` (over the agent wire encoding) is not in the grant set; on sign, resolve the target key by its blob/agent reference and refuse (null) when that fingerprint is outside the grant set - never forward a sign request whose key is ungranted. Accept the RFC 9987 extended sign grammar (a sign request carries a trailing `string algorithms` list after the blob) as well as the classic (blob-only) form; parse both, refuse a malformed body, and refuse rather than forward an ambiguous byte-13 that the scheme has not confirmed as sign. Talk to A's live agent socket (agent-only, never read key files); seal+sign the reply (direction A2B, A's `nA`, next `seq`). The real-agent e2e (Task 16) is the arbiter that the probe picks the right scheme for a live `OpenSSH_10.x` agent.
- [ ] **Step 4: PASS** + a test that the responder runs only for a brokered session naming this A and refuses an unbrokered one.
- [ ] **Step 5: Commit** `git commit -m "feat(ssh-relay): A-side responder enforces origin, method allow-list, and grant fingerprint set"`.

## Task 8: Plane relay broker + lifetime/quota/teardown + audit

**Files:**
- Create: `apps/server/api/src/services/ssh-relay.service.ts`
- Modify: `services/nodes/relay-frames.ts` (create), `node-ws-handler.ts`
- Test: `apps/server/api/src/services/__tests__/ssh-relay.service.test.ts`

**Interfaces:**
- Produces: `openRelay({ grantId, aNode, bNode, paneId }): { sessionRef, expiry }` (in-memory), `routeRelayFrame(...)`, `closeRelay(ref, reason)`, quota check, timer teardown; emits `node.ssh_relay.open|close`.

- [ ] **Step 1: Failing test.** `openRelay` pairs A+B with an opaque ref and stores no payload; exceeding `SSH_RELAY_MAX_PER_NODE` throws a loud refusal; `closeRelay` on lifetime/grant-revoke/A-drop fires; frames route by ref without the plane holding bytes.
- [ ] **Step 2: FAIL run.**
- [ ] **Step 3: Implement.** In-memory `Map<ref, { grantId, aNode, bNode, paneId, expiresAt }>` + a per-node count; deliver the two `ssh_relay_open` signed commands (carrying both peer keys + the grant fingerprint set + lifetime); pump `relay` frames between the two sockets blind; `closeRelay` on expiry, A offline, grant revoke, handshake grace, child exit; audit open/close.
- [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** `git commit -m "feat(ssh-relay): plane relay broker with lifetime, quota, blind routing, audit"`.

## Task 9: Relay integration + replay tests

**Files:**
- Test: `apps/server/api/src/services/__tests__/ssh-relay.integration.test.ts`

- [ ] **Step 1: Write the integration matrix.** Two in-process machine identities over a fake plane broker: sign reaches A's stub agent and returns sealed; a non-allow-listed method refused; wrong-origin refused; a `SIGN_REQUEST` with an ungranted blob refused after a correct filtered roster; relayed blob byte-opaque at the plane; captured-envelope replay inside the window AND into a later reused-ref session inert; multi-key session (several `SIGN_REQUEST`s at increasing `seq`) completes; a resent/non-increasing `seq` refused; B rejects a bad A response signature; `ssh_agent_identities` accepted with no grant.
- [ ] **Step 2: Implement any seams the tests expose** (do not add behavior not in Tasks 5-8; if a gap appears, it is a real defect to fix in the owning module, not a test workaround).
- [ ] **Step 3: PASS all.** 
- [ ] **Step 4: Commit** `git commit -m "test(ssh-relay): relay integration matrix, replay inertness, reverse verification"`.

## Task 10: Grants + first-use approval + audit events

**Files:**
- Create: `db/migrations/0050-ssh-grants.ts`, `db/types/ssh-grants.db-types.ts`, `db/repositories/ssh-grants.repository.ts`, `services/ssh-grants.service.ts`
- Create: `api/ssh/grants.route.ts`, `api/ssh/approvals.route.ts`; modify `api/ssh/index.ts`
- Modify: `services/notify.service.ts` (a `grant_approval` owner-addressed kind), a pending-expiry sweep hook
- Modify: `docs/security.md` §10 event list
- Test: `apps/server/api/src/services/__tests__/ssh-grants.service.test.ts`, `api/ssh/__tests__/grants-route.test.ts`

**Interfaces:**
- Produces: `ssh_key_grants` (id, owner, name, keyHomeNodeId A, resolved selector, `fingerprints` JSON, createdVia); `ssh_grant_requests` (durable pending row + expiry sweep); `requestFirstUse`, `approveGrant`, `denyGrant`, `revokeGrant`, `matchGrant(owner, aNode, resolvedHost)`. `SSH_MAX_GRANT_FINGERPRINTS` overflow is a red error.

- [ ] **Step 1: Failing service test.** First use creates a `ssh_grant_requests` row and notifies; approve writes the grant with the chosen fingerprints and pins; second matching use is silent; deny writes the audit row only; expiry writes nothing; a `ssh_grant_requests` row survives a simulated restart and is swept at expiry; more-than-cap selection refuses.
- [ ] **Step 2: FAIL run.**
- [ ] **Step 3: Implement migration + repo + service + routes** (cookie + bearer-follows-ownership like the sibling ssh routes; owner-scoped; audit `node.ssh_grant.request|create|update|delete|approve|deny`). B's launch calls `requestFirstUse` and fails fast with the named refusal.
- [ ] **Step 4: notify kind.** Add `grant_approval` to `NotifyKind` + body/urgency maps, and an owner-addressed send path (the existing `notifyDevices` is subshell-row-shaped; add a sibling that takes the owner + a message, reusing the device-token machinery). It writes no secret.
- [ ] **Step 5: PASS** + `docs/security.md` §10 lists every new event.
- [ ] **Step 6: Commit** `git commit -m "feat(ssh-relay): key grants with first-use approval, durable pending row, audits"`.

## Task 11: `ssh_agent_identities` roster command

**Files:**
- Modify: `ssh-frames.ts`/`ssh-results.ts`, `node-frames.ts`; `apps/node/agent/src/commands/ssh-identity.ts`; `services/ssh-grants.service.ts` (approval screen feeds from it)
- Test: `apps/server/api/src/services/__tests__/ssh-agent-identities.test.ts`

- [ ] **Step 1: Failing test.** The plane sends `ssh_agent_identities` to A, gets `{ identities: [{ fingerprint, comment }] }` (blobs withheld), writes no audit row, and fails closed (returns an error, keeps the request pending) when A is offline.
- [ ] **Step 2: FAIL run.**
- [ ] **Step 3: Implement** the command arm + a handler that enumerates A's live agent public identities as `SHA256:` (agent-wire) + comment; the approvals route calls it to populate the operator's choice.
- [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** `git commit -m "feat(ssh-relay): ssh_agent_identities enumerates A's public roster for grant approval"`.

## Task 12: Host-key pins (capture, render, block, display)

**Files:**
- Create: `services/ssh-host-pins.service.ts`
- Modify: `packages/pane-runtime/src/ssh/ssh-render.ts`, `apps/node/agent/src/commands/ssh-relay.ts` (B render path), `api/ssh/trust.route.ts` (create)
- Test: `ssh-host-pins.service.test.ts`, `ssh-render.test.ts` (extend), `node-frames` unaffected

**Interfaces:**
- Produces: `captureHostPin(user@host:port, aKnownHostsOrPin)`, `hostPinFor(resolved)`, `deleteHostPin(resolved)`; render adds `UserKnownHostsFile <pinned>` + `StrictHostKeyChecking yes` in relay mode only.

- [ ] **Step 1: Failing test.** Grant creation captures A's host key as `ssh_host_pins` for `user@host:port`; relay render emits the pinned `UserKnownHostsFile` and `yes`; a changed D key refuses naming D; delete + fresh grant TOFU recovers.
- [ ] **Step 2: FAIL run.**
- [ ] **Step 3: Implement.** Capture at approve from A's `~/.ssh/known_hosts` (via a relay resolve) or an explicit pin; extend `ssh-render.ts` with a relay-mode branch (leave the M1 `accept-new` path untouched); refuse on mismatch; audit `node.ssh_host_pin.create|delete`.
- [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** `git commit -m "feat(ssh-relay): per-destination host-key pins, pinned render, changed-key block"`.

## Task 13: Machine trust card + fingerprint carriage + mirror + dashboard

**Files:**
- Modify: `apps/node/agent/src/commands/report.ts` (ready/runtime carries own + pinned-peer fingerprints), `services/nodes/node-view.ts`, `api/nodes/get-node.route.ts`, `rotate-node-key.route.ts` (clear signing slot); `apps/node/agent/src/dashboard/*` (local display); SPA `components/ssh/trust-card.tsx`
- Test: node-view gate test, dashboard test, `rotate-node-key.route.test.ts` (extend)

**Interfaces:**
- Produces: runtime report gains `sshFingerprint: { own: {signing,encryption}, peers: [{nodeId, signing, encryption}] }`; mirrored onto `nodes.ssh_fingerprint` (owner/`edit` gate, never `view`/`local`), stale-marked offline; loopback dashboard shows own + pinned-peer fingerprints.

- [ ] **Step 1: Failing tests.** A `view` grantee never sees the mirrored block; an offline agent node shows a stale-marked card; rotation clears the link pin + signing slot and the redial re-reports the same bytes (no block, no peer re-pair).
- [ ] **Step 2: FAIL run.**
- [ ] **Step 3: Implement** carriage + mirror + gating (mirror serializes under the same `nodeCanConfigure`/config-capable rule as `runtime`); dashboard render from the node-local store; SPA card on node detail (owner/`edit`).
- [ ] **Step 4: PASS** (server + agent + happy-dom web from `apps/server/web`).
- [ ] **Step 5: Commit** `git commit -m "feat(ssh-relay): machine trust card, mirrored fingerprints, rotation clearing, dashboard display"`.

## Task 14: Destination upgrade "Set up Subshell here"

**Files:**
- Create: `api/ssh/setup-here.route.ts`, `services/ssh-setup-here.service.ts`
- Modify: `apps/server/api/src/api/install-script.ts` (404 branch prints `--key <setup key>`), `apps/node/agent/src/commands/ssh-relay.ts` (non-interactive exec + redaction), SPA pane action
- Test: `ssh-setup-here.service.test.ts`, `install-script.test.ts` (extend)

**Interfaces:**
- Produces: `setupHere(paneId, ...)`: mint a setup key, run `ssh D '<install command>'` as a SEPARATE non-interactive connection (re-opening the relay in relay mode, requiring A online), parse only a status verb with a redaction rule, await the node `ready`.

- [ ] **Step 1: Failing tests.** The rendered installer 404 branch contains `--key <setup key>` and no key value; a non-egressing D refuses with the named egress cause and the pane untouched; the relay-mode act re-opens a relay and refuses naming A-online when A is down; success is detected via the new node's ready event.
- [ ] **Step 2: FAIL run.**
- [ ] **Step 3: Implement** the exec (never typed into the PTY; redactor drops any `nsk_…` line), the installer line fix, egress refusal, `node.ssh_upgrade.run` audit (never the key).
- [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** `git commit -m "feat(ssh-relay): non-interactive 'Set up Subshell here' enrollment over the open session"`.

## Task 15: SPA grants/approvals screens + nav + client

**Files:**
- Modify: `apps/server/web/src/lib/ssh.ts` (+ types/calls), routes + nav; Create `components/ssh/grants-screen.tsx`, `pending-approvals.tsx`
- Test: `apps/server/web/src/components/ssh/__tests__/grants-screen.test.tsx`, `lib/__tests__/ssh.test.ts`

**Interfaces:** Consumes the Eden-treaty client types (rebuild `@internal/backend-client` + `bunx turbo build` first).

- [ ] **Step 1: Failing web tests** (run from `apps/server/web`): grant list/revoke render; an approval card shows requester/destination/roster choices; a >-cap selection shows the red error; the trust card renders owner/edit only.
- [ ] **Step 2: FAIL run.**
- [ ] **Step 3: Implement** the screens + copy (two sentences, role tokens, no em dash), wire nav, redact B's plane-rendered fingerprint label as "for display only."
- [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** `git commit -m "feat(ssh-relay): grants, pending-approvals, and trust screens in the SPA"`.

## Task 16: e2e crown jewel + boundary + PR + review loop

**Files:**
- Create: `e2e/tests/23-ssh-relay.spec.ts`; modify the e2e sshd fixture wiring for a second machine A
- Add: `.changeset/ssh-relay-milestone-2.md`

- [ ] **Step 1: Write the e2e.** A holds the key in its agent, B holds none, B authenticates to D through the plane relay; a plane-side wire capture shows only opaque envelopes + routing ids; the key never appears on B or the plane; a revoke between handshake and D is refused; "Set up Subshell here" enrolls an egressing D without the setup key in B's log.
- [ ] **Step 2: Run it** (`bun run test:e2e` path for this spec, serial regime, `env -u SHELLOPTS -u BASHOPTS`), fix until green (rebuild `@internal/server-web` + `bunx turbo build` first; e2e serves web dist from disk).
- [ ] **Step 3: Boundary verification.** `bunx turbo build`, `bun run verify-types`, `bun run lint:check`, `bun run lint:prose`, `bun run test` all green; add the changeset (major for the branch, list every touched package).
- [ ] **Step 4: PR.** Branch off `feat/ssh-anywhere-3`; `gh pr create` with a body linking the spec and summarizing the six slices; DO NOT merge (operator directive); push via `ssh.github.com:443` if port 22 stalls.
- [ ] **Step 5: Review loop.** Dispatch the whole-branch `code-reviewer` (most capable model), quote-verify every finding, fix all MAJOR+MINOR, re-review until a pass is clean.
- [ ] **Step 6: Commit + push** the changeset and any review fixes; leave merge to the operator.

---

## Self-review notes (author, after writing)

- Spec coverage: §4 identity (T1-T3), §5 runtime (T4-T9), §6 grants/approval (T10-T11), §7 upgrade (T14), §9 data/audit (T1/T10/T12/T13/T14 + `docs/security.md`), §8 UI (T13/T15), §13 tests (each task's TDD + T9/T16). §4.6 detection-only posture needs no prevention code (dashboards only, T13).
- Type/name consistency across tasks: `signingPublicKey` slot (T1) used by T3/T13; `MachinePinStore.check` (T2) used by T5/T6/T7; `SeqGate` (T5) used by T6/T7/T8; `ssh_agent_identities` (T11) feeds T10 approvals; `SSH_MAX_GRANT_FINGERPRINTS` (Global) enforced T10, tested T10/T15.
- No placeholders: caps, version bump, migration numbers, file paths, and the non-obvious crypto/quoting rules are named. Routine handlers cite the file to copy (`set-ssh-enabled.ts`).
