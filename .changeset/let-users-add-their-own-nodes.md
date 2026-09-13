---
"@internal/server": minor
---

Server Settings → General gains a switch for whether people other than admins can add their own machines as nodes. It is on by default and on every existing instance, which is the behaviour up to now: anyone signed in could mint a setup key and bring a machine in. Turned off, adding a node becomes an admin act — and because registering a node hands this instance command execution on that machine under its own user, that is a reasonable thing for an operator to want to hold.

Turning it off stops new setup keys being handed out; it does not revoke the ones that already exist. Those expire after 24 hours, or an admin can delete them on the Nodes page, which is the act that revokes. The settings card says so rather than leaving it to be discovered.

Admins are never affected, the same way an admin can create a user while sign-up is closed. Where someone cannot add a node, the button is not shown at all and the page says who to ask instead of offering something that would be refused.
