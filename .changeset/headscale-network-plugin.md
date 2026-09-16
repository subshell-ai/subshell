---
"@internal/server": patch
---

A new built-in network plugin: **Headscale**. Settings → Networking gains a row for reaching this server over your own self-hosted tailnet — the same `tailscale` client as the Tailscale plugin, pointed at a control server you run. It asks for the control server URL before it will join, finishes interactive logins with the hint that a Headscale admin must approve the machine, lists `http://` addresses (Headscale tailnets issue no HTTPS certificates, and the page says so), and tries Tailscale Serve for publishing — where the CLI refuses, it says that serve-against-Headscale is unmeasured rather than pretending. Installing it is the same admin act as every plugin: one install arms every node.
