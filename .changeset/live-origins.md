---
"@internal/server": minor
---

Trusted origins are live: a network you join or publish is accepted for sign-in at once, with no restart

The list of addresses a browser may sign in from is now consulted on every request from three sources — this server's own addresses, the operator's `TRUSTED_ORIGINS`, and the addresses each enabled network plugin's daemon reports for this machine — instead of being read once at boot. Joining a tailnet is enough for its addresses to be trusted (a Tailscale IP answers with nothing published), while a Cloudflare Tunnel hostname is trusted only once published, when its Access check is in front of it. Disabling, uninstalling or leaving a network forgets its addresses immediately, and the Networking card can disable and enable a plugin directly.

Network acts no longer write config.env, no longer report `restartRequired`, and their results no longer carry a `config` block (an unpublish or leave still names the origins that stopped being trusted); `TRUSTED_ORIGINS` in config.env is the operator's own extras. Saving that field on Server Settings → Service applies immediately too, and the Service page no longer asks for a restart on its account.

Boot trusts what each plugin's record says before the listener opens, asks each daemon once after the processes are up, and then re-asks every five minutes — so the list is right for people who never open the Networking page.
