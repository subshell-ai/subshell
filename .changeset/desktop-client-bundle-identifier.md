---
"@internal/desktop-client": minor
---

The bundle identifier is now **`dev.subshell.client`** (it was
`dev.subshell.node`), matching the app's name and its sibling's
`dev.subshell.server`.

macOS tracks an app BY its identifier, so a build installed under the old one is
a **separate app** to the system: it keeps its own settings directory, its own
notification permission grant, its own single-instance lock and its own saved
window state, and this build starts from defaults rather than inheriting them.
The enrolled node itself is untouched — that lives in the agent's own
`~/.config/subshell`, not in this app's settings. Delete the old
`Subshell Client.app` and, if you want the disk clean,
`~/Library/Application Support/dev.subshell.node`.

On Linux the settings directory moves from `~/.config/subshell-node` to
`~/.config/subshell-desktop-client` — deliberately NOT `~/.config/subshell`,
which is the agent's own config home.
