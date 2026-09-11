---
"@internal/server": minor
"@internal/node": minor
---

Harness hooks no longer require `bun` on the pane's machine.

Claude Code's attention and conversation-identity hooks ran `bun -e '<inlined
JS>'`, which assumed a bun on the pane PATH — true of the container image the
assumption was written for, false of every desktop install. There, every
session opened with `/bin/sh: bun: command not found`, notifications never
fired, and the server never learned the in-pane conversation id after `/clear`,
`/resume` or `/fork`, so a restart could resurrect a stale conversation.

The reporting moved into the binary itself: both `subshell-server` and
`subshell` now serve `report attention <kind>` and `report session`, and the
control plane resolves which of them the PANE's machine has — its own for
`local`, the node's reported self-invocation for an agent — and hands the
plugin that command. A plugin given no reporter omits its hooks rather than
baking a command the pane cannot run. Nothing on a pane's machine needs a
runtime it did not already have.

The node protocol is bumped to 4: `ready.selfInvoke` replaces
`ready.mcpLaunch`, carrying the self-invocation WITHOUT its subcommand so the
plane appends `mcp` or `report` to one reported fact. Server and agent ship
together, as the protocol's exact-match rule already requires.
