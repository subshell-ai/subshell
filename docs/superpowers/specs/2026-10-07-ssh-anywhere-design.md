# SSH to Any Machine, from Anywhere

Status: design, for review. Dated 2026-10-07.
Branch: `feat/ssh-anywhere`, cut from `origin/main`. This supersedes the approach
on `feat/ssh-support` (PR #330), which is left open and unmerged as a reference
for the brokered-session transport, not as a base.

## 1. Problem and goal

From Subshell I want to open an interactive session against an arbitrary host
over SSH. The host may be an enrolled Subshell node or it may be nothing more
than a box running sshd; it must never be required to run Subshell in order to
be reachable. The SSH identity that authenticates the connection may live on a
different machine than the one that actually dials the host, and in that case
the private key must never leave its home and the control plane must never see
key material or plaintext authentication challenges.

The plain SSH terminal is the primary product. Turning the host into a full
Subshell agent destination is a secondary act layered on the same connection.

## 2. Non-goals

- Not a general-purpose SSH client for terminal use outside Subshell panes.
- Not a secret store: Subshell never custodies, imports, or persists an SSH
  private key.
- Not multi-tenant hardening. Subshell is a single-operator, trusted-network
  service (`docs/security.md` section 0); grants name one operator's machines.
- Not replacing node enrollment. Reachable-by-enrollment and reachable-by-SSH
  are two doors to the same pane machinery.

## 3. Terminology and topology

- **D** the destination: any host with an sshd. Holds no Subshell secret. May or
  may not be an enrolled node.
- **B** the connecting machine: the node or Subshell Client broker that runs the
  `ssh` process and hosts the pane.
- **A** the key home: the machine whose `ssh-agent` holds the key that
  authenticates D. A laptop broker or another node.
- **The plane** the Subshell control plane. Nodes and brokers only ever meet
  each other through it; it is the sole transport between A and B.

A pane is the unit of value: a tmux-backed PTY on the connecting machine,
streamed, shareable, and logged exactly like any other Subshell pane.

## 4. Connection modes

One launcher, two modes, chosen per launch by a key grant (section 5.1).

### 4.1 Jump mode (A is the connecting machine)

A runs `ssh -J B D`. The key and the agent stay on A; B is a network-only jump
that never sees the key; the pane lives on A. This is stock OpenSSH
`ProxyJump`, needs no new crypto, and is plane-blind because no key material or
challenge crosses the plane at all. Use it when the reason to involve B is purely
that B can reach D's network while A cannot, and it is acceptable for the pane to
run on A.

### 4.2 Relay mode (B is the connecting machine)

B runs the pane and the `ssh D` process, and authenticates to D through A's agent
over a sealed agent relay (section 8). The key never leaves A; the plane relays
only sealed sign requests it cannot read; the pane lives on B, on server-grade
compute, and persists after A disconnects. Use it when the session must run and
survive on B (or on D as a Subshell destination) rather than on the laptop.

Relay mode requires A to be online and connected for the duration of the
handshake. That is the accepted price of the key never moving; an offline A is a
clear error, never a silent fallback to copying the key.

## 5. Architecture components

### 5.1 Key grant

An owner-scoped, plane-stored record that says: to reach these destinations, sign
with the agent on machine A. It carries a name, the key-home node id, a
destination selector (an alias, a concrete host, or a host glob matched against the resolved destination hostname as policy, unrelated to the wildcard patterns discovery drops), the pinned host key
for D (section 9), an optional "ask me each time" approval flag, and audit
metadata. It stores no secret and no key bytes. Grants are cheap because the
operator is the only party. Writes are audited in the ssh/nodes family, naming ids
and host only, never any credential.

### 5.2 SSH launcher

A single plane service that composes the `ssh` invocation toward the chosen
connecting machine and mode. It reuses the OpenSSH-based resolution already
specified here: read concrete aliases from `~/.ssh/config`, resolve an alias with
`ssh -G`, and render a per-connection config from the resulting snapshot (see
section 15 for which of these are ported). Every token in the built command is
passed through `shellQuote`; the connection is one shell string through tmux, so
quoting is the load-bearing defense and is never relaxed.

### 5.3 Sealed agent relay (Milestone 2)

The one genuinely new subsystem, and it is encrypted channels carrying the SSH
agent protocol. On B, a local Unix socket speaks the `ssh-agent` wire and is
exported as `SSH_AUTH_SOCK` into the pane's `ssh`; requests arriving on it are
sealed end-to-end to A and shipped through the plane. On A, a responder accepts
only requests the plane brokered for a live grant, checks policy, forwards them to
A's real agent, and seals the signature back. The plane routes by the recipient id
in the envelope header without opening anything. Detail in section 8.

### 5.4 Terminal pane

A launch of the `terminal` harness whose command is the launcher's `ssh`
invocation, on the connecting machine, under the tmux PTY. Streaming, input,
capture, logging, and sharing are the ordinary pane path and need no new code. The
far side needs only sshd.

### 5.5 Agent-destination upgrade

A secondary act on an open session: "Set up Subshell here" boots the Subshell
runtime on D over an authenticated connection using the same key grant and mode.
This is where the brokered-session machinery from #330 becomes relevant, and it is
a consumer of the shared launcher and relay rather than a separate product. It is
out of Milestone 1 scope and revisited in the Milestone 2 spec.

## 6. Phasing

### 6.1 Milestone 1: terminal and jump (the mergeable first slice)

Port the neutral primitives, then ship: SSH-terminal panes to any D regardless of
node status, alias discovery and `ssh -G` resolve, the "connect from" and host
pickers, host-key pinning, Jump mode end to end, and audits. No session-frame
codec, supervisor, or runtime-serve in this milestone. Delivers the whole "SSH
into any machine" goal for every case that does not require the session to run on
B with a key that lives only on A.

### 6.2 Milestone 2: the sealed agent relay (own spec, own review)

Relay mode, the grant/authorization machinery that drives it, and the optional
agent-destination upgrade. A focused security review pass is expected here; it is
the risky core and is deliberately isolated behind a clean seam the M1 launcher
exposes.

## 7. Data model

- `ssh_key_grants`: id, owner, name, key-home node id, destination selector,
  pinned D host key (public), approval flag, created/updated. No secrets.
- Relay session state (M2, in-memory on the plane with a durable audit row): a
  brokered pairing of grant, A, B, the pane/subshell id, an opaque routing ref,
  and a lifetime. The ssh-agent payload (challenge, signature, target host,
  identity) lives only inside sealed envelopes, never in this state.
- Panes reuse the existing `subshells` rows; a connecting-machine-only SSH pane
  is an ordinary row on B (or A in jump mode). Nothing about the key is written
  there.

## 8. Relay protocol and security (M2)

- Sealing and pinning reuse `packages/mcp-core/src/crypto.ts` (`seal`/`open`,
  ECDH-ES+A256KW with A256GCM, plaintext recipient id header for blind routing)
  and `packages/mcp-core/src/pin-store.ts` (TOFU, byte-equality, `peers.json`).
  The envelope the plane stores and routes is the same opaque blob the encrypted
  channels already relay.
- The plane brokers a relay pairing when a grant is used: it tells A to expect
  sealed requests for this pane/host, and B that its agent socket backs onto A. A
  routing id rides in the envelope for plane-side pairing, quota, and lifetime;
  the sensitive agent payload rides inside the ciphertext.
- Origin: to be accepted by A, a request must seal under B's identity key, which
  A has pinned TOFU. The plane holds no machine's private ECDH key, so it cannot
  mint a request A will accept as coming from B. Sealing therefore supplies origin
  authentication, not just confidentiality.
- Scope of signing: the grant pins one key identity so only that key can be used.
  SSH agent signing requests carry no destination, so a grant cannot bind the
  agent to a host at the protocol layer; the residual risk (a compromised B using
  the granted key against other hosts that key can reach) is accepted under the
  single-operator posture and bounded by key-scoping plus instant revoke.
- No forwarding onward: B authenticates to D using A's agent but does not run
  `ssh -A` toward D. A's agent is used for the handshake and is never exposed on
  D, which is strictly safer than stock agent forwarding.
- Handshake-window lifetime: an SSH agent is needed only at connection
  establishment. The relay proxy socket on B is created for the handshake, sealed
  traffic flows for seconds, then the socket is unbound and the relay pairing is
  torn down while the established pane keeps running on its own transport. This is
  the "discard immediately after connecting" intent, achieved without the key ever
  moving. A fresh re-authentication that needs the agent again re-opens the relay,
  requiring A online at that moment.

## 9. Host-key trust

Trust for D follows the key-holder, not the connecting box. When a grant is
created from A, A's trust in D's host key is captured (trust-on-first-use from
A's `~/.ssh/known_hosts`, or an explicit pin) and stored as the grant's pinned
public host key. In relay mode, B's ssh validates D against a rendered
`UserKnownHostsFile` containing that pin with `StrictHostKeyChecking=yes`; B's own
`known_hosts` is not the authority. A changed D host key is a hard block, matching
the pin doctrine elsewhere in the threat model.

## 10. Trust model delta versus section 0

Gained: the plane never holds, sees, or can be shown an SSH private key or a
plaintext sign challenge; compromising the plane cannot exfiltrate a key or forge
a request A will honor; D never receives a forwarded agent.

Unchanged or accepted: the OS-user boundary on A and B is still the operator
(`docs/security.md` section 0); a machine you run the agent on is a machine you
trust. A already-compromised B can drive its granted relay during the handshake.
The plane retains what it always had: denial of service, and metadata (which
machines are talking, timing, sizes). Replacing the plane's identity material
remains the manual operation it is today.

## 11. UI

Primary-first, consistent with the launch pickers already in the codebase
(`SearchableSelect`). One SSH tab whose flow is: pick the connecting machine
("Connect from"), pick the destination host (discovered aliases, or a typed
target), pick the key source when it differs (a grant, defaulting to the
connecting machine's own keys), then open a terminal. "Set up Subshell here" sits
below as the secondary act on the resulting session. Saved destinations and recent
hosts are one-click shortcuts, not the primary read. Shipped copy follows the
design system: role tokens only, at most two sentences, no em dashes.

## 12. Failure modes and UX

- A offline in relay mode: refuse before the handshake, name the remedy (bring
  the key machine online); never copy the key to B.
- No matching key in A's agent: say so and point at loading it; never fall back to
  reading a passphrase-protected file.
- D host key changed since the grant pinned it: hard block, name D.
- Grant names a connecting machine that cannot reach D: a distinct error from "no
  key," so the two causes are not confused.
- Relay expired or A dropped mid-handshake: the connection either completed (pane
  fine) or fails cleanly with a retry that re-opens the relay.
- Quota or policy refusal on A: surfaced as a refusal with the reason, matching
  the equality-mapped refusal convention used elsewhere.

## 13. Security rules honored

- No key material, challenge, or signature content in any log, argv, audit row, or
  notification. Audit rows name ids, hosts, and field names only.
- The agent proxy socket on B is 0600 in a per-session directory; the rendered
  connection config is 0600; transient files are removed with the pane.
- `shellQuote` on every token of the built command; the connection is one tmux
  shell string, and that is never reasoned away.
- Node and broker command transport is the existing authenticated, replay-fenced
  path (`sendCommand`, signed commands, the desktop broker's monotonic fence).
- Static imports only; no dynamic import outside the one sanctioned plugin site.
- Machine-to-machine sealed payloads reuse the channel crypto and TOFU store, not
  a new bespoke cipher.

## 14. Testing

- Unit: alias discovery budgets and wildcard exclusion; `ssh -G` snapshot parsing
  and the forbidden-settings refusal; connection-config render with the pinned
  `UserKnownHostsFile`; the agent-proxy wire framing against a stub agent; grant
  validation; relay envelope seal/open (right recipient opens, wrong id and
  tampering fail); ProxyJump argv construction and quoting.
- Integration: two in-process identities as A and B with a fake plane relay;
  assert a sign request reaches A's stub agent, the response returns sealed, the
  relayed blob is opaque at the plane, an ungranted or wrong-origin request is
  refused, and revoke stops signing mid-session.
- End to end: the sshd fixture reused as D. Jump mode drives a real two-hop
  `ProxyJump` (bastion plus target) with the key on the origin only. Relay mode is
  the crown-jewel test: a second brokered machine as A with the key in its agent,
  a B with no key, and an assertion that B authenticates to D through the plane
  relay while the plane-side capture of the wire shows only ciphertext.
- CI regime per the repo rules: focused files while iterating, the full trio plus
  `lint:prose` at the boundary, and the e2e specs under the existing serial
  container regime.

## 15. Branching and reuse from main

`origin/main` does not contain the ssh-runtime subsystem (discovery, resolve, the
connection-snapshot grammar, the brokered-session supervisor, the ssh-broker, or
the sshd fixture); those live only on `feat/ssh-support`. The E2EE primitives
(`mcp-core` seal/open and the TOFU pin store) are already on main and are used as
is. `feat/ssh-anywhere` therefore re-introduces only the neutral primitives
OpenSSH config discovery, `ssh -G` resolve, and the connection-snapshot grammar,
plus the sshd test fixture, as a small first commit, and deliberately does not
carry the session-frame codec, supervisor, or runtime-serve. `feat/ssh-support`
stays open and unmerged as the reference for the brokered-session transport that
Milestone 2 may revisit.

## 16. Deferred / open items for Milestone 2

- Whether the agent-destination upgrade reuses #330's runtime-session protocol or
  a lighter boot now that the terminal path exists.
- Per-use approval UX on A (a notification or prompt to confirm a handshake),
  versus the default of a standing grant.
- Whether to support A's identity by file (with an on-A passphrase prompt) at all,
  versus requiring the key to be loaded in A's agent.
- Enrolling a relay-only destination as a first-class node automatically after a
  successful "set up Subshell here."

## 17. Success criteria

Milestone 1 is done when, from the web app and the Client, an operator opens an
interactive pane against an arbitrary sshd-only host, using either the connecting
machine's own keys or a jump through a second machine, sees it stream and accept
input like any pane, and no private key or plaintext challenge ever appears on the
plane or the destination. Milestone 2 is done when the same pane can run on a
machine that has no key at all, authenticating through a machine that does, with a
CI test proving the plane sees only ciphertext and the key never leaves its home.
