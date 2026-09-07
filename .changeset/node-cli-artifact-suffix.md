---
"@internal/node": minor
---

Published agent binaries now say **cli** in their names:
`subshell-node-cli-<triple>` (with the `.sha256` sidecar following the binary's name,
as always). These are both the `node-vX.Y.Z` release assets and the files
`GET /api/downloads/node/*` serves to the enroll one-liner.

It is the counterpart of the `Desktop` suffix the desktop apps just took. All
four artifacts ship from the same repo and land side by side in a downloads
folder, where `subshell-darwin-arm64` next to
`Subshell-Client-Desktop.app.tar.gz` said nothing about which was the bare CLI.

The suffix is on the artifact name only. The installed binary is still
`subshell` — the install script still writes `./subshell`, and no CLI command,
data dir or service name changes.

**An existing instance must republish its node artifacts** (`bun run
release:node` with `SUBSHELL_NODE_ARTIFACTS_DIR` pointed at the directory the
server serves). Until it does, every agent download 404s: the server now looks
for `subshell-node-cli-<triple>` and the old files are still on disk under the old
names.
