---
"@internal/server": minor
"@internal/client": minor
---

Node panes now report their real grid, so several devices watching one
subshell on an agent node agree about its size.

A tmux pane has one grid and is sized to the smallest viewer, and the server
announces that grid for clients to pin their terminal to. On the control-plane
host it could read the pane back, so the announcement was confirmed. On a node
it could not — the protocol had no size command — so it announced the size it
had *asked for*: exact for one viewer, a guess for several, and wrong for
everyone if tmux clamped the request. Protocol v4 adds `pane_size`, and the
announcement is now confirmed on every machine.

The agent protocol is also matched exactly now, in place of the old
compatibility window and its per-feature version gates. Server and agent ship
together, so an agent reporting any other version is refused at `ready` and
its node is chipped "agent too old" or "agent too new" — naming which side to
redeploy instead of leaving a bare "offline".
