---
"@internal/server": minor
---

Published server binaries now say **cli** in their names:
`subshell-server-cli-<triple>` (with the `.sha256` sidecar following the
binary's name, as always).

It is the counterpart of the `Desktop` suffix the desktop apps just took. All
four artifacts ship from the same repo and land side by side in a downloads
folder, where `subshell-server-darwin-arm64` next to
`Subshell-Server-Desktop.app.tar.gz` said nothing about which was the bare CLI.

The suffix is on the artifact name only. The installed binary is still
`subshell-server` — so `install` the downloaded file **as `subshell-server`**;
dropping just the triple now leaves `subshell-server-cli`, which is not the name
the service unit invokes. No CLI command, config path or service name changes.

The server also resolves the node-agent artifacts it serves under their new
names, so **an existing instance must republish its node artifacts**
(`bun run release:node` with `SUBSHELL_NODE_ARTIFACTS_DIR` pointed at the
directory the server serves). Until it does, the enroll one-liner and
`GET /api/downloads/node/*` 404 on every target — the old files are still on
disk under the old names.
