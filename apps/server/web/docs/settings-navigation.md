# Server Settings: ten pages, one gated group

Deep dive for `apps/server/web`, moved verbatim out of `AGENTS.md`.
This file carries the full history behind the summary; the routing line in
`AGENTS.md` names when to read it.

**The admin surface is TEN pages behind one collapsible group** (spec
2026-09-11 grouped-navigation, spec 2026-09-24 §7): General (`/settings`),
Users (`/settings/users`), Auth (`/settings/auth`, the sign-in providers), API
keys, Plugins, Service, Networking, Updates, Status and Logs, listed in the
rail under **Server Settings** and gated as a WHOLE: a member's rail lists
none of them, and none of them renders for a member who types the URL. The
roster page moved INTO the namespace on 2026-09-14 and lost its read-only
member view with it: the roster exists so the sharing picker can name people,
and that reads `GET /api/users`, which is still instance-wide. Two of them
are read-only: `/settings` is where an admin CHANGES the instance, while
Status and `/settings/logs` are where they see what it currently IS and what
has happened to it.
