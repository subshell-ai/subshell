---
"@internal/desktop-server": minor
---

The bundle identifier is now **`dev.subshell.server`** (it was
`dev.subshell.desktop`), matching the app's name and its sibling's
`dev.subshell.client`.

macOS tracks an app BY its identifier, so a build installed under the old one is
a **separate app** to the system: it keeps its own settings directory, its own
notification permission grant, its own single-instance lock and its own saved
window state, and this build starts from defaults rather than inheriting them.
Delete the old `Subshell Server.app` and, if you want the disk clean,
`~/Library/Application Support/dev.subshell.desktop`.

On Linux the settings directory moves from `~/.config/subshell-desktop` to
`~/.config/subshell-desktop-server` — deliberately NOT
`~/.config/subshell-server`, which is where the `subshell-server` CLI keeps its
own `config.env`.
