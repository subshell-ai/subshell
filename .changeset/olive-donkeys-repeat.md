---
"@internal/server": minor
---

An enrolled node can be updated from the dashboard — including one this server refuses to talk to.

`POST /api/nodes/:id/update` replaces a node's agent binary with the release
this server can speak to, and restarts it into the new version. Owner or
`edit`, cookie only, audited.

The part that makes it useful is what happens to a refused agent. An agent
below the version floor or speaking a different protocol used to be closed
4406, which left an ordinary-looking offline row and a machine only a shell
could fix. It is now **held**: the socket stays open, the node stays offline
for every other purpose, and the plane can still send it the one command that
repairs it. Node views carry `held` so a page can say which machines are in
that state and why.

The agent has no REST credential, so the download link carries a single-use
token good for one file, one platform and ten minutes — rather than widening
what a node key can do.
