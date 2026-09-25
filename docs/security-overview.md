# Subshell Security

Subshell lets you run AI coding agents in real terminals on your own machines,
and watch or drive them from any device. This page explains how we think about
security: what protects you, and where this design would let you down. We would
rather be honest about the second half than sell you the first.

If you want the full engineering threat model, with every accepted risk and its
argument, it lives in this repository at `docs/security.md`.

## The premise: your machine, your network

Subshell is self-hosted software. You run the control plane (the server and its
dashboard) on hardware you own, and the agents run on machines you enroll to it.
Your panes, transcripts, and accounts live in a database on your own disk.
Subshell itself sends no usage data anywhere; the only outbound calls are the
update checks, which you can disable entirely.

The trust model assumes two things:

1. **The machines Subshell runs on belong to you.** Whoever has an account on
   the host server can already read everything Subshell can read. We design
   against outside attackers, not against your own operating system.
2. **Everyone with a login is someone you admitted.** A Subshell instance is
   like your team's internal tools, not a public SaaS with hostile neighbors.

That leads to our headline caveat, said up front: **Subshell is built for
private networks** (your machine, your LAN, a VPN or Tailscale mesh). It is not
hardened to sit open on the public internet, and you should not put it there
without HTTPS in front of it and a pass through our hardening checklist.

## What protects you

### Getting in

- Sign-in uses proven, battle-tested session machinery: email and password or
  passkeys, HttpOnly cookies, and a login attempt limiter.
- Registration is closed by default once the first admin account exists.
  Opening it again is an explicit, logged admin decision.
- Human logins and machine credentials are different kinds. Each running agent
  pane gets its own API token, scoped to narrow permissions, expiring and
  self-extending only while the pane lives, and revoked the moment the pane is
  terminated or its owner is disabled. A machine token can never manage the
  instance, change settings, or create users.
- There is a break-glass recovery path for a locked-out admin, but it only
  works if the operator set an emergency secret in the server's environment,
  it overwrites that admin's own password to do its job, and it shows a warning
  banner to every signed-in user while armed. Quiet back doors are not a thing
  here.

### Who can see and touch what

- Every subshell is **private to its owner by default**. To anyone else it does
  not merely deny access, it is invisible: the id returns "not found", so ids
  cannot be probed for existence.
- Owners grant two levels: **view** (read the pane live, read its history) and
  **edit** (also type into it, rename, restart, terminate). Sharing is always
  disclosed: anyone attached to a shared pane can see who else is watching.
- Push notifications about a subshell go only to its owner's devices. Sharing
  to see is not sharing to be notified about.
- Admins can manage the instance, but they cannot delete someone else's
  subshell or change its shares. Those stay owner-only.
- A node owner can restrict which directories agents may work in on that
  machine, enforced both at the control plane and independently on the node.
- **Maintenance mode** takes a machine out of the routing pool and ends the
  subshells running on it, from either end, in case you ever need to stop a
  machine from doing work, now.

### Machines that run your agents

Enrolling a machine (a "node") into an instance uses a single-use setup key
that expires in 24 hours. After pairing, the relationship works like this:

- Every command the control plane sends a node is **cryptographically signed**:
  it proves which control plane sent it, which node it is addressed to, and
  that it is fresh, not a replay. The agent refuses anything that does not
  verify, and nothing a node's own key can do on the API side is privileged.
- The link between a node and the control plane **encrypts itself, always**.
  Every connection negotiates a fresh key that both sides authenticate against
  the long-term identity each pinned at pairing, and from then on the socket
  carries only ciphertext. A server on plain `http://` no longer puts your
  agents' commands, tokens, or terminal traffic on the network in the clear.
  What the encryption does not decide is *who you paired with*; that stays
  the setup key's job. Shortfall 5 below still applies to everything the
  browser sends you.
- The browser never talks to nodes directly. One person's browser session can
  never reach another's live terminal unless the owner shared that pane, and
  the tokens used for that are short-lived and single-use.

### Agents talking to each other

Subshell gives agents encrypted channels to coordinate. Messages are sealed
per recipient with their key (ECDH, the standard scheme), so **the server
stores and relays only ciphertext it cannot read**, and agents who are not
recipients see nothing. To be precise about the boundary: message bodies are
protected, but metadata (who is in which channel, when messages flow, their
sizes) is visible to the server, and no encryption protects the message body
from a compromise of the machines the keys live on.

### Staying up to date, safely

This is the part we take most seriously, because auto-updaters are a favorite
attack route:

- Every release ships with a manifest signed by our publisher key. The server,
  the node agent, and both desktop apps verify that signature **before
  trusting any download address or digest**, against a public key compiled
  into the product itself.
- A compromised or malicious download host can withhold updates or replay old
  signed ones. It cannot make you run code we did not sign.
- Every binary replacement is a transaction: the old version is kept, a fresh
  install that fails to start rolls itself back automatically, including the
  database snapshot taken before the swap. A bad update does not brick you.
- The desktop apps are code-signed, notarized on macOS, and their updates ride
  the same signature chain.

### Plugins (the integrations that drive agent CLIs)

Installing a plugin is an explicit admin action, logged, from a registry
integrity-checked against the publisher's hash. The honest framing: a plugin
runs with the server's privileges, so installing one is the same trust decision
as installing the coding CLI it drives. We keep that door narrow (admins only,
audited) rather than pretending it is free.

## Where it would fall short

No shrouding. These are the real limits of the design as it ships:

1. **Your OS user boundary is the perimeter.** Anyone who can log in as the
   account running Subshell can read the database, every pane transcript, and
   every key on disk, including channel message bodies. This is inherent to a
   self-hosted tool on your own account, but it is worth stating: Subshell
   adds no protection against your own machine being compromised.
2. **Pane transcripts are plaintext, and complete.** A terminal echoes, so the
   log of a pane contains what *you typed* into it too, including any token
   you pasted. We protect these files with strict permissions (owner-only,
   retention sweeps) rather than encryption, because a key stored on the same
   disk by the same user would be theater. Treat "paste a secret into a pane"
   the same way you treat typing it into your shell history.
3. **Some credentials can appear in process listings.** A running agent's
   token, and a setup key used on the command line, are visible to local users
   via `ps`. Each is short-lived or single-use, which bounds this, but a local
   user on the machine could grab them.
4. **A compromised control plane compromises every enrolled node.** The signing
   key rules all of them. Run the server on a machine you would trust with a
   root shell, because that is effectively what it is.
5. **It is a trusted-network service, not a public one.** Login is rate
   limited; most other endpoints are not. There are no per-user quotas, no
   exhaustive input-length limits, no multi-tenant isolation work, because
   those defend a scenario this product is not designed for. Put it behind a
   VPN or Tailscale. The node-to-server link encrypts itself (above), but
   everything between a browser and the server does not; your sign-in,
   cookies, and what you see in panes are only as private as the transport
   you put in front of them. If you must serve it further, HTTPS and the
   hardening checklist are prerequisites, not suggestions.
6. **Push notifications ride third-party relays.** When Subshell pings your
   phone, the message travels through Apple/Google/Expo infrastructure. Those
   relays learn your device token, the event type, and timing, and sometimes a
   pane's display name. Pane contents and credentials never do. If even that
   metadata concerns you, turn notifications off; nothing else breaks.
7. **Sharing is broad on purpose.** Anyone you share a pane with sees its
   entire output (secrets on screen included), and at `edit` can send it
   keystrokes. The UI discloses this loudly, but the capability is real.
8. **No certifications yet.** No SOC 2, no completed external penetration-test
   program as of this writing. What exists instead: the entire threat model is
   public, the control plane's source is open (AGPL), and the design decisions
   are written down with their costs. We would rather earn the audits than
   buy the badge while the model is still young.

## Who this is right for

Subshell is secure in the way your own shell is secure: strong access control
between *you and the outside*, full trust inside the boundary you set, and no
pretense otherwise. For a person running agents on their own machines, or a
small team over a private network, that is exactly the right shape. If you need
to host untrusted tenants on a public endpoint, this is not that product yet,
and this page tells you so before you find out the other way.
