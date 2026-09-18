---
"@internal/desktop-server": minor
"@internal/desktop-client": minor
"@internal/server": patch
---

One press updates a desktop app and the CLI it ships.

Each desktop bundle carries the CLI it wraps, so "update the app" and "update
the server" were never independent — the second was the tail of the first, and
being asked to do them separately made our packaging your problem. It also
looped: updating the app left the next launch asking for the server again.

Both apps now have ONE update screen that does both, in two phases across the
relaunch. A marker written before the restart is finished by the new build at
boot, so a failure leaves a machine that knows what it was doing rather than a
half-updated one. Subshell Client's phase 2 additionally **offers the restart
it used to stay silent about**: installing the agent never stopped the daemon,
so the machine kept running the previous version with nothing on screen saying
so.

On Server Settings → Updates, inside Subshell Server the app and the server it
ships are one row with one control, both version pairs in the real columns, and
Re-check moved to the card header where its behaviour always was. A browser is
unchanged — nothing there can install anything on a machine the page is not
running on.

Also fixes a pane title that could name a subshell after a terminal escape
sequence: an agent's image-support query arrived in the sidebar as
`Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA`, because the cleaner removed the two
characters identifying the text as not a title and kept the rest.
