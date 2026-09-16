---
"@internal/server": patch
---

Cloudflare Tunnel: publish this server on a hostname you own, behind Cloudflare Access

The third network plugin for Settings → Networking, and the first built-in to
actually use the `supervise` and `guard` capabilities — the supervisor that
holds a plugin's long-running child, and the Access front door that refuses
every request whose Host names the tunnel hostname without a valid assertion,
both shipped by phase 1 and unexercised until now. `cloudflared` is the one
connector needing no root anywhere, so this is also the one plugin with an
Install button the server may press (`brew install cloudflared`, macOS); the
Linux apt-repo step prints for a human to copy.

The shape is the contract's: joining stores the connector token in the
write-only secret store and spawns nothing; publishing refuses unless the
hostname, team domain and AUD are set and a pre-flight at Cloudflare's edge
confirms an Access application covers the hostname — failing CLOSED, since
the whole exposure of `public-with-gate` is bounded by that check; and the
tunnel itself runs as a supervised child, authenticating through its
`TUNNEL_TOKEN` environment so the credential is never an argv element and
never visible in `ps`. Unpublish and Disconnect follow the host's existing
ordering: the process stops first, the guard drops last.

The token is a new credential class at rest, and `subshell-server backup`
does not include it — the field says so, and after a restore it needs pasting
again. § 10.5 (cloudflared's `--token-file` version floor, the pre-flight's
exact status and header shapes) remains UNMEASURED: no live Access team was
available, so the pre-flight passes only on positive evidence of Access and
treats every other answer — including a failed check — as a refusal.
