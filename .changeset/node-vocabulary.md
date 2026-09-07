---
"@internal/node": minor
"@internal/server": minor
---

**The node agent is released as `node`, not `client`.** Its git tag prefix is
now `node-vX.Y.Z`, its published binaries are `subshell-node-cli-<triple>`, its
dispatch option is `node`, and the root script is `bun run release:node`.

`client` used to mean two things — the node-agent side of the product, and the
thing a person points at a control plane — so the `client-v*` tag published the
agent while the actual clients carried no client branding at all. Three words
now name one thing each: a **server** is a control plane, a **node** is a
machine that runs agents, a **client** is a person's interface to a control
plane.

Nothing about the agent itself moves: the installed binary is still `subshell`,
with the same commands, the same `~/.config/subshell`, the same service unit and
the same node protocol.

**An existing instance must republish its node artifacts** (`bun run
release:node` with `SUBSHELL_NODE_ARTIFACTS_DIR` pointed at the directory the
server serves). Until it does, every agent download 404s: the server now looks
for `subshell-node-cli-<triple>` and the old files are on disk under the old
names. `bun run prune:node-artifacts <dir> --delete` clears them afterwards.
