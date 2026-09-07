---
"@internal/client": minor
---

**Intel Macs are no longer a published target.** The agent's `darwin-x64` build
is dropped, leaving `linux-x64`, `linux-arm64` and `darwin-arm64`.

It was the last Intel build in the repo — the server CLI and both desktop apps
never had one — so keeping it meant paying for a cross-build and a release
shard every cut for a platform Apple is winding down.

`install.sh` now refuses an Intel Mac **by name** rather than resolving a target
that 404s: "no binary published for your platform" would read as "the operator
has not published one yet", which is a different problem with a different fix.
Running the agent from a checkout is the remaining path. Note that
`darwin-arm64` is not a fallback — an arm64 binary does not run on Intel, and
Rosetta only translates the other direction.
