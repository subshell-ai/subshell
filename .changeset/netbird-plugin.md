---
"@internal/server": patch
---

Add the NetBird network plugin

Settings → Networking now offers NetBird beside Tailscale: reach this server
from your other devices over a NetBird network you already use. It is a second
`type: "network"` built-in with its own binary and daemon, so nothing about its
argv or status parsing is shared with Tailscale.

NetBird needs root once to install its service, which the server cannot do from
a browser — so the install steps are printed to copy (the app or the command-line
daemon on macOS, the official script on Linux), and there is no install button.
It has no `needs-privilege` state: once the daemon is installed the CLI
authorises callers by kernel peer credentials, so the ladder runs from
not-installed to daemon-down to needs-login.

Publishing runs no command: a NetBird join already makes the machine reachable at
its WireGuard address, so "Use this address" records the FQDN and peer-IP
addresses and admits them to the trusted origins. Peer names resolve only if the
NetBird account has a nameserver group — otherwise use the IP address.
