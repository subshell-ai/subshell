# Repointing vs re-enrolling: the full account

Moved verbatim from `apps/node/agent/AGENTS.md`, which keeps the operational
summary and routes here. Only cross-references into sections that moved were
repointed.

## Repointing vs re-enrolling

`enroll` is not the way to change a node's address. It overwrites
`config.json`, mints a SECOND node row on the plane, spends a single-use
24-hour setup key, and discards the node key whose only home was that 0600
file, none of which is what "the control plane moved" wants, and that move is
routine (it is what fixing a loopback `APP_BASE_URL` IS). `configure`
(`src/configure.ts`) makes the two maintenance edits that keep the SAME node
(`--server` rewrites the address, `--key` installs a rotated bearer secret in
place), and keeps the identity through both. The `--key` half exists because
the plane shows a rotated key exactly ONCE and there was nowhere to put it:
`enroll` would mint a second row and spend a setup key to correct one field,
and the only real path was hand-editing the 0600 file (the rotate screen even
pointed at a `subshell config` verb that has never existed). Both commands take
`--key` from the browser-facing `message` and the Nodes card, which is why
`normalizeNodeKey` refuses an `nsk_` setup key by name rather than storing the
wrong credential where nothing could later explain a dead connection.

**It clears `nodeWsUrl`, and that is the load-bearing part.** That field is what
the OLD plane reported about ITSELF at enroll (ledger 17c) and `resolveWsUrl`
PREFERS it over any derivation, so carrying it forward would leave the daemon
dialing the old host while `serverUrl` named the new one, a divergence no
surface displays. Cleared, `wsUrlFor(serverUrl)` derives from the address
actually configured; a plane behind a reverse-proxy subpath re-reports its own
ws URL at its next enroll. Renaming alone does not touch it: the address did
not change.

`resolveWsUrl` carries one exception to that preference since #225: a loopback
pin beside a REMOTE `serverUrl` is ignored and the URL derives. Every sanctioned
flow produces that combination only as residue (a reset kept the file, a manual
`serverUrl` edit skipped `configure`), and a remote machine dialing its own
loopback is a node that never connects. The one honest counterexample is a node
ON the server machine that enrolled through a LAN-spelled address, where the
default `HOST=0.0.0.0` made that enrollment reachable and an unconfigured
`APP_BASE_URL` answered it with a loopback pin: the bind later narrowed to
loopback makes that pin the only reachable endpoint, and deriving goes dark. The remedy is the sanctioned one, and it clears the pin as it
rewrites the address: `subshell configure --server http://localhost:PORT`.

`normalizeServer` is exported from `enroll.ts` and shared, so a repoint writes
the same spelling an enroll would; two commands disagreeing about one address
is the bug that shape prevents.

**It does not rename, and deliberately takes no `--name`.** `config.json`'s
`name` reaches the control plane in exactly ONE place, the enroll POST body
(`enroll.ts`), and is absent from `readyEvent` (`daemon.ts`) and the inventory
event. So writing it on a repoint would change what local `subshell status`
prints and leave the Nodes page showing the old name forever. Renaming is the
plane's own operation (`PATCH /api/nodes/:id`).

**It works only between two names for ONE plane.** The identity is kept, so a
genuinely different control plane holds no key bound to this node row and
`/ws/node` refuses the socket 401 (`node-ws-handler.ts`); the node goes
offline, with the reason only in its own log. Recovering means pointing it back
or enrolling with a setup key from the new plane. Joining a different plane is
an `enroll`, not a `configure`.
