---
"@internal/desktop-server": minor
"@internal/desktop-client": minor
---

Both desktop apps update themselves, and the CLI they install goes through its own `update`

Two separate things could be out of date on a machine running one of these
apps, and until now only one of them had an update path at all.

**The app.** Each app checks the project's own release list once a day on
launch — and never opens a window to say so: the only thing that changes is a
tray item, which grows "(0.7.0 available)". **Check for Updates…** is there
whether or not that check has run, and it opens an assistant screen that
downloads, verifies and installs, then relaunches. The bytes are refused
unless they carry a signature matching a public key compiled into the app, so
a compromised release host can withhold an update but cannot supply one. On
Linux the package goes through dpkg, and the screen says so before the press
rather than raising an unexplained password sheet. `SUBSHELL_RELEASE_URL`
repoints the source and an empty value turns it off entirely.

**The CLI each app ships.** Replacing the installed `subshell-server` (or
`subshell`) no longer copies a file: the app hands the bundled binary to the
INSTALLED one's own `update --from`. That makes the desktop path the same
transaction as every other — the database is backed up first, `.previous` is
kept, and a server whose migrations fail reverts at boot — where before it was
the one update on the machine with nothing behind it to roll back to. The
screen now names what moved and where the backup went. A first install is
unchanged; so is the second step, which is still the app's to take.

One consequence worth knowing: a server older than the `update` verb cannot be
replaced this way, and that is deliberate rather than handled. A silent
fall-back to the old copy would skip the backup while reporting success, which
is worse than the CLI's own error.
