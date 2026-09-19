---
"@internal/server": minor
---

A QR code for any subshell or workspace

Both action menus now carry **QR code…**, which shows a code for that
subshell or workspace. Scan it and the thing opens on your phone.

It uses the same address picker as Subshell for Mobile, and for the same
reason: the address your browser is on is very often `localhost`, which the
phone in your hand cannot reach — so it offers every address the instance
accepts a sign-in from, rather than asking you to retype a tailnet hostname
and a uuid on a phone keyboard. No PWA install steps here; those stay with
Subshell for Mobile, in the sidebar.

It grants nothing: the link is the URL you already have open, and whoever
scans it still meets the sign-in page and that subshell's own sharing rules.
