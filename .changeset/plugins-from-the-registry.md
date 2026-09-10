---
"@internal/server": minor
"@internal/node": minor
---

Harness plugins can now be installed from an npm registry.

Until now a node could only offer the harnesses compiled into its own build. A plugin install may now name a package instead: `subshell plugin install @acme/plugin-thing`, or the same name passed as `spec` to `POST /api/nodes/:id/plugins`. The bytes are fetched, verified against the registry's own integrity hash, unpacked by a reader that refuses symlinks, hard links and path traversal, and loaded once in a scratch directory before anything on disk is replaced. A failure at any of those steps leaves the previous install exactly as it was.

Built-ins still come from the build. Naming one without pinning a version, or pinning the version this build already carries, installs the embedded copy and never touches the network, so a first run still works offline. Pinning a different version does go to the registry, and if that version does not exist the install fails rather than quietly handing you the embedded one.

The node agent grows four verbs: `subshell plugin list`, `install`, `uninstall` and `update`. `update` only touches plugins that came from a registry, and says so for the ones it skips; a built-in is never upgraded out from under the operator. A registry install records where it came from in an `install.json` beside the plugin, which is what `list` and `update` read.

Two ways to point at a mirror instead of npmjs.org: `subshell configure --registry-url <url>` on a node, and `SUBSHELL_PLUGIN_REGISTRY_URL` on the control-plane host, which `subshell-server status` now prints.

Installing a plugin is still owner-only, and the first-run setup window still installs built-ins only.

**This requires upgrading agents and the server together** (node protocol v2).
