---
"@internal/website": patch
---

Refresh the site's copy of the control-plane install script: subshell.sh serves a build-time copy of the root `install-server.sh`, and that script changed with the terminal-handoff fix (the reattach is gone; `init` acquires its own terminal and prints every non-interactive default), so the published one-liner's bytes must move with it. This bump is what lets `website.yml` mint a fresh `website-v*` tag after the merge; without it the deploy would refuse against the already-published tag.
