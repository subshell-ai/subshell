# @subshell-ai/plugin-netbird

The NetBird network plugin for Subshell. A `type: "network"` built-in: it
connects the control-plane host to a NetBird network and publishes Subshell on
it, so a device on that network can reach this server.

It **describes; the host executes.** Every command goes through `host.run`, the
publish returns the addresses a join already made reachable and runs no command,
and nothing here spawns a process, writes a file, stores a credential, or edits
the server's own configuration. Identity, platforms, exposure and the privileged
install steps live in `package.json`'s `subshell` block — a page renders "not
available on this platform" and prints the root-requiring install commands without
importing any of this code.

## What is unusual about NetBird specifically

- **No `needs-privilege` state.** Once the daemon is installed, the NetBird CLI
  authorises callers by kernel peer credentials (claimed for ≥ 0.76), so the
  server's own unprivileged user may run `up` and `status --json` without further
  grants. The ladder runs `not-installed → daemon-down → needs-login`.
- **Publishing is not a command — joining IS the publish.** A join already makes
  the machine reachable at its WireGuard address, so the host records the
  addresses and admits them to the trusted origins as part of the join itself;
  the plugin's "Use this address" press survives only as the fallback for the
  rare join whose address had not propagated yet. The plugin's own `unpublish`
  stays a no-op — there is nothing on the machine for it to undo — but the
  host's half clears the record and removes the trusted origins, so the address
  stops accepting sign-ins at the next restart.
- **The management URL is the daemon's own config — the card has no field for
  it.** A self-hosted NetBird is set up **on the machine**: run
  `netbird setup`/`netbird up` yourself first; this card then reflects and
  publishes what the daemon says. There used to be a "Management URL
  (self-hosted only)" settings field, and it was right about the mechanism —
  it fed `netbird up --management-url` at join — but post-join the daemon owns
  its config, so the card's copy was a dead input that could disagree with
  what the machine already says. Hosted SaaS is what a bare `netbird up` uses;
  the setup **key** stays, because it is the join credential, not
  configuration (operator's ruling, 2026-09-16).
- **Peer names need a nameserver group.** The FQDN address is offered alongside
  the IP, with a hint saying peer names only resolve when the NetBird account has
  a nameserver group configured — otherwise use the NetBird IP address — linked to
  [the vendor's DNS page](https://docs.netbird.io/how-to/manage-dns-in-your-network)
  because that group is an account-console setting, not something on this machine.

## Measured, and what is still not

**Measured against a live daemon on 2026-09-16 (NetBird 0.66.4).** `netbird
status --json` answers with `netbirdIp` **CIDR-suffixed** — verbatim
`"100.71.129.37/16"` — the version under `daemonVersion` and `cliVersion`, and
the machine's name under `fqdn` with no trailing dot; there is no `hostname` key
at all. So the reader strips a trailing `/prefixlen` before accepting an IPv4
(a CIDR value is not a URL host, and rejecting it whole left the card listing no
IP under a hint telling the operator to use the IP), and the identity prefers the
daemon's version over the CLI's. The spellings the two specs guessed — `peerIP`,
`ip`, `netbirdVersion`, `version` — survive as fallbacks, and the guessed IP order
puts them ahead of the measured one. That read ran as the server's unprivileged
user and answered.

These still rest on claims **not verified against a live NetBird** (master spec
§ 10, item § 10.4). The code degrades honestly in each case rather than pretending
the shape is settled:

- **§ 10.4 — the peer-credential authorisation** behind "no `needs-privilege`
  state" is unconfirmed as a mechanism (a working unprivileged `status` is not
  proof of how it was authorised, and `up` was never probed unprivileged). A
  socket error, a permission refusal, and an unparseable status body are all
  reported as a **generic `daemon-down`** with the same sentence; the plugin never
  guesses which one it saw.
- **The device-flow output shape is unconfirmed.** The interactive join reads a
  login URL (and a device code if one appears) off the output stream, then aborts,
  falling back to a status re-read — mirroring the Tailscale interactive join. A
  run that yields no usable URL and no connection reports the CLI's own failure.

## Publish state comes from the host's record

The plugin can only ever observe `joined`. The `joined → published` distinction
lives entirely in the host's trusted-origins config, which a plugin may not
read — so a NetBird that has been published still reports `joined` on the next
status read, and this is inherent to a plugin whose publish has no
daemon-visible effect (see the design notes in `src/status.ts`).

What closes it is the manifest's `publishImplicit: true`: it tells the host
that for this plugin its own publish record IS the published state, and the
host upgrades `joined` to `published` when — and only when — that record
exists. A plugin without the flag (Tailscale, whose `serve` state is readable)
is never upgraded, so a serve reset from a terminal still shows honestly as
`joined`. The mechanism is `publishStateVisible` in
`apps/server/api/src/services/network/state.ts`.

## Licence

Apache-2.0 — see `LICENSE`. (Everything outside `apps/server/**` is Apache-2.0;
this plugin ships both as a built-in inside the AGPL server binary and as a
permissively-licensed package third parties can build against.)

## Icon

`icon.png` is NetBird's official brand mark, taken from the project's own
repository (`netbirdio/netbird`, `docs/media/logo.png`, BSD-3). Icon policy
(operator, 2026-09-16): the vendor's own asset or the letter-monogram
fallback — never a drawing of our own.
