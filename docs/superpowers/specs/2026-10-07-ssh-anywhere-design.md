# SSH to Any Machine, from Anywhere

Status: design, for review. Dated 2026-10-07.
Branch: `feat/ssh-anywhere`, cut from `origin/main`. This supersedes the approach
on `feat/ssh-support` (PR #330), left open and unmerged as a reference for the
brokered-session transport, not as a base. It also supersedes the prior
`SSH-SUPPORT.md` contract (runtime-on-destination, keys only ever local), now
removed: terminal to any host, runtime as an optional upgrade, cross-machine keys
via a sealed relay is the direction.

## 1. Problem and goal

From Subshell I want to open an interactive session against an arbitrary host over
SSH. The host may be an enrolled node or just a box running sshd; it must never be
required to run Subshell to be reachable. The SSH identity may live on a different
machine than the one dialing the host; in that case the private key must never
leave its home and the control plane must never see key material or plaintext
authentication challenges.

The plain SSH terminal is the primary product. Turning the host into a full
Subshell agent destination is a secondary act on the same connection.

## 2. Non-goals

- Not a general-purpose SSH client for terminal use outside Subshell panes.
- Not a secret store: Subshell never custodies, imports, or persists an SSH
  private key.
- Not multi-tenant hardening. Subshell is a single-operator, trusted-network
  service (`docs/security.md` section 0); every machine involved is the operator's.
- Not replacing node enrollment. Reachable-by-enrollment and reachable-by-SSH are
  two doors to the same pane machinery.

## 3. Terminology and topology

- **D** the destination: any host with an sshd. Holds no Subshell secret. May or
  may not be an enrolled node.
- **B** the connecting machine: a node (a machine running the Subshell node agent,
  which is how a laptop participates) that runs the `ssh` process and hosts the
  pane.
- **A** the key home: the machine whose `ssh-agent` holds the key authenticating
  D. Often B itself; sometimes a different node.
- **J** a jump hop: an intermediate host that `ssh -J` tunnels through.
- **The plane** the Subshell control plane. Nodes only ever meet each other through
  it for Subshell traffic; raw ssh between a node and a host is direct and does not
  route through the plane.

A pane is the unit of value: a tmux-backed PTY on the connecting machine, streamed,
shareable, and logged like any other Subshell pane (section 5.4 states the sharing
caveat when that pane's ssh can drive an agent).

## 4. Connection modes

One launcher, three arrangements, chosen by where the signing key lives and how it
reaches D. **Direct**: the connecting machine B holds the key and `ssh` runs there, with no hop.
**Jump** (section 4.1): the origin A holds the key and dials out through a hop, pane
on A. **Relay** (section 4.2, M2): the pane is on B but the key is on a different
machine A, reached over a sealed shuttle. In Milestone 1 the key source is always the
connecting machine itself, so relay and the grants that drive it (section 5.1) are
out of scope; direct and jump are the M1 arrangements.

### 4.1 Jump mode (A is the connecting machine)

A runs `ssh -J <hop> D`. The key and agent stay on A; the hop is a network-only
relay that never sees the key; the pane lives on A. This is stock OpenSSH
`ProxyJump`, needs no new crypto, and is plane-blind because no key material or
challenge crosses the plane. Use it when the only reason to involve the hop is that
it can reach D's network while A cannot, and it is acceptable for the pane to run
on A.

### 4.2 Relay mode (B is the connecting machine)

B runs the pane and the `ssh D` process and authenticates to D through A's agent
over a sealed agent relay (section 8). The key never leaves A; the plane relays only
sealed requests it cannot read; the pane lives on B, on server-grade compute, and
persists after A disconnects. Use it when the session must run and survive on B, or
on D as a Subshell destination, rather than on the laptop.

Relay mode requires A online and connected for the duration of the handshake. That
is the accepted price of the key never moving; an offline A is a clear error, never
a silent fallback to copying the key.

### 4.3 Node SSH capability gate

A machine's participation in Subshell SSH at all (dialing out over SSH, or serving
its key/agent) is opt-in per node and **off by default, including the `local`
server node**. The node carries one owner-controlled flag (admin on `local`),
`ssh_enabled`; a node with it off refuses every SSH role. Turning it on is a real
widening of that machine's egress and key exposure, so the gate fails **closed**: a
node that cannot read its own setting refuses, the opposite of the directory
allowlist's deliberate fail-open, because here the risk is what enabling lets
Subshell do.

The flag is plane-authored; there is no node self-toggle CLI, so the node caches
the plane's value only to fail closed (no two-writer reconcile, unlike
maintenance, which the node can also set). Enabling is owner-only (admin on
`local`), audited. When a user needs a machine whose flag is off, the launch is
refused with the remedy named in copy: ask the owner of that machine to enable SSH
on it. The gate is per role: relay mode needs both the connecting machine (dials
out) and the key home (whose agent signs) enabled; jump mode needs only the origin
A (which dials out and serves its key) enabled; a jump hop `J` and the destination
`D` are dialed-to, not gated. Only the owner (admin on `local`) of an enabled machine may route SSH
through it (mirrors `nodeCanSsh`, which carries the same local-admin exception
`nodeCanManageFor` applies); an `edit` grantee of someone else's enabled node
is not thereby allowed to use that machine's egress or keys.

## 5. Architecture components

### 5.1 Key grant (M2)

An owner-scoped, plane-stored record (an M2 concept; M1 needs none because the key
source is always the connecting machine): to reach destinations matching a
selector, sign with the agent on machine A. It carries a name, the key-home node
id, and a destination selector (an alias, a concrete host, or a host glob matched
against the resolved destination hostname, as policy only, unrelated to the
wildcard patterns discovery drops). It stores no secret and no key bytes. Host-key
pins are NOT part of a grant: they are stored per resolved destination
`user@host:port` (section 9), so a selector naming many hosts has many pins, never
one. An "ask me each time" approval flag is deferred with the section 16 approval UX
and stored only once that design lands. Writes are audited as
`node.ssh_grant.create|update|delete` (new names to add to `docs/security.md`
section 10), naming ids and host only, never any credential.

### 5.2 SSH launcher

A single plane service that composes the `ssh` invocation toward the chosen
connecting machine and mode. It reuses the OpenSSH-based resolution already
specified: read concrete aliases from `~/.ssh/config`, resolve an alias with
`ssh -G`, and render a per-connection config from the resulting snapshot (section
15 states which are ported). Discovery and resolve run ON the connecting machine
via `sendCommand` (the signed, replay-fenced node command transport, present on
`main`); alias resolution is a user-initiated action, never run during discovery.
Every token in the built command is passed through `shellQuote`; the connection is
one shell string through tmux, so quoting is the load-bearing defense and is never
relaxed. The built `ssh` runs against the rendered snapshot config via `-F` only,
never the connecting machine's live `~/.ssh/config`: `~/.ssh/config` is
discovery/resolve input only, so settings the session policy forbids (ForwardAgent,
remote/local forwards, ProxyCommand) cannot reappear at connect time.

### 5.3 Sealed agent relay (Milestone 2)

The one genuinely new subsystem: encrypted channels carrying the SSH agent
protocol. On B, a local Unix socket speaks the `ssh-agent` wire and is exported as
`SSH_AUTH_SOCK` into the pane's `ssh`; requests arriving on it are sealed
end-to-end to A and shipped through the plane. On A, a responder accepts only
requests the plane brokered for a live grant, enforces the agent method allow-list
(section 8), forwards permitted requests to A's real agent, and seals the response
back. The plane routes by the recipient id in the envelope header without opening
anything. Detail in section 8.

This is not "the primitives used as is." It needs a machine-to-machine identity
roster and a TOFU pin flow that do not fully exist today: nodes already hold a
registration ECDH-ES keypair (`apps/node/agent/src/identity.ts`, private half never
leaves the machine) and an identities store keyed by principal exists, but a node is
not registered there as a readable principal and there is no client-visible read path
or machine-to-machine TOFU pin flow. Building that (a `node:<id>` identity, a read
path, and first-use pinning, and deciding whether the relay obeys
`SUBSHELL_CHANNEL_PIN` or is always strict) is part of the M2 work. It must also
mint and hold a per-machine ES256 signing keypair: `identity.ts` today holds only
the ECDH-ES encryption half, and the ES256 command keypair (`control-keys.ts`) is
plane-held, so the signing key the relay's origin proof (section 8) needs does not
exist per-machine yet.

### 5.4 Terminal pane

A launch of the `terminal` harness whose command is the launcher's `ssh`
invocation, on the connecting machine, under the tmux PTY. Streaming, input,
capture, logging, and sharing are the ordinary pane path. The far side needs only
sshd.

To use the connecting machine's own agent, the launcher must pass `SSH_AUTH_SOCK`
into the ssh process: the pane env allowlist (`pane-runtime/src/launch.ts`
`curatedEnv`: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`,
`LC_ALL`, plus `CLAUDE_PATH`) deliberately omits it, so this is a scoped exception
applied to the `ssh` invocation only, not the whole pane env. In relay mode the
socket is B's proxy, not A's real agent.

Sharing caveat: a pane whose ssh can drive an agent must not be handed to a viewer
who can type into it, since typing `ssh <elsewhere>` from that shell would use the
agent. So an SSH-terminal pane is **view-only to sharees** (input requires the
owner); an explicit "this pane can sign" affordance is a possible M2 refinement.

### 5.5 Agent-destination upgrade

A secondary act on an open session: "Set up Subshell here" boots the Subshell
runtime on D over an authenticated connection using the same launcher and key
source. This is where the brokered-session machinery from #330 becomes relevant, as
a consumer of the shared launcher rather than a separate product. Out of Milestone 1
scope; revisited in the Milestone 2 spec.

## 6. Phasing

### 6.1 Milestone 1: terminal and jump (the mergeable first slice)

Port the neutral primitives, then ship: SSH-terminal panes to any D regardless of
node status; alias discovery and `ssh -G` resolve; the destination-first launch
flow (section 11); destination host-key trust via the connecting machine's own
`~/.ssh/known_hosts` (stock OpenSSH `StrictHostKeyChecking`; the cross-box pinning
captured at grant creation (section 9) is M2); Jump mode end to end; the per-node SSH
capability gate (section 4.3, off by default including `local`, owner-enabled,
fail-closed, audited); and audits. No session-frame codec, supervisor, or
runtime-serve in this milestone. Delivers "SSH into any machine" for every case
that does not require the session to run on B with a key that lives only on A.

### 6.2 Milestone 2: the sealed agent relay (own spec, own review)

Relay mode, the grant/authorization machinery and machine-identity roster that
drive it, and the optional agent-destination upgrade. A focused security review
pass is expected here; it is the risky core and is deliberately isolated behind a
clean seam the M1 launcher exposes.

## 7. Data model

- `ssh_enabled` (default `false`, including `local`): the per-node capability gate
  of section 4.3. Plane-authored row value, cached in a node-side mirror file the
  node reads only to fail closed; owner/admin to change; audited as
  `node.ssh_enabled`. Not a new table (a column on `nodes`).
- `ssh_saved_hosts` (M1): per owner, keyed by the resolved canonical destination
  `user@host:port` (display alias separate), with the connecting box used and
  last-connect; recent hosts derive from connects. Also stores the user's default
  connecting machine; with none set the UI prompts rather than silently choosing.
- `ssh_key_grants` (M2): id, owner, name, key-home node id, destination selector.
  No secrets, no keys.
- `ssh_host_pins` (M2): keyed by resolved destination `user@host:port`, the pinned
  public host key. One pin per resolved destination, independent of grants.
- Relay session state (M2, in-memory on the plane with a durable audit row): a
  brokered pairing of grant, A, B, the pane/subshell id, an opaque routing ref, and
  a lifetime. The agent payload (challenge, signature, and which of A's keys within
  the filtered identity list; there is no destination field in an agent sign
  request) lives only inside sealed envelopes, never in this state.
- Panes reuse the existing `subshells` rows; a connecting-machine-only SSH pane is
  an ordinary row on B (or A in jump mode). Nothing about the key is written there.

## 8. Relay protocol and security (M2)

- Sealing and pinning reuse `packages/mcp-core/src/crypto.ts` (`seal`/`open`,
  ECDH-ES+A256KW with A256GCM, plaintext recipient id header for blind routing) and
  `packages/mcp-core/src/pin-store.ts` (TOFU, byte-equality, `peers.json`). The
  envelope the plane stores and routes is the same opaque blob the encrypted
  channels already relay.
- The plane brokers a relay pairing when a grant is used: it tells A to expect
  sealed requests for this pane, and B that its agent socket backs onto A. A routing
  id rides in the envelope header for plane-side pairing, quota, and lifetime; the
  agent payload rides inside the ciphertext.
- Agent method allow-list: the responder forwards only `REQUEST_IDENTITIES` and the
  sign/authenticate methods OpenSSH needs. It refuses `ADD_IDENTITY`,
  `REMOVE_IDENTITY`, `LOCK`/`UNLOCK`, and extension requests, so a granted handshake
  window cannot mutate or lock A's agent against its other panes.
  `REQUEST_IDENTITIES` is answered with A's keys filtered to the identity files the
  resolved connection snapshot names for that destination (bounded by
  `SSH_MAX_IDENTITY_REFS`), not A's whole list.
- Replay posture: because the plane stores envelopes, a byte-identical envelope
  could be resent within the handshake window; a nonce/freshness inside the
  ciphertext, bound to the relay session, makes such replays inert.
- Origin: sealing supplies confidentiality only. The reused primitive (`crypto.ts`)
  is ephemeral-static ECDH-ES+A256KW: the sender contributes a per-message throwaway
  key and only the recipient's static key is used, so a seal to A authenticates no
  one. Anyone holding A's public key, including the plane that registered it, could
  craft an envelope A opens. Origin therefore comes from a SIGNATURE: B signs the
  inner payload with its machine key and A verifies against B's pinned key (the ES256
  JWS precedent from node command signing); the signature rides inside the sealed
  envelope, which hides the payload from the plane. A's own TOFU pin of B's signing
  key is the authorizer, not the plane that brokers the pairing. Signatures run both
  ways (A signs its responses back, B verifies against its pin of A), and the
  relay-session nonce is bound into both directions, so a captured envelope is inert
  on replay. This rests on the
  machine-identity roster and pin flow of section 5.3 and the pin-establishment
  window of section 10.
- Scope of signing: SSH agent sign requests carry no destination, so a grant cannot
  bind the agent to a host at the protocol layer; the residual risk (a compromised B
  using the granted key against other hosts that key can reach) is accepted under
  the single-operator posture and bounded by serving only the snapshot-named
  identities plus instant revoke.
- No forwarding onward: B authenticates to D using A's agent but does not run
  `ssh -A` toward D. A's agent is used for the handshake and is never exposed on D,
  strictly safer than stock agent forwarding.
- Handshake-window lifetime: an SSH agent is needed only at connection
  establishment (rekeying re-verifies the host key, not the client agent). The relay
  proxy socket on B is created for the handshake, sealed traffic flows for seconds,
  then the socket is unbound and the pairing torn down while the established pane
  keeps running on its own transport. This is the "discard immediately after
  connecting" intent, achieved without the key ever moving. A fresh re-authentication
  re-opens the relay, requiring A online at that moment.

## 9. Host-key trust

Trust for D follows the key-holder, not the connecting box, and pins are stored per
resolved destination `user@host:port` (never one per grant).

- M1: the connecting machine is the key home, so this is plain OpenSSH. The launcher
  connects with `StrictHostKeyChecking=accept-new`: a first connect to D records its
  key into the connecting machine's `~/.ssh/known_hosts`, and OpenSSH itself refuses a
  later changed key (we run no separate byte-check in M1).
- M2 (relay): when a grant is created, A's trust in a destination's host key is
  captured (TOFU from A's `~/.ssh/known_hosts`, or an explicit pin) and stored as
  `ssh_host_pins` against that resolved destination. B's ssh then validates D
  against a rendered `UserKnownHostsFile` containing the pin with
  `StrictHostKeyChecking=yes`; B's own `known_hosts` is not the authority.

A changed host key is a byte-equality hard block, matching the pin doctrine elsewhere
in the threat model.

## 10. Trust model delta versus section 0

Gained: the plane never holds or sees an SSH private key or a plaintext sign
challenge; a plane compromised AFTER A first pinned B's signing key cannot forge a
request A will honor (origin is B's signature over the payload, verified against that
pin, not the seal); D never receives a forwarded agent.

The word "after" is load-bearing. The TOFU pin between two machines is established
through the plane, so a plane compromised BEFORE A's first pin of B can substitute
its own key. That is exactly the first-use window `pin-store.ts` documents for
channels (a compromised server swapping a key into a roster slot, undetectable to
the sender) and the reason that module exists. Closing it needs an out-of-band pin or
a first-secure-contact story, which is M2 design, and `docs/security.md` section 0
already lists control-plane compromise as not-defended. The relay inherits
`pin-store`'s strictness and its `SUBSHELL_CHANNEL_PIN` escape unless M2 says
otherwise.

Unchanged or accepted: the OS-user boundary on A and B is still the operator; a
machine you run the agent on is a machine you trust. A already-compromised B can
drive its granted relay during the handshake (bounded by the method allow-list and
key-scoping, section 8). The plane retains what it always had: denial of service,
and metadata (which machines talk, timing, sizes, and the plaintext routing ids on
sealed envelopes, which reveal no key material).

## 11. UI

The surface is designed fresh; #330's connect UX is intentionally not carried over.
That flow led with "where do you connect from," offered several overlapping ways to
pick a target at once (connect-from, connected hosts, saved locations, recent, a
manage link), and implied a Subshell runtime on the far side (folder, agent, and
preset pickers) even for what should be a plain shell. It read as confusing, so we
design around its failure modes rather than patch it.

The job is one question, "where do you want to work?", so the flow leads with the
destination:

1. A single searchable destination field. The connecting box defaults to the user's
   chosen default connecting machine (the one used unless step 2 changes it), and
   the field is fed by that box's `~/.ssh/config` (via `sendCommand`, section 5.2)
   plus saved and recent hosts (the discovery idea, reused). Pick or type a host.
2. Choosing a different connecting machine, or a key source on another machine
   ("sign with [machine]'s keys"), is a progressive follow-up shown only when the
   default cannot do it, never a mandatory first step. The cross-machine key source
   is the M2 relay; in M1 the key is always on the connecting box. The common case
   just opens.
3. Opening yields the interactive terminal pane. "Set up Subshell here" is a
   secondary act inside the pane, not a competing mode on the landing screen.

Saved and recent hosts live on the plane, keyed by the resolved canonical
destination `user@host:port` (the alias is display metadata only), so an edited
alias can never silently re-point a saved destination or a pin. A machine whose SSH
gate is off (section 4.3) is never silently offered: when one is needed it is named
with the remedy to ask its owner to enable SSH there. Terminology stays to three
nouns: destination, connecting machine, key source. The destination field is a
`SearchableSelect` like the other launch pickers. Shipped copy follows the design
system: role tokens only, at most two sentences, no em dashes.

## 12. Failure modes and UX

- A offline in relay mode: refuse before the handshake, name the remedy (bring the
  key machine online); never copy the key to B.
- No matching key in A's agent: say so and point at loading it; never fall back to
  reading a passphrase-protected file.
- D host key changed since first recorded: the connect is refused (M1: OpenSSH's own
  changed-key refusal against the connecting machine's `known_hosts`; M2: our pin's
  byte-equality block), naming D.
- Grant names a connecting machine that cannot reach D: a distinct error from "no
  key," so the two causes are not confused.
- Relay expired or A dropped mid-handshake: the connection either completed (pane
  fine) or fails cleanly with a retry that re-opens the relay.
- Quota or policy refusal (by the plane or by A): a loud refusal naming the reason,
  never a silent fallback (the convention this section follows).

## 13. Security rules honored

- No key material, challenge, or signature content in any log, argv, audit row, or
  notification. Audit rows name ids, hosts, and field names only.
- The agent proxy socket on B is 0600 in a per-session directory; the rendered
  connection config is 0600; transient files are removed with the pane.
- `shellQuote` on every token of the built command; the connection is one tmux shell
  string, and that is never reasoned away.
- Node command transport is the existing authenticated, signed, replay-fenced
  `sendCommand` path (present on `main`). The desktop ssh *broker* and its monotonic
  replay fence are #330 code, not on this base; if M2 needs the laptop's own broker
  it is re-ported then, not assumed here.
- Outbound SSH is gated per node, off by default including `local`, and fails closed
  when the setting is unreadable (section 4.3); enabling is owner (admin on `local`)
  only and audited (`node.ssh_enabled`).
- `SSH_AUTH_SOCK` is exported only into the ssh invocation, never the whole pane env,
  and an agent-capable pane is view-only to sharees (section 5.4).
- Static imports only; no dynamic import outside the one sanctioned plugin site.
- Machine-to-machine sealed payloads reuse the channel crypto and TOFU store, not a
  new bespoke cipher.

## 14. Testing

- Unit, M1: alias discovery budgets and wildcard exclusion; `ssh -G` snapshot
  parsing and the forbidden-settings refusal; ProxyJump argv construction and
  quoting; the `ssh_enabled` gate default-off, fail-closed-on-unreadable,
  owner/admin gating, and `nodeCanSsh` refusal codes; the scoped `SSH_AUTH_SOCK`
  export (present on the ssh process, absent from the rest of the pane env); and the
  view-only rule (a sharee typed into an SSH-terminal pane is refused input,
  section 5.4).
- Unit, M2: connection-config render with the pinned `UserKnownHostsFile`; the
  agent-proxy wire framing against a stub agent, including that non-allow-listed
  agent methods are refused; grant validation; relay envelope seal/open (right
  recipient opens, wrong id and tampering fail); envelope replay within a window is
  inert.
- Integration, M2: two in-process machine identities as A and B with a fake plane
  relay; a sign request reaches A's stub agent, the response returns sealed, the
  relayed blob is opaque at the plane, an ungranted or wrong-origin request is
  refused, and revoke stops signing mid-session.
- End to end: the sshd fixture reused as D. M1 direct drives a single-hop pane to D
  on the connecting machine's own agent (the section 1 primary and section 11 common
  case): it opens, streams, accepts owner input, and refuses a sharee's input. M1
  jump drives a real two-hop `ProxyJump` (bastion plus target) with the key on the
  origin only. M2 relay is the crown-jewel test: a second
  machine as A with the key in its agent, a B with no key, B authenticates to D
  through the plane relay while the plane-side wire capture shows only opaque
  envelopes plus plaintext routing ids, and the key never appears on B or the plane.
- CI regime per `verification.md`: focused files while iterating, the full trio
  plus `lint:prose` at the boundary, e2e under the existing serial container regime,
  `env -u SHELLOPTS -u BASHOPTS` for shell-spawning suites, never live `:3080`.

## 15. Branching and reuse from main

`origin/main` does not contain the ssh-runtime subsystem (discovery, resolve, the
connection-snapshot grammar, the brokered-session supervisor, the ssh-broker, or the
sshd fixture); those live only on `feat/ssh-support`. The E2EE primitives
(`mcp-core` seal/open and the TOFU pin store) are already on main.
`feat/ssh-anywhere` re-introduces only the neutral primitives: OpenSSH config
discovery, `ssh -G` resolve, and the connection-snapshot grammar, plus the sshd test
fixture, as a small first commit, and deliberately does not carry the session-frame
codec, supervisor, or runtime-serve. `feat/ssh-support` stays open and unmerged as a
reference for the brokered-session transport that M2 may revisit. Reuse is code and
ideas only: the UX is redesigned (section 11) rather than ported, and #330's connect
flow is a cautionary example, not a base.

## 16. Deferred / open items for Milestone 2

- The machine-identity roster and TOFU pin flow (section 5.3), including whether the
  relay obeys `SUBSHELL_CHANNEL_PIN` or is always strict, and how to narrow the
  first-use window (section 10).
- Whether the agent-destination upgrade reuses #330's runtime-session protocol or a
  lighter boot now that the terminal path exists.
- Per-use approval UX on A (notification or prompt to confirm a handshake), versus a
  standing grant; and whether the approval flag on the grant ships with it.
- Whether to support A's identity by file (with an on-A passphrase prompt) at all,
  versus requiring the key loaded in A's agent.
- Enrolling a relay-only destination as a first-class node automatically after a
  successful "set up Subshell here."

## 17. Success criteria

Milestone 1 is done when, from the web app and the enrolled laptop, an operator
opens an interactive pane against an arbitrary sshd-only host on a machine whose
owner has enabled the (default-off) SSH gate, using that machine's own agent (via
the scoped `SSH_AUTH_SOCK` export) or a jump through a hop; it streams and accepts
the owner's input (sharees view-only, section 5.4), and no private key or plaintext
challenge ever crosses the plane. In M1 the plane is not on the ssh transport path:
ssh runs directly between the connecting machine and D, so no SSH protocol bytes,
keys, or challenges cross the plane; pane streaming and logging stay the ordinary
pane path (section 5.4), and D sees only a normal ssh handshake. Milestone 2 is done
when the same pane can run on a machine with no key at all, authenticating through a
machine that does, with a CI test proving the plane sees only opaque envelopes and
the key never leaves its home.
