# A node's page: structure, gates, maintenance

Deep dive for `apps/server/web`, moved verbatim out of `AGENTS.md`.
This file carries the full history behind the summary; the routing line in
`AGENTS.md` names when to read it.

**A node's page mirrors the Service page's behaviour, where a node has the
same question.** Same follow/pause log at one second, same focusable scroller,
same debug switch, same spinner while a restart lands, and `useNode` polls at
5 s: for the change no action on that page causes, the node going offline.
That poll is affordable in a way the server's is not: `GET /api/nodes/:id` is
DB reads plus an in-memory registry lookup, where `GET /api/admin/server`
spawns `netstat` and the service manager synchronously and needs a memo behind
it. Every node mutation writes back or invalidates; `useNodeLogSlice`
deliberately does not (a byte-range read driven by card state).

Two ways this page deliberately departs from the client's model. There is no
supervision card: Subshell Client has no supervisor, so a node has no "the app
runs it as a child" mode to choose. And the Control plane card left this app
entirely (2026-10-09, the operator's call): the plane cannot see which address
a node dials, so its one field could only stand blank; repointing lives on the
node's own dashboard and the CLI, where the current value is actually known.

**Maintenance is one flag on the node, and the SPA writes it in one place.**
`NodeMaintenanceCard` sits on every node's Overview (`local` has no other
section) and replaced `LocalLaunchCard`, which was never a switch: ON was the
seeded Everyone/`edit` grant and OFF was its removal. Turning it on stops every
subshell on that machine, other people's included, so the confirmation names a
count: `runningSubshells`, which rides the DETAIL view only and only for a
manager. The Nodes LIST has no such number, which is why `node-list-row.tsx`
exists: it fetches the detail through the query cache at the moment the menu
item is picked, and hedges the prompt rather than refusing the act if that read
fails. `useSetNodeMaintenance` invalidates the subshell list beside the two
node keys, for `useRotateNodeKey`'s reason: rows went `terminated` the instant
it answered. Its response is a `MaintenanceResult`, not a node view, and both
callers SURFACE the `failed` array: a subshell whose kill the node refused is
deliberately not in `stopped`, and everything else on screen (the switch, the
badge, the menu item) moves as if the flip were clean, so dropping it tells
someone a machine is quiet while panes are still alive on it. The wording is
`lib/node-maintenance.ts`, once, for the card and the row.

**The node page is Overview + two daemon sections, and the rules live on the
Overview.** `managesNodeSections` (`node-section-nav.tsx`: an AGENT machine
AND an `owner`/`edit` viewer) hides the Service and Logs tabs and gates their
deep links. Hiding a pill never gated the URL: once the sections were flat
routes (2026-09-20), `/nodes/local/service` was typeable and answered with a
card calling the LIVE control plane "offline, nothing to report". The server
remains the enforcement (400 for `local`, 403 for `view`); the redirect
exists so the page never lies about a refusal. There is NO Configuration tab
anymore (2026-09-21), and the Server-URL card left the Overview too
(2026-10-09), so the allowlist card (its editor self-gates on `canManage`,
`local` included) is the one rule standing beside the Maintenance switch.
Machine facts, machine rules, one page; the tabs are for driving the daemon.
The harness card's Re-check gate is spelled like `managesNodeSections` and is
a DIFFERENT rule
(its own comment says so). Do not collapse them. The Overview also carries an
Update card (`node-update-card.tsx`) behind the same `managesNodeSections` rule,
driving the same `POST /api/nodes/:id/update` the Updates table rows use; that
route also answers 409 when the node already runs the newest release this server
can offer, rather than reinstalling the same binary. The Update and Re-check buttons
read the node's LINK state, not just permission (the server's own `canUpdate`
rule): an ONLINE node or a HELD one (offline but its socket still answers the
`update` command) can take an update, so its button stays live and the card says
why the offline label is not the whole story; a node that is simply gone
(offline AND not held) has its Update and Re-check buttons DISABLED with the
reason, because a control that can only 409 from a state already on screen is a
lie, not a choice. Held turns it the other way for Re-check: detection needs a
live socket, which a held link drops, so Re-check is disabled there.

The agent node's Overview offers **Re-register**, replacing the Rotate key card.
Its owner or any admin can generate the single-use setup key (`canRetire`, the
same gate as Delete, ruling 2026-10-09); an admin's mint is stored under the
node's owner, so recovery still lands on that person's machine. The shared setup
instructions lead with Desktop App, and the key also remains in Setup keys until
redeemed or expired. Minting leaves the node connected; redemption keeps its
registry entry and replaces its machine credentials. See [the recovery
procedure](../../../docs/content/docs/nodes/desktop.mdx).
