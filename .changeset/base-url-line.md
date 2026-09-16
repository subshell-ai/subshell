---
"@internal/server": patch
---

The Networking page now prints the server's own address, and the chips legend is gone

Every card's "Set as this server's base URL" competes for one value, so the
page that lists the cards now states it: the address the server is RUNNING as
and which network's published address it is ("http://… — over Tailscale").
When a promote saves a new one, the line names the pending address and its
network as awaiting the restart, because APP_BASE_URL is read at boot — the
saved value is not the live one until the restart the publish card already
asks for.

The "Joined means… Published means…" sentence above the network lists is
removed; the cards and the publish section now carry that difference where
the states actually appear.
