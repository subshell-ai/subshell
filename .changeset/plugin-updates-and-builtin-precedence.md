---
"@internal/server": minor
---

Plugins installed from npm can be updated from Settings → Plugins, one at a time or all at once, with a server restart offered after the admin is done. Built-in plugin ids now resolve to the newer of the bundled and installed copies, gated by the plugin's `subshell.apiVersion`; a server upgrade no longer downgrades a newer installed copy.
