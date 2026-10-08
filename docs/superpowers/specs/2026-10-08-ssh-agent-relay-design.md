# SSH sealed agent relay (Milestone 2) design

**Status:** approved design, pre-plan.
**Date:** 2026-10-08.
**Parent:** [`2026-10-07-ssh-anywhere-design.md`](./2026-10-07-ssh-anywhere-design.md). This spec is Milestone 2 of that program and does not restate mechanics the parent already fixes. Where they agree on a detail (the §8 relay protocol, §9 host-key doctrine, §12 failure convention, §13 security rules, §14 M2 test list), this file is the elaboration and the parent is the summary; where this file resolves a parent §16 open item, this file governs.
**Milestone 1** (terminal + jump, PRs #334/#336/#337 on `feat/ssh-anywhere-1/2/3`) is the base. This work builds on the seam its launcher exposes and is its own spec and its own security review.

## 1. Goal and scope

Milestone 2 delivers relay mode: an interactive SSH pane that runs on a connecting machine **B** which holds no signing key, authenticating to an arbitrary sshd-only destination **D** through the ssh-agent of a different machine **A** that does, over a shuttle the plane routes but cannot read. It also delivers the two things relay mode needs to be operable (the machine-identity roster and the key grants) and the one act that turns a successful relay destination into a first-class node ("Set up Subshell here").

Milestone 2 is done when the parent's §17 sentence for M2 holds: the same pane runs on a machine with no key at all, authenticating through a machine that does, with a CI test proving the plane sees only opaque envelopes and the key never leaves its home.

**In scope:** the per-machine signing identity and its enrollment/bootstrap; the node-side machine pin store; the sealed agent relay (proxy on B, responder on A, broker and blind router on the plane); the method allow-list and identity scoping; `ssh_key_grants` and the first-use approval that creates them; the M2 host-key pin path (`ssh_host_pins`); the destination upgrade; grants/trust UI; audits; the tests in §14.

**Out of scope (unchanged from the parent §2):** a general SSH-protocol proxy, X11/agent forwarding toward D, port forwarding, key custody or copying of any kind, multi-operator separation of duties, and any change to the OS-user trust boundary. A `ProxyCommand`-based hop is refused at resolve exactly as in M1; relay is not a way to reintroduce it.

## 2. Terminology (adds to the parent §3)

- **A / key home:** the machine whose ssh-agent signs. Must have `ssh_enabled` on (§4.3 parent) and be online for the handshake window.
- **B / connecting machine:** the machine that runs the pane and the `ssh D` process, and holds no key. `ssh_enabled` on.
- **D / destination:** any sshd. Not gated; dialed to.
- **Signing identity:** the per-machine ES256 keypair introduced here. Distinct from the encryption identity (ECDH-ES) that already lives in `apps/node/agent/src/identity.ts` and from the plane-held ES256 command keypair in `control-keys.ts`.
- **Machine pin:** a byte-equality pin of a peer's signing public key, held in the node-side machine pin store (new), never in the channels' `peers.json`.
- **Relay session:** a bounded plane-brokered pairing of (grant, A, B, pane/subshell id, opaque routing ref, lifetime).

## 3. The five open items, decided

These close the parent §16 list. Each is elaborated in its section.

1. **Machine-identity bootstrap** (§4): the signing keypair is minted and registered at **enroll**, so relay trust anchors on the enroll event rather than a fresh plane-mediated first-use. A machine trust card carries the fingerprint confirmation.
2. **Destination upgrade** (§7): reuse ordinary enrollment over the open session. No #330 runtime-session re-port.
3. **Per-use approval on A** (§6): a first-use prompt creates a standing grant; later uses under that grant are silent. The approval flag ships as the act of grant creation, not a separate toggle.
4. **A's identity source** (§5.4): agent-only. A's identity files on disk are never read or served; a key becomes usable remotely only once loaded in A's agent.
5. **Relay-only destination auto-enroll** (§7): collapses into the destination upgrade. Enrollment creates the node row; "Set up Subshell here" wires mint-key to run-enroll to the node appearing.

## 4. Machine identity and pin store

### 4.1 A per-machine signing keypair

`identity.ts` today generates and holds only the ECDH-ES encryption keypair; the ES256 keypair that signs node commands is plane-held (`control-keys.ts`), so no per-machine signing key exists. M2 adds one: the node generates an ES256 keypair at the same moment and to the same posture as the encryption pair (0600 in the node data dir, private half never leaves the machine, regenerated only by explicit re-enroll or key rotation). It signs the relay payloads of §5.6; it is not a command-signing key and never authorizes a plane command on its own.

### 4.2 Register at enroll

The enroll route already carries the node's ECDH-ES public key into the identities store under the `node:<id>` principal. It now also carries the signing public key, over the same setup-key-authenticated request. The identities store (or its `node:` record) gains a signing-key slot beside the encryption slot. Because enroll is gated by a single-use, 24 h, operator-minted setup key, the signing key inherits that event's trust: it is bound to the moment an operator deliberately attached the machine.

### 4.3 Bootstrap for pre-M2 nodes

Nodes enrolled before M2 hold a signing keypair after the agent upgrades but have never reported its public key. A new signed command (`ssh_register_identity`) delivers the signing public key once over the already-authenticated, app-layer-encrypted node link, and the plane stores it in the same slot. This is exactly the transport the parent §5.3 requires ("the peer's JWK must be delivered to it inside a signed command on the existing node link"), reused for the node's own key at first contact. Delivery is idempotent: a node that has already reported re-reports the same bytes and the store is unchanged; a node that reports a different key than one on file hits the §4.5 changed-key block rather than silently overwriting.

### 4.4 The node-side machine pin store

A relay is always pin-strict. A holds the peer signing keys it will verify against in a **new** node-side store, a distinct file from the pane-side channels `peers.json`, with its own reader that never consults `SUBSHELL_CHANNEL_PIN`. When A first needs to verify B (or B to verify A), the plane brokers the pairing and delivers the peer's signing public key inside the relay-open command; the verifying machine writes it to the machine pin store and thereafter enforces byte equality, mirroring `pin-store.ts`'s TOFU rule for the *comparison* only, never its escape hatch. A changed peer signing key is a hard block that names the peer machine and points at the recovery act of §4.5.

### 4.5 Pin display and recovery

The security rule the parent flags ("there is no operator-visible machine pin display or recovery flow") is closed by a **machine trust card** (§8.3): for every machine this one has pinned, and for this machine's own registered signing key, the UI shows a short fingerprint. Recovery from a genuinely rotated peer key (or a re-enrolled machine) is an explicit "re-pair" act that replaces the stored pin after a fresh enroll-time-anchored delivery; it is owner-only and audited. There is no "trust anyway" escape and no reuse of the channel escape.

### 4.6 What this narrows, honestly

The parent §10 says the load-bearing word is "after": a plane compromised before A first pinned B can substitute its own key. Anchoring the signing key to enroll moves that boundary. The key an operator sees on the trust card is bound to the enroll event that only the setup key could create, so a plane compromised **after** any machine enrolled cannot swap it without tripping the byte-equality block. The residual window is a plane compromised **before B enrolled**, which is `docs/security.md` §0's accepted, not-defended control-plane-compromise boundary, not a new hole. The trust-card fingerprint is the optional out-of-band confirmation that lets the operator close even that by comparing the two machines' fingerprints directly; it is offered, not mandatory, so first use stays one approval (§6) rather than a copy-the-fingerprint ceremony.

## 5. Relay runtime

The protocol in the parent §8 is unchanged and governs; this section pins the pieces and the one new transport decision.

### 5.1 Transport: node-link relay frames

The sealed envelopes ride the `/ws/node` link, not the browser-facing `/api/channels` path. The reason is hard-wired in the parent §5.3: the node daemon holds no REST credential, so it cannot post to a channel; the node link is its only authenticated, encrypted, low-latency transport, and it is already app-layer encrypted (protocol 14) and authenticated by the node key. It also fits the traffic shape: the agent exchange is bidirectional (B to A requests, A to B responses) and bursty over a few seconds, which the one-shot plane-to-node command/reply model serves poorly and a channel log serves only by persisting traffic it should not keep.

Concretely: the plane sends A and B each one signed command to **open** a relay session (carrying the routing ref, the peer's signing public key to pin, and the lifetime). After that, a new lightweight frame type on the open link carries sealed blobs both ways, keyed by the routing ref. These frames add no per-message command signing: the link already authenticates the machine, and origin comes from the inner ES256 signature (§5.6), so signing every frame would be redundant overhead on a stream. The plane matches the two links by routing ref and forwards the opaque blob without opening it. **Open**, **route**, and **close** are the plane's only roles in the payload's life.

Because this adds a link frame type, it rides the `NODE_PROTOCOL_VERSION` bump already required for `ssh_enabled` (parent §4.3). The relay frames and the gate flip in one version.

### 5.2 B: the agent proxy socket

On B the launcher exports a scoped `SSH_AUTH_SOCK` (the parent §5.4 exception, into the `ssh` invocation only) pointing at a Unix socket B's node creates in a per-session directory, mode 0600, alongside the rendered connection config. The socket speaks the ssh-agent wire locally. Each request is framed, sealed to A, and handed to the plane as a relay frame; each reply is opened and written back to the socket. The socket is created for the handshake window and torn down when it ends; the established pane then needs no agent (parent §8, rekey re-verifies the host key, not the agent).

### 5.3 Plane: the broker

The plane brokers a pairing only when a live grant is used (§6). In-memory it holds the relay session (grant id, A, B, pane/subshell id, routing ref, expiry) plus a quota; durable it writes only audit rows (§9). It never holds the agent payload; the payload lives solely inside sealed envelopes it shuttles. Teardown fires on handshake completion, on lifetime expiry, on A dropping, and on grant revoke.

### 5.4 A: the responder

On A a responder accepts only requests the plane brokered for a live grant, for a session naming this A. It enforces the parent §8 method allow-list: forward `SSH_AGENTC_REQUEST_IDENTITIES` and the sign/authenticate requests OpenSSH needs; refuse `ADD_IDENTITY`, `REMOVE_IDENTITY`, `LOCK`/`UNLOCK`, and extension requests, so a granted window cannot mutate or lock A's agent against its other panes. `REQUEST_IDENTITIES` is answered with A's agent keys **filtered to the identity refs the resolved destination snapshot names** (bounded by `SSH_MAX_IDENTITY_REFS`), never A's whole list.

**Agent-only (§3.4):** the responder talks to A's running agent socket and nothing else. A private key that exists as a file but is not loaded in the agent is simply absent from the filtered roster; the handshake fails as "no matching key in A's agent" (parent §12), which points at loading it and never reads the file. This keeps key bytes off both the wire and A's disk reads by Subshell.

### 5.5 Plane blindness, restated for the record

The envelope format is `packages/mcp-core/src/crypto.ts` `seal`/`open` (ephemeral-static ECDH-ES+A256KW, A256GCM, plaintext recipient-id header for blind routing). The plane reads the routing ref to pair and nothing else. A wire capture at the plane during the §10 crown-jewel test shows opaque envelopes and plaintext routing ids only.

### 5.6 Origin, replay, and lifetime

Confidentiality is not authenticity: anyone holding A's public key, the plane included, could craft a seal A opens. Origin therefore rides a signature, not the seal: the sender signs the inner payload with its machine signing key; the receiver verifies against its **machine pin** of the sender (§4.4), the ES256 JWS precedent from node command signing, the signature living inside the sealed envelope so the plane never sees it. Signatures run both directions and the relay-session nonce is bound into both, so a captured envelope is inert on replay even though the plane stores envelopes. Lifetime, the method allow-list, and "no forwarding toward D" are exactly the parent §8 last three bullets and are not relaxed here.

## 6. Grants and the first-use approval

### 6.1 The grant record

`ssh_key_grants` (parent §7): id, owner, name, key-home node id (A), destination selector (an alias, a concrete host, or a host glob matched against the resolved destination hostname as policy only, unrelated to discovery's wildcards). No secret, no key bytes. Host-key pins are **not** part of a grant; they are per resolved `user@host:port` (§7 of the parent, `ssh_host_pins`), so one selector covering many hosts yields many pins.

### 6.2 First use creates the grant

The first time a launch would route through a `(A, B, destination)` combination with no standing grant, A's operator receives one approval naming the requester, the key home, and the destination, through the existing notification/confirm surface. Approving writes the grant and proceeds; refusing aborts with a loud, named refusal (parent §12 convention). Subsequent uses under a matching grant are silent. The approval is the creation gesture; there is no separate per-grant "ask each time" flag shipped in M2, because the first-use prompt already carries that role and the residual scope risk is bounded the same way the parent §8 already bounds it (agent sign requests carry no destination, so a grant cannot bind the agent to a host at the protocol layer; that residual is accepted under the single-operator posture and bounded by serving only snapshot-named identities plus instant revoke).

### 6.3 Management and revoke

A grants screen (owner-scoped) lists, edits the selector/name, and revokes grants. Revocation is instant and cuts both ways: the plane row goes, and a live relay session using it is torn down so signing stops mid-session. A can also kill a session from its own trust surface. Creation via the screen and via first use write the same row and the same audit event.

## 7. Destination upgrade: "Set up Subshell here"

A secondary act inside an open SSH-terminal pane on D. It does not re-port #330's brokered runtime session. It reuses ordinary enrollment: the plane mints a setup key (existing route) and the act drives the standard `install.sh` enrollment from D over the already-open authenticated session, so D dials the plane and becomes an ordinary enrolled node, exactly as if the operator had run the one-liner by hand. The relay/launcher is the consumer that carries the command; it is not a new product surface.

Consequences the parent §16 asked about, now fixed: a relay-only destination becomes a first-class node **by enrolling**, because that is the only way the node row is ever created; and the "lighter boot" question is moot because there is no bespoke runtime-session protocol in play. If D cannot reach the plane (no egress on D's network back to the plane URL), the act refuses cleanly with that named cause, distinct from any key error, and the working pane is unaffected.

## 8. UI (adds to the parent §11)

- The destination-first flow is unchanged. Its step-2 follow-up "sign with [machine]'s keys" now resolves to a relay: pick A as the key home, and the grant/approval path (§6) applies.
- **Grants screen:** list/create/edit/revoke, owner-scoped, under the SSH settings area. Normal creation is the first-use prompt; the screen manages and hand-adds.
- **Machine trust card:** this machine's own signing fingerprint, and every peer signing key it has pinned, each with a short fingerprint and a re-pair act (§4.5). Surfaced on the node detail so the operator can confirm out-of-band.
- **Host-key display:** destination pins visible with the changed-key block surfaced when a connect is refused on a byte mismatch.
- **"Set up Subshell here":** an act in the SSH-terminal pane, not a landing-screen mode (parent §11 keeps the destination-first landing intact).

Copy follows the design system: role tokens only, at most two sentences per explanation, no em dashes.

## 9. Data model, config, and audits (adds to parent §7, §10)

**Schema.** A signing public key per node (a `nodes` column or an identities-store `node:` slot). `ssh_key_grants` and `ssh_host_pins` tables (M2 rows from parent §7; both ship in M2). Relay session state is in-memory on the plane with a durable audit row, no table. Node-side: the machine pin store file (§4.4), separate from `peers.json`. The `ssh_enabled` column and its mirror ship in M1.

**New audit event names**, to add to `docs/security.md` §10, naming ids/hosts/field-names only, never payload, challenge, or signature:

- `node.ssh_identity.register` (enroll-time signing key registration; and the pre-M2 link delivery, distinguished by a `via` field).
- `node.ssh_grant.create|update|delete`.
- `node.ssh_relay.open|close` (open names grant/A/B/pane and the routing ref; close names the reason).
- `node.ssh_host_pin.create|rotate|delete`.

The relay pairing metadata the plane already holds (which machines talk, timing, sizes, routing ids) is disclosed by §10 of the parent as retained, not new.

## 10. Trust model delta (refines parent §10)

Gained, as the parent states, plus two specifics from these decisions: the plane never reads an agent payload (blind routing over its own link), and a plane compromised after any relevant enroll cannot forge a request A honors, because the signing key is enroll-anchored and byte-equality pinned. The §4.6 boundary is the only residual, and it equals §0's not-defended control-plane-compromise risk. Agent-only (§5.4) removes a whole class of exposure: no identity file is ever read by Subshell, no passphrase prompt lives on A, no key file transits. Revoke cuts a live session. A compromised B during its own granted window is still bounded by the allow-list and identity scoping (parent §10), unchanged.

## 11. Failure modes (parent §12, plus M2-specific)

Everything in parent §12 stands (A offline before handshake, no matching key, changed host key, no-reach vs no-key, relay expiry mid-handshake, loud quota/policy refusal). Add:

- **No signing key on a node** (a pre-M2 node that has not yet delivered, or a corrupt store): name the machine and offer the register/refresh act; never proceed unsigned.
- **Peer signing key changed** since pinning: hard block naming the peer, pointing at re-pair (§4.5).
- **D cannot reach the plane during "Set up Subshell here":** a clean refusal naming egress, the working pane untouched.
- **Relay frame on a pre-bump agent:** the exact-match `NODE_PROTOCOL_VERSION` gate refuses pairing before any relay command, naming the version remedy (upgrade the agent), never silently half-relaying.

## 12. Security rules honored (parent §13, restated where M2 leans on them)

No key/challenge/signature in any log, argv, audit row, or notification. `SSH_AUTH_SOCK` scoped to the ssh invocation only; the agent proxy socket and rendered config 0600 in a per-session dir, removed with the pane. `shellQuote` on every built-command token. Node command/link transport unchanged in trust: relay open/close are signed commands, relay frames ride the authenticated, encrypted link, origin is the inner ES256 signature. Machine-to-machine payloads reuse `mcp-core` seal/open and the TOFU byte-equality rule in the separate always-strict machine store, not a bespoke cipher, and never honor `SUBSHELL_CHANNEL_PIN`. The method allow-list and identity scoping bound a granted window. Static imports only. An agent-capable SSH pane stays view-only to sharees (parent §5.4). Outbound SSH stays gated per node, default-off, fail-closed.

## 13. Testing

The parent §14 M2 list is required and is not repeated here. Add coverage for the decisions:

- **Units.** Enroll registers the signing pubkey alongside the encryption pubkey; `ssh_register_identity` pre-M2 delivery is idempotent and a mismatched key trips the block. The machine pin store is byte-equality strict, is a separate file from `peers.json`, and ignores `SUBSHELL_CHANNEL_PIN`; first pin then change is a block naming the peer. Grant CRUD and selector matching (alias / concrete host / glob-as-policy); first-use prompt creates the grant and a second use is silent; revoke stops signing mid-session. Agent-only filter: an identity file present on A but not in A's agent is refused with "no matching key," and A's agent roster is filtered to the snapshot-named refs. Relay frame codec round-trips and the protocol bump gates a pre-bump agent. Host-pin render into `UserKnownHostsFile` with `StrictHostKeyChecking=yes`; a mismatched pin blocks and names D.
- **Integration.** Two in-process machine identities A and B over a fake plane broker: a sign request reaches A's stub agent and returns sealed; a non-allow-listed agent method (e.g. `ADD_IDENTITY`) is refused at the responder; an ungranted or wrong-origin request is refused; a relayed blob is byte-opaque at the fake plane; replay of a captured envelope inside the window is inert.
- **End to end (the crown jewel).** The parent §14 M2 e2e verbatim: A with the key in its agent, B with none, B authenticates to D through the plane relay; the plane-side wire capture shows only opaque envelopes plus plaintext routing ids; the key never appears on B or the plane. Extend it to assert a grant revoke between handshake and D is refused, and "Set up Subshell here" turns D into an enrolled node over an egressing D.
- **CI regime** per `verification.md`: focused files while iterating, full trio plus `lint:prose` at the boundary, e2e under the serial container, `env -u SHELLOPTS -u BASHOPTS` for shell-spawning suites, never the live `:3080`, never run the M2 migration against a live DB.

## 14. Branching, phasing, and review

This is its own branch (`feat/ssh-anywhere-m2`) off the M1 top (`feat/ssh-anywhere-3`), its own PR, and, per the parent §6.2, an expected focused security review pass; review-until-clean over the whole branch before any merge consideration. M1 remains unmerged at the operator's direction; when M1 lands, this branch rebases onto it. It is deliberately isolated behind the launcher seam M1 exposes, so the relay can be turned off without disturbing M1's direct and jump paths.

**Likely task slices (for the implementation plan, not yet a plan):**

1. **Protocol + node identity:** signing keypair generation, enroll registration, `ssh_register_identity` link delivery, identities-store slot, `NODE_PROTOCOL_VERSION` bump + relay frame types + validators + census, node-side machine pin store + strictness.
2. **Relay runtime:** plane broker (open/route/close, lifetime, quota, blind), A responder (origin verify, allow-list, identity filter), B agent proxy socket + framing + seal/open, nonce/replay.
3. **Grants + approval + audit:** `ssh_key_grants` table/repo/routes, first-use approval flow, grants screen, the new `docs/security.md` §10 event names.
4. **Host-pin M2 path:** `ssh_host_pins` capture at grant creation, `UserKnownHostsFile` render, changed-key block, trust card + re-pair.
5. **Destination upgrade:** "Set up Subshell here" minting a key and driving enrollment over the open session, egress refusal, node appears.
6. **Crown-jewel e2e + boundary + review loop.**

## 15. Non-goals and accepted risks (carry-forward, do not "fix")

Single-operator posture unchanged. The plane retains denial-of-service and metadata (parent §10). The §4.6 pre-enroll window equals the accepted control-plane-compromise boundary. B cannot be bound to a host at the agent-protocol layer, so a grant bounds exposure by identity-scoping and instant revoke rather than host binding. The agent proxy is transient and never forwarded toward D. There is no key custody, no key file read, no passphrase handling. Relay needs A online for the handshake; an offline A is a clear error, never a copy-the-key fallback.
