---
"@internal/desktop-server": minor
---

Subshell Server re-ships with the current control plane inside it (server 0.15.x). Desktop users get, through the bundled binary: the machine-scoped folder picker (switching Machine in the launch form re-homes the working directory to that node's own recents/home; Recent, Favorites and the star follow the browsed machine; a constrained node can no longer seed a directory its caller cannot launch in), the consolidated Settings → Logs page with a paginated audit trail, and the fix that lets a never-published instance lazy-fetch node artifacts (the missing `node-artifacts/` directory is created on demand). The app itself is unchanged — this release is the bundle that carries the server forward.
