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

The Service buttons now refresh the page they act on. Installing a service left the card still saying "not installed" — the node page does not poll, and the mutation wrote nothing back — so every verb but Restart looked like it had done nothing until you navigated away and came back. Restart, which has to wait for the agent's own socket to return, shows a spinner while it waits.

On macOS, whether the agent starts at login is read from `RunAtLoad` OR `KeepAlive`, not `RunAtLoad` alone. `KeepAlive=true` starts the job either way (measured), so a plist with `RunAtLoad=false` was reported as "does not start at login" about an agent that does.

The node's Log card follows at one second — the server's own cadence — instead of offering a Refresh button beside a line saying it already refreshes every five seconds. It asks nothing while its tab is hidden. Pausing stops the asking, so you can read something without the next poll moving it. Both log scrollers — this one and the server's — can now be reached and scrolled from the keyboard.

Where a node runs under systemd, "starts at login" now says what it does not cover: a user service stops when its owner logs out, and `loginctl enable-linger` is what keeps it up. The agent's installer already said so, to a terminal on a machine most people never open one on.

A node's agent has a debug-logging switch, matching the server's: off by default, applied live, persisted on that machine so a restart does not end a debug session, and read-only while `SUBSHELL_DEBUG_LOGGING` is set in the agent's own environment. It reveals nothing yet — the agent writes no debug-level lines, and the card says so rather than leaving you to discover it by flipping the switch — but the control is now where the log is, which on a headless node is the only place either can be reached.

Reading a node's log no longer fills the server's own. Request lines are written at debug into one 200 KB file that is replaced when full, and the node log poll was not exempt — so with debug logging on, a single open node page would have destroyed the history it was turned on to read.
