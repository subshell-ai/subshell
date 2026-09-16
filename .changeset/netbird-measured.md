---
"@subshell-ai/plugin-netbird": patch
"@internal/server": patch
---

NetBird's card reads a live daemon, and the publish sentence names its own button

A NetBird that had joined now lists its **NetBird IP** address beside the FQDN.
The daemon reports that address with its subnet suffix attached —
`100.71.129.37/16` — and the plugin rejected the whole value rather than reading
past the slash, so the card showed no IP at all while its own hint told you to
use the IP address. The prefix now comes off before the address is checked. The
**Client version** appears for the same reason: the daemon answers it under
`daemonVersion` (falling back to `cliVersion`), where the plugin had been looking
for fields guessed before any live NetBird was available.

The nameserver-group hint now names the address it points at — "otherwise use the
NetBird IP address" — and links to NetBird's own DNS page, because a nameserver
group is an account-console setting and not something on this machine.

And the sentence above the publish button quotes the button. It used to say
"publishing is what lets your other devices open this dashboard" whatever the
button under it read, which on NetBird is **Use this address** — an operator read
two different words for one act and asked how to publish. The row's own label is
now that word, so the sentence and the button cannot disagree: "Use this address"
on NetBird, "Publish with Tailscale Serve" on Tailscale, "Start tunnel" on
Cloudflare Tunnel.
