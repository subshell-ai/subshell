---
"@internal/server": minor
---

Fetch a missing node agent binary instead of 404ing.

A server installed from a release tarball has an empty node-artifacts
directory, so the "Add a node" install command failed on every machine until
someone ran `bun run release:node` from a checkout or copied files in by hand.
The repository is public now, so the server reads the same release it was
telling you to copy from.

It is lazy on purpose. Nothing is downloaded until a machine actually asks for
that platform, so a fleet that is all Linux never spends anything on the macOS
builds, and an instance nobody enrols against never touches the network. The
first install on each platform takes a little longer while the download
happens; later ones are served from disk.

The bytes are checked against the digest the release publishes as they stream
past, and a mismatch fails the download rather than caching bad bytes. When a
newer release appears, binaries this server downloaded from an older one are
removed; anything you published yourself is left alone.

Set `SUBSHELL_NODE_RELEASE_URL` to point somewhere else, or to empty to turn
downloading off entirely — an air-gapped instance behaves exactly as before,
warning included.
