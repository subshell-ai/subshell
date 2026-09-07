---
"@internal/desktop-client": minor
---

Published artifacts now say **Desktop** in their names:
`Subshell-Client-Desktop.app.tar.gz` and
`subshell-client-desktop_<version>_amd64.deb`.

Both CLIs ship from the same repo, so the old names sat in a downloads folder
next to `subshell-node-cli-<triple>` — the bare node agent — with nothing to say which
was the application.

The suffix is on the file name only. The installed app is still
`Subshell Client.app`, with the same window title, menu bar and bundle
identifier, so an existing install upgrades in place.
