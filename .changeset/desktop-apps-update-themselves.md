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

A CLI older than the `update` verb — which is every one installed today — falls
back to the plain copy it used before, and the screen says what that cost:
*"Installed 0.7.0 over 0.6.0. No database backup was taken: the previous server
predates the update command, so this install cannot be rolled back
automatically."* (The node app's says "No rollback point was recorded": an
agent has no database, and claiming a missing backup would be alarming about
something that was never going to happen.)

The fallback fires on exactly one thing — the CLI's own `unknown command
'update'`, on a run that finished and failed. A pane-safety refusal, an
unwritable binary, a digest mismatch or a version the file does not confirm is
still a failure, because copying the file anyway would skip the backup while
reporting success.
