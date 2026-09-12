---
"@internal/server": minor
"@internal/node": patch
"@internal/desktop-client": minor
---

A node gets the management surface the control plane already has for itself. Its page is now sectioned — Overview, Service, Configuration, Logs — and from any browser you can start, stop, restart, install or uninstall the agent's service, read what that machine logged, and point it at a different control plane. Most nodes are headless, so this is the only place those questions can be asked at all.

Stopping and uninstalling are the node owner's alone, and say so before they run: every command reaches a node over the agent's own connection, so nothing here can start an agent that is not running — reversing either needs a shell on that machine. Repointing is the owner's too; it hands the machine a new address to dial and takes it off this instance.

The agent now writes its own log file, capped and replaced when full, because its console output goes to a journal on Linux and a file on macOS and neither can be read from a browser.

Subshell Client's setup assistant no longer carries a colophon under every screen. What the app is, which versions are running and under what terms is a screen you ask for — from the tray, or from the About panel in the macOS menu bar.

Node agents need updating alongside the server: the node protocol changed, and the two ship together.
