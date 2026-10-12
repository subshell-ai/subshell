# Repointing vs re-enrolling: the full account

Moved verbatim from `apps/node/agent/AGENTS.md`, which keeps the operational
summary and routes here. Only cross-references into sections that moved were
repointed.

## Repointing vs re-enrolling

An ordinary setup key creates a new node. A **Re-register** setup key from an
existing node’s settings instead replaces that node’s credentials and retains
its row, name, shares and settings. For the same node and control-plane signing
identity, enrollment preserves local debug and retention preferences, and it
uses the existing data directory unless explicitly overridden.

`enroll` with an ordinary setup key is not the way to change a node's address. It overwrites
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

## Live connection reload

The running daemon reads connection settings before each dial and on its
heartbeat. It validates the complete connection bundle before replacing the
live identity; malformed settings leave the current connection running. The
URL check must reject WebSocket fragments, including an empty `#`, and the
credential must be a valid HTTP header value. Validation failures must never
log the credential, including through a constructor's error message.


## Automatic direct connections

At startup and reconnect, a paired daemon probes its configured endpoint and up
to eight private IPv4 or mesh endpoints advertised by that same control plane.
`route-selection.ts` requires a gain of at least 20 ms and 20% before preferring
a different working route. It keeps a healthy socket in place: switching one
would interrupt terminal streams. A failed direct WebSocket gets a 60-second
cooldown, and a direct handshake has a 10-second deadline.

Discovery uses fresh sessions from the existing pinned-key link encryption.
The node key is inside the encrypted HTTP request, never an Authorization
header on an automatic probe. An authenticated reply supplies a one-use,
15-second upgrade ticket for alternative routes. The configured endpoint keeps
its existing Bearer authentication for proxy compatibility. The real WebSocket
still completes its ordinary encrypted handshake. A direct endpoint's close before that handshake cannot
clear the pin, request rollback, or supersede the daemon.

`<dataDir>/node-routes.json` holds address hints only, scoped to the node,
configured endpoint and pinned encryption identity. This lets a later boot try
previously advertised LAN addresses when the public endpoint is unavailable;
each hint must authenticate again. Discovery never overwrites `serverUrl` or
`nodeWsUrl`. A configure/re-enroll that changes that scope ignores the cache.
Older servers and unpaired nodes retain their configured connection behavior.
Browser connections, OAuth callbacks, downloads and pane callback URLs are
outside this selector.


### Docker regression fixture

`scripts/cli-e2e/node-routes-docker.ts` runs the real source server and enrolled
daemon on separate Docker networks, with a TCP proxy adding 80 ms each way to
the configured route. After building workspace packages with `bunx turbo build`,
run `bun scripts/cli-e2e/node-routes-docker.ts`. The default image is
`desktop-builder:local`; `ROUTE_TEST_IMAGE` can name another Linux image with
Bun and tmux installed.

The fixture checks LAN selection, public fallback after LAN loss, LAN recovery,
cached LAN access during a public outage, and rejection of a different server
that takes over the cached LAN address. Each scenario requires a fresh daemon
connection and an online runtime reported by the real server. The configured
address must remain unchanged. Accounts, credentials, databases and containers
belong to the fixture and are removed when it finishes; the repository is
mounted read-only and no live service is used. These measurements exercise
route selection under injected latency, not terminal echo or browser routing.
