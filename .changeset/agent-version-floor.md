---
"@internal/server": minor
---

Enforce a minimum agent version on `/ws/node`.

`MIN_AGENT_VERSION` (currently `0.3.0`) is checked at `ready`, BEFORE the
existing exact-protocol match, and an agent below it is closed with 4406 and a
reason naming both the required and the reported version. The agent relays that
reason to its own log, so the person on that host reads what to do rather than
a generic "protocol mismatch" naming a number that was not the problem.

**This can stop a previously working node from connecting.** An agent older
than 0.3.0 that speaks the current protocol used to be accepted and now is not.
Update the agent on that host (`subshell version` reports what it is running).

The two gates are independent: the floor states "this server needs newer agent
BEHAVIOUR" and moves on its own schedule, while the protocol match states "these
two ship together". A refused agent still has its identity persisted, so it
appears on the Nodes page with a "below minimum" badge, and Settings → Status
lists every enrolled agent under the floor in one place — a refusal happens at
connect, so such a node otherwise looks like an ordinary offline one.
