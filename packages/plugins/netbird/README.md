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
- **Publishing is not a command.** A join already makes the machine reachable at
  its WireGuard address; "Use this address" records the addresses and admits them
  to the trusted origins. Unpublish is therefore a no-op.
- **Peer names need a nameserver group.** The FQDN address is offered alongside
  the IP, with a hint saying peer names only resolve when the NetBird account has
  a nameserver group configured — otherwise use the IP.

## UNMEASURED

These rest on claims that were **not verified against a live NetBird** (master
spec § 10, item § 10.4). The code degrades honestly in each case rather than
pretending the shape is settled:

- **§ 10.4 — the peer-credential authorisation** behind "no `needs-privilege`
  state" is unconfirmed. A socket error, a permission refusal, and an
  unparseable status body are all reported as a **generic `daemon-down`** with the
  same sentence; the plugin never guesses which one it saw.
- **The `status --json` field spellings are unconfirmed.** The peer IP is read
  from `peerIP`, `ip` and `netbirdIp` in turn (the two specs name it differently),
  and the version from `netbirdVersion` or `version`. A document none of them
  match is `daemon-down`, not a crash.
- **The device-flow output shape is unconfirmed.** The interactive join reads a
  login URL (and a device code if one appears) off the output stream, then aborts,
  falling back to a status re-read — mirroring the Tailscale interactive join. A
  run that yields no usable URL and no connection reports the CLI's own failure.

## Contract gap noted while building

The plugin can only ever observe `joined`. The `joined → published` distinction
lives entirely in the host's trusted-origins config, which a plugin may not read,
and `NetworkContext` carries no `published` flag — so a NetBird that has been
published still reports `joined` on the next status read. This is inherent to a
plugin whose publish has no daemon-visible effect; see the design notes in
`src/status.ts`.

## Licence

Apache-2.0 — see `LICENSE`. (Everything outside `apps/server/**` is Apache-2.0;
this plugin ships both as a built-in inside the AGPL server binary and as a
permissively-licensed package third parties can build against.)
