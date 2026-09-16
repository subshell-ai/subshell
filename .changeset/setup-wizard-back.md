---
"@internal/server": patch
---

The first-run wizard can go back

Every screen rendered a Back slot the frame has always supported, and no screen
ever filled it — so skipping **Connect a Network** to reach the agent list was
irreversible short of restarting the wizard, on the one screen most worth a
second look: it is optional, easy to skip past, and it is where "open this on
my phone" is answered before a 403 on a sign-in page answers it instead.

Back now goes Add an Agent → Connect a Network, and Start Your First Subshell →
Add an Agent. It is disabled while an install or a launch is in flight, for the
reason Continue already was: a `curl … | bash` on this machine must not be
walked out of in either direction, or its progress line and any failure land on
a screen nobody is looking at.

There is deliberately no Back from the Network screen to the account screen.
The wizard advances past it only once sign-up has SUCCEEDED, so that form is
for an account that already exists.
