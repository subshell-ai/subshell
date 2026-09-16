---
"@subshell-ai/plugin-headscale": patch
"@subshell-ai/plugin-tailscale": patch
---

A machine on the wrong tailnet stops showing as Joined

Both Tailscale-family rows read the same daemon, so a machine connected to
Tailscale's own service used to show "Joined" on its Headscale row — and could
even show "Published", because the publish check read that same foreign
daemon's serve config. Each row now asks the daemon itself with
`tailscale debug prefs`, whose `ControlURL` names the control server it serves:
the Headscale row claims a running daemon only when it names your configured
Control server URL, and the Tailscale row only when it names Tailscale's own
service. A machine that positively belongs to the other network reports
needs-login with a hint naming where it actually goes — the Headscale one
offers the `tailscale logout` line to type in a terminal, and this server never
runs it. A daemon too old to answer keeps behaving exactly as before.
