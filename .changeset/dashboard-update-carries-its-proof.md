---
"@internal/node": patch
---

An update started from the node's own loopback dashboard can no longer be refused by a stale fact. During the daemon's boot window the page re-proves supervision with one live service-manager query and now carries that answer into the executor, instead of the executor re-reading the same boot-time report — still null — and answering "not supervised" to a node the page had just proved supervised. A caller with no proof, which is every plane-commanded update, keeps the old refusal exactly.

The force option now states its own limit: a downgrade the control plane will not accept leaves the node held offline for about ten minutes and is then reversed automatically, so the card says that beside the checkbox instead of letting the success line imply a durable downgrade.
The same threading now covers the service card. With no daemon in the process — the standalone dashboard — the service route decided pane safety from a fresh manager read but used to word its refusal from the daemon report the route had just fallen back past, so a machine whose fresh read answered `unknown` ("nobody could read the definition") got the CERTAIN sentence ("would close every subshell"). The resolved report's `paneSafety` now rides to the wording, exactly as the update route's proof already does; a `kills` answer keeps the certain sentence, and a `liveRuntime` test seam pins both halves.
