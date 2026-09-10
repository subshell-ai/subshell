---
"@internal/server": patch
"@internal/node": patch
---

**Breaking:** the node agent no longer holds plugins, and its plugin machinery is gone. `subshell plugin install|update|uninstall|list` and `subshell configure --registry-url` are removed (the verbs now refuse as unknown commands), as are the `plugin_install`/`plugin_uninstall` signed command handlers: the control plane still parses the two wire shapes at protocol v2, and the agent answers them `unsupported` until the protocol drops them.

Harnesses live on the control plane now. A launch carries the plane-built argv plus a binary-lookup rule, which is all this machine needs (its directory allowlist still gates the launch locally), and `detect` is a command the plane sends rather than a scan the node runs. The periodic inventory event carries no harness list anymore, and the control plane's `detect` cache survives it.

A `plugins/` directory left in an agent data dir by a previous version is inert residue: this release neither seeds, refreshes, nor deletes it. An older `config.json`'s `registryUrl` key is dropped on the next rewrite.
