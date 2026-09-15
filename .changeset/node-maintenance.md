---
"@internal/server": minor
"@internal/node": patch
---

Nodes can be taken out of service without being unenrolled.

Until now the only way to stop subshells landing on a machine was to remove
someone's access to it, which meant the control-plane host had a switch nobody
else did — and that switch was really share surgery wearing a toggle's clothes.
There was no way at all to say "this machine is busy being worked on, send it
nothing for an hour."

**Maintenance** is that, on every node including the server's own. A node in
maintenance stays enrolled and keeps answering everything else — service
control, logs, detection, restart, config — and simply takes no new subshells.
Turning it on stops the subshells already running there, so the confirmation
names how many and warns that their owners are told; those owners get a push
saying the machine went into maintenance rather than a crash notice.

It can be set from either end. In the browser it is a switch on the node's page
and an item in the Nodes list menu, owner-only (an admin for the server's own
host). At the machine it is `subshell maintenance on|off|status` — useful when
you are already at the keyboard, and the only option when the plane cannot
reach the node. Whichever end moved last wins, and the node's page says which
one it was.

A node in maintenance stays visible in the launch picker, greyed and labelled,
rather than disappearing: it is a machine with a reason and a way back, and one
that vanishes just looks lost. Trying to launch there anyway now says the node
is in maintenance instead of failing with a server error.
