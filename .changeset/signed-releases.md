---
"@internal/server": minor
"@internal/node": patch
---

Signed releases: the update paths stop trusting the release source (spec 2026-09-17). Every release now carries `release-manifest.json` plus a detached minisign signature over its exact bytes (`release-manifest.json.sig`), made with the same publisher keypair the desktop apps' updater uses — one key now guards all four components — and every install digests come from the manifest's signed `assets` map instead of the release source's `.sha256` sidecar. `subshell update`, `subshell-server update`, the dashboard's Server and node update flows, and the downloads route's lazy artifact fetch all verify the signature against a pubkey compiled into the product before anything is downloaded or replaced, and an unsigned or unverifiable release is refused by name rather than offered. `update --from` stays signature-free — a file the operator named is their decision.

Node protocol 12: the `update` command carries the verified manifest and its signature, and the agent re-verifies both against its own compiled-in key before swapping, so a node's trust is the publisher's, not its plane's. Agents below protocol 12 are no longer sent update commands at all (they would ignore the new fields); the Nodes and Updates pages say so and name the by-hand verb. Server and agent must ship together: this node release is 0.11.1, one patch above the new `MIN_AGENT_VERSION` floor of 0.11.0.

Operator action: `release.yml` now refuses every CLI shard, not just the desktop ones, when `TAURI_SIGNING_PRIVATE_KEY` is unset, and the publish job merges the per-shard manifests into one signed release manifest.
