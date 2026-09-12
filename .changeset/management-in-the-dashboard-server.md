---
"@internal/server": minor
---

Server Settings → Service: a new admin page for how this server is deployed. Addresses (port, bind address, public base URL, trusted origins) are edited in the dashboard and written through the CLI's own validator, so a browser and `subshell-server configure` produce the same file. The page shows what config.env saves against what the running process booted with, so an edit made over ssh is visible without the dashboard having written anything. The server can restart itself, but only where its service manager reports this very process, so a hand-run server is never exited into nothing. Data locations and the service definition are listed for copying.

The server now keeps its own log file at `<data dir>/logs/server.log`: one file, JSON lines, 0600, capped at 200 KB and replaced when full, the same on every platform and never copied into memory. An admin can read its tail from any browser. A debug-logging switch, off by default, is an instance setting applied live with no restart; while on, the file carries debug lines and one line per HTTP request. `SUBSHELL_DEBUG_LOGGING` forces it on and makes the switch read-only.

Node detail shows how an enrolled node's agent runs — supervision, service state, config and log paths, whether tmux was found — and can restart it. An About dialog, for every user rather than admins only.

New admin routes: `GET /api/admin/server`, `PATCH /api/admin/server/config`, `POST /api/admin/server/restart`, `GET /api/admin/server/logs`, `PUT /api/admin/server/logging`. New node route: `POST /api/nodes/:id/restart`. `BACKEND_LOG_LEVEL`, which nothing read, is removed.
