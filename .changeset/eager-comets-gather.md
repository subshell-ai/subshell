---
"@internal/node": minor
---

A node now serves its own admin dashboard on loopback. `subshell run` binds it
beside the daemon (and `subshell dashboard` runs the page without the daemon, to
fix a machine whose agent is stopped); it is on by default, `SUBSHELL_DASHBOARD=0`
opts out, `--dashboard-port`/`SUBSHELL_DASHBOARD_PORT` moves it off `:3090`.

Three pages — Status, Settings, Updates — answer the machine about itself, so the
box is operable headless with or without a plane, on the same host as the server.
No login: everything the local CLI lets this OS user do, the page can do, and it
binds `127.0.0.1` only (the DNS-rebinding Host check, the cross-origin Origin
check, and a JSON-content-type requirement on every mutation are the access
control). Updating is the same signed-manifest trust chain as `subshell update`;
the allowed-dirs list is read-only here because the plane owns it and re-pushes
on every reconnect. The compiled `cli-node-v*` binary carries the pages embedded.
