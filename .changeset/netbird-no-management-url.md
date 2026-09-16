---
"@subshell-ai/plugin-netbird": patch
"@internal/server": patch
---

NetBird's card no longer asks for a management URL

The plugin declared one optional settings field — "Management URL (self-hosted only)" — that only ever fed `netbird up --management-url` at join; after joining, the NetBird daemon owns its own configuration, so the card's copy was a dead input that could disagree with what the machine already says. It is gone, along with the `settings` capability that paired with it: a self-hosted NetBird is set up on the machine (`netbird setup`/`netbird up`), and the card then reflects and publishes what the daemon reports. Hosted SaaS is what a bare join uses, and the setup key is untouched — it is the join credential, not configuration. NetBird cards now show no settings fields anywhere; the joined card's "Change settings" disclosure appears only on plugins that still have them. The plugin ships built in, so the server binary carries the change too.
