---
"@internal/server": patch
---

A server now hands installing machines the newest node build it can actually talk to. The node-binary shelf used to win unconditionally: a plane updated across a protocol bump kept serving the old agent it (or a hand copy) had left on disk, the one-liner reported a successful install, and the new node sat refusing to connect forever because its server spoke a different protocol. The shelf copy is now asked what it is: a hand-published build that is newer and speaks the server's protocol still wins, but an outdated one yields to the published release (replacing files this server fetched itself, never somebody else's bytes), a copy that cannot connect is never served while a supported release exists, and the checksum the installer compares against announces the same answer the download would give. `subshell-server status` prints each shelf copy's version and protocol, so a stale shelf is visible before a fleet trips over it.
