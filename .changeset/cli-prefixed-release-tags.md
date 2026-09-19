---
"@internal/server": minor
"@internal/node": minor
---

Release tags now read `<form>-<role>-v`: the control plane publishes under
`cli-server-vX.Y.Z` and the node agent under `cli-node-vX.Y.Z`, matching the
`desktop-server-v` / `desktop-client-v` pair. Artifact file names are
unchanged.

This is a hard cutover with no compatibility fallback: a binary reads only its
own compiled-in prefix, so an installation from before this release will never
see this release, or any after it. Reinstall from `install-server.sh` (or
re-run the node enroll one-liner) rather than waiting for self-update.
