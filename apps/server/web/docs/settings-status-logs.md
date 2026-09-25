# Status and Logs: the two read-only admin pages

Deep dive for `apps/server/web`, moved verbatim out of `AGENTS.md`.
This file carries the full history behind the summary; the routing line in
`AGENTS.md` names when to read it.

`routes/settings_.status.tsx` (`/settings/status`, components in
`components/admin-status/`, data in `hooks/use-admin-status.ts`) is the model
for the gate the others copy: server-derived `viewerIsAdmin`, with `undefined`
counting as NOT admin: the query is `enabled`-gated on it so a non-admin
mount fires no doomed 403. It reads TWO routes: `GET /api/admin/status` for
the instance, and `GET /api/admin/server` for the **Locations** card, which
moved here from `/settings/service` on 2026-09-14 because it is the one
Service card carrying no act (the paths live only in the deployment view, so
the page mounts `useServerDeployment` beside `useAdminStatus`). It mounts it
at **60 s**, not the hook's 5 s default: `/settings/service` needs 5 s because
an operator watches it while changing the machine elsewhere, while this page
reads only paths that are fixed for the life of the process, and each poll
of that route is a `Bun.spawnSync` stall for the whole server, so inheriting
the fast cadence would triple the probe load for data that cannot change.
TanStack Query keeps `refetchInterval` per observer, so the two pages really
do poll one shared key at different rates. The two reads fail
independently, so each has its own banner and Retry, and neither failure
hides the other's cards; the Runtime card states the database SIZE only,
since Locations states the path once, copyably.

**The admin's two read-only logs are one tabbed page** (2026-09-20,
`/settings/logs`): the trail that owned `/settings/audit` is the Audit tab,
and the server's own log tail moved off Service for the System tab:
"what did it do" and "what happened to it" are one errand, and Service's
subtitle shrank to "Who supervises this server." to match. The tab is URL
state (`?tab=audit`; ABSENCE is System, so the plain path is the default's
address), the route owns the gate so both cards' queries are unconditional,
and the switch gates with the page: a member sees no tabs at all. The
System tab mounts `useServerDeployment` itself (the log card's debug switch
reads the view's `logging.source`, and the switch writes the fresh view back
into this same cache) at the Status page's 60 s and **only while its tab is
active**: every probe of that route is the same `Bun.spawnSync` stall, and
someone reading the audit trail has no business paying for it.
`AuditTrailCard` is KEYSET-paginated (page 25): the cursor is the page
above's last row as a `(createdAt, id)` PAIR (`beforeCreatedAt`+`beforeId`,
the route 400s a half-cursor) because two events can share a millisecond and
a one-column cursor would skip or repeat the tie; the client stacks the
cursors it has stepped through, so Newer pops back without re-deriving
anything, and a short page (not a count, which would cost a second query
per read) is what disables Older. `staleTime: 0` rides along from the page
era: mounting the trail is the only thing that refreshes it.
