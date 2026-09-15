---
"@internal/server": minor
"@internal/node": patch
---

The Service page answers "will this survive a reboot?" instead of offering a switch.

Server Settings → Service was designed inside the Subshell Server app and then
shown to every browser, which put a choice on screen that most machines cannot
make: a headless Linux box was offered "With the Subshell Server app", disabled,
under a note telling you to go change it in an app that machine does not have.
And the control beneath it, **Start at login**, asked the wrong question. It
reads as being about a desktop login; an operator who does not want a GUI thing
switches it off and discovers at the next reboot that their server is gone.

Worse, on Linux that switch was never the whole answer. A `systemd --user`
service runs inside its owner's login session, so an *enabled* unit still stops
the moment that user logs out — unless the account **lingers**. The fix is one
command, `loginctl enable-linger $USER`, and nothing in the app had ever told
you whether your machine needed it. The installer printed the advice once, to a
terminal, on a machine most people never open a terminal on.

So in a browser the card now states one fact — *comes back after a reboot,
without anyone logging in* / *comes back when you log in, and stops when you log
out* / *will not come back after a reboot* — and offers a remedy only when the
answer is unsatisfying: the lingering command, a **Start automatically** button,
or the install command. Lingering is now measured rather than guessed at, so the
page says which machine you have instead of explaining both. Inside the Subshell
Server app nothing changes: there the choice is real, the vocabulary is native,
and the radios, the confirmation dialog and the login switch all stay.

A node's Runtime card answers the same question in the same words, with the
caveat it used to print for every Linux node replaced by that machine's own
answer. `subshell service status` and `subshell-server service status` report
it too, and the installer now mentions lingering only when you actually need it.

Enrolled nodes have to be updated for this one. Reporting the fact needed a new
field on the wire, so the node protocol steps to 9 and the minimum agent version
to 0.7.0 — an older agent is refused at connect, as at every previous bump. Cut
and publish the `node-v0.7.x` release before anyone reaches for the enroll
download: until it exists the server has no agent binary it is willing to fetch.
