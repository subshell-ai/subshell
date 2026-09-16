# Security Context

> **The authoritative threat model is [`docs/security.md`](../../docs/security.md).**
> This file is the working summary that loads into an agent's context: the rules
> to code by, and the decisions not to "fix". When the two disagree,
> `docs/security.md` is right and this file is stale — say so rather than
> reconciling silently.

This is a **local / trusted-network service** designed to run on a developer's machine or
within a trusted local network (VPN, WireGuard, Tailscale, SSH tunnel). It is not
internet-grade.

## Authentication

Authentication **is required** on all `/api/*` routes except auth and setup-status. Two
credential kinds:

- **better-auth session cookie** (email/password, HttpOnly, `SameSite=Lax`) — the browser
  path and the only path allowed on admin surfaces. The first registered user becomes the
  admin; registration is gated by a settings toggle that is **closed by
  default**. An absent `allow_registrations` row means open ONLY while the
  instance has no users at all — the first account is how an admin comes to
  exist, so a closed empty instance could never mint the one person able to
  open it, and a fresh install would be bricked behind a sign-up form that
  refuses. The door is open exactly until someone walks through it, and closes
  behind them; an admin who wants it open afterwards says so explicitly, and
  that is audited. It still FAILS CLOSED on a corrupt or non-boolean row, and
  the no-users carve-out is not a way back in for that. One function decides
  it (`services/registration-gate.ts`) because three surfaces act on the
  answer — better-auth's `before` hook, the admin switch, and the sign-in
  page — and reading the row separately is how they come to disagree.
  - *Passkeys* (WebAuthn, `@better-auth/passkey`) mint the SAME session cookie — an
    additional browser credential per user/device, never a second factor. The rpID is
    the **configured `APP_BASE_URL` host** (better-auth 1.7.1 derives it from the
    static baseURL, not the request host), so passkeys work only when browsing on
    that address — other names (e.g. loopback vs the domain) fail in the browser.
  - *Break-glass*: while `SUBSHELL_EMERGENCY_PASSWORD` is set, an admin signing in with that
    exact value has **their credential overwritten** by it and a real session is minted —
    destructive by design, signalled by a warning banner to every signed-in user
    (`GET /api/settings/public → emergencyLoginActive`). Clear the var after recovery.
- **Bearer API keys** (`Authorization: Bearer subshell_...`, via `@better-auth/api-key`) —
  machine credentials:
  - *Per-subshell tokens*: minted when a subshell starts (7-day TTL, self-extending
    for long-running agents), scoped by permissions, and **revoked immediately**
    when the subshell is terminated/deleted (restart rotates the key — auto or
    manual — on the same row). This is what the
    `subshell mcp` server and any harness tooling authenticate with.
    Harness **self-report** surfaces (`POST /api/subshells/:id/attention`,
    `POST /api/subshells/:id/harness-session`) accept only the subshell's
    OWN key acting on its OWN row — a harness can report its state, never
    another's; a forged session id merely selects an existing transcript
    the pane's user could already read.
  - *System keys*: long-lived, no permission ceiling, owned by the `system` service user,
    created by admins under **Server Settings → API keys** (plaintext shown exactly once;
    only a hash is stored). Treat them as full-access bearer credentials — disable/delete
    revokes instantly.

Admin-gated routes (`/api/users`, `/api/system-keys`, `/api/admin/status`, the
`/api/admin/server` group, …) **reject bearer keys** (403): machine credentials can
never manage the instance. That names the WRITES on those paths. `GET
/api/users` is the exception worth stating: the roster read is instance-wide
by design — it is what lets the sharing picker name people — so any signed-in
caller and any bearer credential, a running subshell's own token included,
reads every account's email, display name, role and disabled state
(`docs/security.md` §3).

**An admin reconfigures and restarts the server from the dashboard** (spec
2026-09-12): `PATCH /api/admin/server/config` rewrites config.env (port, bind
address, public base URL, trusted origins — never `DATABASE_PATH`, never the
auth secret) and `POST /api/admin/server/restart` exits for the service manager
to respawn. Both cookie-admin only, both audited (`server.config.update` with
`{key, from, to}`, `server.restart` with `forced`). Four things hold it
together, and each is load-bearing:

- **The restart is refused unless the manager reports THIS pid**
  (`state === "running" && pid === process.pid`). A hand-run server, a
  `bun run start`, a container with no init: `restart.available` is false and
  the route 409s. There is no way to exit a server into nothing.
- A second refusal when the service definition would take the tmux panes down
  with the process, unless the body carries `{ force: true }`.
- **The validator is SHARED with the CLI, not mirrored.** Both call one
  `applyConfig`, so there is no second implementation to drift — that shared
  call, not a test, is what keeps the `TRUSTED_ORIGINS` rules below true of
  this writer. The route's test pins that the write lands, that keys this tool
  does not own survive verbatim (`BETTER_AUTH_SECRET` above all), and that the
  audit metadata holds no secret; it does not diff against a CLI-written file.
- A key whose source is `process env` is refused (409), never written: a file
  write the next boot would mask is a success report for a change that never
  happens.

**Stop, start, install, uninstall and reset have no route, deliberately** —
each leaves the server unreachable, so a page the server serves is the wrong
place to drive them. They stay with the CLI and the desktop assistant.
**`POST /api/admin/server/autostart` is inside that rule, not an exception**:
arming or disarming start-at-login touches nothing about the running process
(`systemctl --user enable|disable` without `--now`; on macOS the plist MOVES
between `~/Library/LaunchAgents` and the config home, and the loaded job does
not care), so the page asking for it cannot take itself down. Cookie-admin,
audited `server.autostart.update`, 409 where the question has no answer.

**Admin user management** (spec 2026-09-05): an admin may create users, assign
roles (`PATCH /api/users/:id/role`) and **reset another user's password**
(`PATCH /api/users/:id/password`). Four guards, all load-bearing:
demoting the LAST admin is refused (counted and written in ONE transaction, or
two concurrent demotions both pass and nobody can administer the instance); a
reset REVOKES every session the target holds (a reset that leaves live cookies
is useless against a compromised account) — but NOT passkeys, which live in
their own table, and NOT already-connected WebSockets, which authenticate only
at connect, so a reset is a credential rotation and not a session-kill switch
(docs/security.md §11.5); an admin cannot reset their OWN
password there (Account requires the current one — otherwise an unlocked laptop
is a full takeover); and the `system` service account is untouchable. The
password is never logged, echoed, or audited — only that a reset happened and
how many sessions it cut. User DELETION is deliberately absent.

`GET /api/admin/status` is the widest of these READS — versions, host paths, the
resolved MCP command, instance-wide counts and the security posture in one
body. It carries **no secret in any form**: the auth secret appears only as
`usingPlaceholderSecret`, the break-glass password only as
`emergencyLoginActive`, and a test scans the serialized response for the actual
values so a field added later cannot regress that. Treat an admin's screen as
quotable — it is the thing that gets screenshotted into an issue.

WS attach requires a short-lived (30 s) single-use token minted through an authenticated
REST call — replay-resistant.

**One anonymous read exists** (spec 2026-09-08): `GET /api/settings/instance`
returns `{ instanceName }` — the operator-chosen name for this control plane,
or the host's own name when unset — to a caller with **no credential at all**.
It is the only pre-auth read outside the first-run setup window, and it exists
so the sign-in page can say which plane is asking for your password; on a
posture where several instances answer on one VPN, that is a security property
rather than a leak. Two things keep it narrow: it lives in its own route module
(`api/settings-public.route.ts`) precisely because `authGuard` is scoped to the
whole settings group, so nothing about `GET /api/settings/public` —
`viewerIsAdmin`, `appBaseUrl`, `nodeArtifactTargets` — is anonymous; and a test
asserts the response's ENTIRE key set, so a field added later cannot go
anonymous by accident. The value is normalized on the way out as well as in, so
a hand-edited row cannot put control characters into a log line.

**Naming a node is an admin act on exactly one row.** The control-plane host's
`local` node is renameable (`PATCH /api/nodes/:id`, cookie-only); its
`canManage` already resolves to admin, so no permission concept was added.
**Renaming an enrolled agent stays owner-only** — an admin's instance-wide
`edit` still does not confer it. Node names are normalized like every other
label, because a node name reaches log lines and menu labels.

## Subshell sharing (spec 2026-08-31)

A subshell is **private to its owner by default** — it is absent (404, never 403) from
every other user's list, detail, log, terminal, and workspace-pane path, so ids cannot
be probed. The owner may grant two levels, to **Everyone** (all signed-in users) or to
specific users, via `PUT /api/subshells/:id/shares`:

- **view** — read only: list, detail, pane log, and a read-only live terminal.
- **edit** — view + interact and manage: terminal input, rename, restart.
  (Spec 2026-09-03 shed notes, the title pin, and human-facing terminate from
  the action set; Close = delete, which stays owner-only.)

Owner-only actions (never conferred by a grant, and not held by an admin either): **delete**,
**managing the shares themselves**, and the **notification bell**. Sharing is a browser
(human) act — a bearer/subshell key is refused on the shares routes and, on every other
per-subshell route, runs with the admin boost and shared grants switched **off**, so
a machine token can act only on its own owner's subshells, never a foreign or
shared one.

**Everyone attached to a shared subshell sees everyone else attached.** The
`viewers` frame carries, to every viewer including a `view` grantee, each
other device's chosen name (`lib/device-name.ts` — defaulted from the
User-Agent, so "Safari on iPad", never a fingerprint), the grid it can
display, when it attached, whether it is being rendered, and whether it may
type. That is a real widening: before, a grantee could not tell whether anyone
else was watching. It is deliberate — a pane has ONE size and is sized to the
smallest visible viewer, so "why is my terminal 80 columns" is unanswerable
without it — and it is sound on the trusted-network posture, but it is a
disclosure to everyone the owner shared with, not only to the owner. A
device's name is chosen client-side and re-normalized server-side
(`normalizeDeviceLabel`), so it cannot carry control characters into another
user's screen or a log line.

Admins hold instance-wide **edit** (effective operator access) — they can read and
interact with any subshell but cannot delete it or re-share it; those stay with the real
owner.

Notifications are **owner-targeted**: a push goes only to the subshell owner's devices,
gated by a per-user master switch (`user_meta.notify_enabled`, on by default) and the
per-subshell bell (`subshells.notify`, on by default for new subshells). Sharing
widens who can *see/act* on a subshell; it never widens who gets *pushed* about it.

This is a deliberate widening of exposure beyond the owner, sound only on the
trusted-network posture below — a share makes a subshell's full pane output (potentially
secrets on screen) and, at `edit`, its keystroke stream visible to the audience. Revoke by
clearing the grant (the sharing dialog or an empty `PUT`).

## Pane logs (the session transcript on disk)

Every subshell's pane is streamed by `tmux pipe-pane` into
`<SUBSHELL_SERVER_DATA_DIR>/subshells/<id>.log` (on the NODE's disk for a remote
subshell). A terminal echoes, so this file holds what the operator TYPED as
well as what the commands printed — pasted tokens included. It is the most
sensitive thing the app writes, and it is deliberately **not encrypted**: the
key would sit on the same host under the same OS user that can already read the
log, so permissions and retention are the real controls.

- Files are **0600**, created that way by the `umask 077` inside the pipe-pane
  command (`TmuxRunner.pipePane`) — tmux's shell creates the file, so there is
  no mode argument and no chmod without a window. The directory is **0700**
  (`LocalLauncher`). Boot repairs both for logs written before this
  (`services/pane-log-hygiene.ts`).
- Logs of non-running subshells are swept after `SUBSHELL_LOG_RETENTION_DAYS`
  (default 30; `0` = keep forever) by an hourly pass. Deleting a subshell still
  unlinks its log at once. **A running subshell's log is never swept** — it is
  the live replay buffer.
- Typed input also transits **argv** (`send-keys -l -- <input>`), one process
  per frame, so a paste is one argv element and `ps`-visible. Same accepted
  risk class as the bearer token.

Do not add a code path that copies pane content anywhere else (a log line, a
notification body, a diagnostic dump) without deciding its lifetime first.
`SUBSHELL_ATTACH_DEBUG=1` is the one exception and it is off by default.

## The server's own log file (spec 2026-09-12)

The server writes `<SUBSHELL_SERVER_DATA_DIR>/logs/server.log`: one file, JSON
lines, **0600 in a 0700 directory**, **capped at 200 KB and replaced when
full** (truncated and started over), the same on every platform. Nothing is
kept in memory, request lines included. Note the asymmetry with pane logs:
those are swept by AGE, this is bounded by SIZE and never swept, so it lives
as one file for the life of the instance.

Two disclosures, both deliberate and both narrow:

- **An admin can read it over HTTP** (`GET /api/admin/server/logs`). The set of
  people who may read it is unchanged — 0600 on disk, cookie-admin on the wire
  — but the set of PLACES they can read it from now includes a browser on the
  LAN.
- **In debug mode it holds request paths**, and a path can carry a secret
  (`GET /install.sh?key=nsk_…`). That text already landed in access logs and an
  admin can mint setup keys anyway, so this widens nobody's reach — but it is a
  NEW READER of it. Say so rather than glossing it.

**Debug logging is off by default**, is an instance setting applied LIVE (the
file transport's level is flipped, no restart), and is audited. Request lines
are emitted at `debug`, so they reach this file only while it is on and
**never** reach the service manager's log, which stays pinned at `info`. The
polled routes are in the plugin's `ignore` list or a debug session fills the
cap with the Service page asking after itself. `SUBSHELL_DEBUG_LOGGING=1`
forces it on and makes the setting read-only — the environment wins, as it does
everywhere else on the config ladder — and only truthy spellings force:
`SUBSHELL_DEBUG_LOGGING=0` is a variable somebody left behind, not the
environment saying "off".

## Trust disclosure in the UI

Two exposures are invisible from looking at a terminal, so the UI states them:
a subshell running on an **agent node the viewer does not own**, and a
subshell that is **shared**. Both render a permanent amber icon in the
subshell's chrome (`components/trust-indicators.tsx`, reason on hover) and a
one-time banner (`components/trust-notice-banner.tsx`, 5 s then fades, keyed by
the exposure so widening a share re-raises it).

The banner is dismissible and has a per-device off switch; **the icon is not
suppressible**. Keep that split — silencing an interruption is a legitimate
preference, silencing the disclosure is not. The `local` node deliberately does
NOT raise the node notice (every non-admin has `edit` on it via the Everyone
grant, so it would fire always and be learned as noise).

## Encrypted channels (cross-subshell comms)

Channel posts are sealed per-recipient with ECDH-ES + A256GCM (`jose`) to each subshell's
identity keypair; the backend stores and forwards only opaque ciphertext it cannot read.
The E2EE boundary protects message bodies from **the server's storage, backups, and any
remote peer that compromises them** — and from other subshells that are not channel
recipients. It does NOT protect:

- **Metadata** — channel names, membership, post timing/order, message sizes, and
  principals are plaintext on the server.
- **A local OS user on the host** — subshell keypairs live on the same disk the backend
  runs on; whoever owns that user account can read them (and the harness panes).
- Subshell tokens themselves: a running harness holds its own bearer key by
  design — and the token is part of the tmux start command, so it is visible to
  any local process that can read `ps` output or tmux's pane metadata.

## Nodes (remote execution hosts)

Registering a node (spec 2026-08-31) delegates **arbitrary command execution
under the agent's OS user** to the control plane, and delegates pane I/O for
subshells launched there to everyone those *subshells* are shared with. Node
shares and subshell shares are two independent axes:

- **Any node share — even `view` — lets the grantee launch their own subshells
  on it**; those subshells stay invisible to the node's owner unless separately
  shared. `edit` (or owner) additionally configures the node (re-checks), and
  shares and rename stay owner-only — admin for `local`. Plugins are no longer
  a node axis at all (spec 2026-09-10): nodes execute, they do not install.
  The owner controls everything launched there; whoever owns the
  node's OS user owns every pane the backend launches on it, including its
  files.
- Command signing (§4) proves authenticity, freshness and target — **not**
  confidentiality (that is WSS/operator TLS) and **not** resilience to
  control-plane compromise: the signing keypair rules every enrolled node, so
  **a control-plane key compromise is all nodes** (the signing key lives on the
  backend host — same local-user exposure as everywhere else here).
- A **node API key can do nothing on REST** (explicit guard rejection, §5.5);
  its blast radius is exactly "impersonate this node on `/ws/node`".
- **The plane drives a node's service manager, reads its log and can repoint
  it** (`/api/nodes/:id/service`, `/logs`, `/config`; spec 2026-09-12, node
  half). Most nodes are headless, so a browser is the only place these can be
  asked at all. Cookie only; `local` refused; audited as `node.service` and
  `node.config.update`. Two gates are NOT `nodeCanConfigure` and both are
  deliberate:
  - **`stop` and `uninstall` are owner-only** — structurally, not as a
    permission nicety. Every command reaches a node over the AGENT'S OWN
    socket, so the plane can never start an agent that is not running: those
    two end the connection that would carry the verb undoing them. An `edit`
    grantee may interrupt a machine they were shared; making it unreachable
    until someone walks to it is a different act.
  - **Repointing is owner-only** and is a REAL widening of what
    `subshell configure --server` is locally. The agent dials whatever host
    was named carrying `Authorization: Bearer <nodeKey>` — a credential valid
    on THIS plane — and the machine leaves this instance. Loopback is refused
    outright (nobody is at a headless machine to notice it dialing itself),
    every address is validated by component and stored canonicalized, and the
    audit row names the new value (the plane never knew the old one: which
    address a node dials lives in that machine's own config).
  - **Debug logging on a node is an `edit` act** (`PUT /api/nodes/:id/logging`,
    cookie only, `local` refused, audited `node.logging.update`). It flips the
    agent's own file-transport level live and persists the answer in that
    machine's `config.json`; `SUBSHELL_DEBUG_LOGGING` in the agent's
    environment forces it on and the agent REFUSES the command while it does,
    the same "environment wins, and a write the next read would mask is not a
    success" rule the rest of the config ladder follows. Not owner-only,
    unlike `stop`/`uninstall`/repointing: it changes what a machine writes to
    its own bounded, self-replacing 200 KB file and reverses with the same
    call, so nothing here can strand a node. **It currently reveals nothing** —
    the agent has no `logger.debug` call sites, and the server's equivalent
    switch exists for its HTTP request lines, which an agent has none of. The
    mechanism is in place ahead of the lines by decision, so the accounting to
    redo is the one for whatever the first debug line carries.
  - **The agent's log became readable over HTTP.** The agent now writes its own
    bounded file (0600, 200 KB, replaced when full) because its console output
    goes to a journal on Linux and a file on macOS, and neither is readable
    from a browser. Same accounting as the server's own log: the set of people
    who may read it is unchanged (owner or `edit`), what widens is the set of
    PLACES. An agent logs launches, refusals and connection errors — never pane
    content, and never argv, which carries a subshell's bearer token.
- **The plane can restart a node's agent** (now the `restart` verb of the
  above; spec 2026-09-12 §6.3). **No new trust**: the plane already runs arbitrary
  commands on that machine under that OS user, and "exit so your service
  manager respawns you" is the narrowest thing it could be asked to do. The
  agent applies the same two refusals the server applies to itself — not
  supervised, and a definition that would kill its panes without `force`.
  Cookie only, owner or `edit`, `local` refused, audited as `node.restart`.
  The honest note is about AVAILABILITY, not confidentiality: an `edit`
  grantee may restart a machine they do not own, briefly taking every subshell
  running there offline, the owner's and other grantees' included.
- **How a node's agent runs is visible to config-capable viewers only.** The
  `runtime` report on node detail (supervision, service state, config/log/binary
  paths, tmux) is attached only for an ONLINE agent node whose viewer is owner
  or `edit` — never `local`, never a `view` grantee. A `view` grantee may launch
  here; that does not make this machine's paths their business.
- **New exposure:** subshell bearer keys ride in the launch command and are
  **`ps`-visible on node hosts** — the known backend-host exposure now extends
  to every enrolled machine. Node local users — and, in effect, anyone with
  `edit` on a subshell running there — hold that subshell's bearer key. Sharing a
  node does not hand out subshell keys, but anything launched there trusts the
  machine.
- **Directory allowlist** (spec 2026-09-05): a node owner may restrict which
  directories subshells can be created in on that machine. **Empty =
  unrestricted**, never "deny everything" — invert that anywhere and every
  node locks out on upgrade. **Owner-only** to edit (`canManage`, NOT
  `nodeCanConfigure`): any node share lets the grantee launch there, so an
  `edit` grantee who could widen the list would face no restriction at all.
  Enforced on the control plane (create + restart, on the RESOLVED path) and
  independently on the node against `<dataDir>/allowed-dirs.json` — signing
  proves who, never whether. Browsing is NOT gated (filtered for non-managers
  as a UX nicety only); gating it made the second rule unaddable, since the
  owner browses to pick what to permit.

- **Setup keys**: single-use, 24 h expiry, shown once, hashed at rest,
  revocable, audited. The install command embeds one in a URL, so it lands in
  shell history and server/access logs — same posture as enrollment links
  everywhere; revoke = delete the key.
- **Who may MINT one is an instance setting** (`allow_node_enrollment`, admin
  toggle under Settings → General, audited `settings.update`). An absent row
  means TRUE, so an instance that never touched it keeps the behaviour it had:
  any signed-in user may add a machine. Turned off, `POST /api/nodes/setup-keys`
  refuses non-admins with 403 and admins are unaffected — the same shape as an
  admin creating a user through `POST /api/users` while sign-up is closed.
  Enforced THERE and nowhere else, because minting is the only chokepoint:
  enrolling is unauthenticated by design (the key IS the credential), so there
  is nothing to gate on `POST /api/nodes/enroll` and gating it would refuse
  keys the instance itself handed out.
  **It does not revoke what is outstanding** (operator's call, 2026-09-13):
  flipping it off means "stop handing these out", not "invalidate the ones
  already minted" — the same semantics as closing registrations, which signs
  nobody out. An unconsumed key stays usable until it expires (24 h) or an
  admin deletes it, which is the act that revokes and is separately audited.
  So the switch bounds the FUTURE; the ≤24 h window it leaves is closed by
  deleting keys, not by the toggle.
  It governs ADDING a node only. Who may launch on one they were shared, and
  what a share confers, are the unchanged axes above.
- **Two axes stop launches on a node, not two switches** (spec 2026-09-14).
  Shares answer WHO may launch; **maintenance** answers whether anyone may.
  - *Narrowing the control-plane host* is still an admin removing `local`'s
    seeded Everyone/`edit` share row. It **survives restarts** — boot seeding
    creates that row only when the `local` node row itself is created, never to
    "repair" a deliberate removal — and the row then vanishes from non-admin
    views like any invisible node. **It applies to ADMINS too** (2026-09-12):
    `nodeCanLaunchOn` reads the GRANTED access for `local`, so the boost grants
    management and never launch. The refusal is a **403**, not the 404 an
    invisible node answers with, because the admin must keep seeing the row to
    widen it again. The remedy is a share.
  - *Maintenance* is a per-node flag every node has, `local` included: the
    machine stays enrolled and answers every other command but takes no new
    subshells, and turning it on **terminates every subshell running there,
    whoever owns them**. `PUT /api/nodes/:id/maintenance` is owner-only (admin
    on `local`) — the delete/re-share gate, not `nodeCanConfigure` — and the
    machine's own `subshell maintenance on|off` sets the same flag. Audited
    `node.maintenance.update` from both origins, actor null when the machine
    decided.
  - It **reaches past the person who throws it**: any node share lets a
    grantee launch there, and what they launch is private to them, so an owner
    stops work they cannot enumerate. They are told a COUNT only
    (`runningSubshells`, manage-gated on the node detail — itself a disclosure
    of how much invisible work sits on that machine); the affected owners learn
    by push. Retroactive on purpose, unlike `allow_node_enrollment`, which
    bounds only the future.
  - **Either end may overrule the other** (newer stamp wins, ties to the
    plane), so a COMPROMISED machine can always clear its own flag. That costs
    nothing: whoever can send that frame holds the node key, so they are the
    local OS user and already own every pane, file and pane-argv token there.
    **Maintenance is a routing preference, never a quarantine** — it keeps
    answering every other command. Containment is deleting the node, rotating
    or disabling its key, or clearing its shares, all cookie-gated and out of a
    node key's reach. The node's own fail-closed mirror check is defence in
    depth against a plane that has not learned yet, not a second switch.
- **Agent artifacts are never anonymous.** Prebuilt `subshell` binaries and
  their `.sha256` digests (`GET /api/downloads/node/*`) require a signed-in
  session cookie OR a valid unconsumed setup key; `GET /install.sh` renders a
  usage script for an invalid/absent key (it is never a binary oracle), and the
  rendered script digest-verifies the download before its first `chmod +x`/exec.
  **A binary the instance does not have is fetched from the project's own
  `node-v*` release on first use** (2026-09-12): lazily — no warm-up, no admin
  button, no poll, and the triggering request is already authenticated —
  streamed through while being hashed against the release's `.sha256`, with a
  mismatch erroring the response mid-flight so nothing unverified is cached.
  The node's own digest check before `chmod +x` is what makes streaming sound.
  `SUBSHELL_RELEASE_URL` is operator-configurable and **empty disables
  it** (the air-gapped configuration, where the Nodes dialog keeps its
  no-binary warning). Only files this instance fetched — recorded in
  `.fetched.json` with their release tag — are ever superseded or deleted; a
  hand-published binary is never touched, and a file on disk always wins.
  Full prose: `docs/security.md`, "Agent binaries are fetched lazily".
  Public settings now carries `appBaseUrl` so the Nodes dialog can show the
  exact URL the server will bake — the enroll-time loopback trap above is
  unchanged by that visibility.
- **Plugin installs are instance-level admin acts** (spec 2026-09-10
  inversion): `/api/plugins` writes are cookie-admin only, because installing
  runs third-party plugin code IN THE CONTROL-PLANE PROCESS — the one that
  holds the node signing keypair, so a malicious plugin reaches every node,
  bounded by the admin gate (what it costs against what it removes — nodes
  executing no third-party code at all — is accounted in `docs/security.md`
  §11.9). The per-node plugin routes and the agent's `subshell plugin` verbs
  are GONE, not widened; the agent holds no plugin concept. The anonymous
  setup route stays embedded-built-ins-only — its body has no spec
  field. The registry URL (`SUBSHELL_PLUGIN_REGISTRY_URL`) is
  operator-configurable, and integrity only proves the bytes match the hash
  the SAME registry published: over an http mirror that is the operator's own
  network, not npm's assurance. An id switching across an uninstall is not a
  privilege hop — both copies ran in the control-plane process. Instance-level
  plugin SECRETS are designed-but-unbuilt future work (`SUBSHELL_SECRETS_KEY`,
  fails closed, a lost key is unrecoverable — `docs/security.md` §8);
  pane-side credentials stay in the node's own environment, which the plane
  never sees. Full prose: `docs/security.md` §6, "Plugin installs from the
  registry".
- **Updating is a new class of act on every surface** (spec 2026-09-15; full
  accounting in `docs/security.md` §11.12). Three sentences to code by. **The
  plane downloads and executes code from the release source** — the digest
  comes from the same source as the bytes, so integrity is "these are the
  bytes it served", authenticity is that host's TLS plus the repository's
  access controls, and empty `SUBSHELL_RELEASE_URL` disables every one of
  these paths; the desktop apps are the one exception, and stronger, because
  `tauri-plugin-updater` checks a minisign signature against a pubkey compiled
  into the app. **An admin installs code on the control-plane host from a
  browser** (`POST /api/admin/server/update`, cookie-admin, bearer refused,
  audited at the start with the actor and again at the completing boot with
  actor null) — the URL comes from the release index and never from the
  request body, and `version` only selects among published tags. **An `edit`
  grantee replaces a node's binary** (`POST /api/nodes/:id/update`, the
  `service restart` gate, `local` refused, audited `node.update`): the URL and
  digest ride inside the SIGNED command, and the `nut_…` download token is
  in-memory, hashed, single-use, ten minutes, bound to one node and one
  target, refused on the `.sha256` routes — so "a node key can do nothing on
  REST" stays true as written. A refused agent is now HELD rather than
  dropped: offline for every purpose but `update`, every other frame dropped
  unparsed, closed after ten minutes unused, superseded by a newer socket, and
  closed by `disconnectNode` when the key is rotated or deleted. The backup an
  update takes is the WHOLE database (0600 in a 0700 dir inside the data dir,
  so the reset already covers it; five kept, `SUBSHELL_DB_BACKUPS_KEEP`), and
  a failed boot restores it before putting the old binary back — an old binary
  cannot boot on a newer database at all. `app-update` is one more name on the
  existing closed screen enum and `main` gains no command in either desktop
  app.
- **Agent CLI installs are an admin act on the control-plane host** (spec
  2026-09-11 §7): `POST /api/setup/agents/:id/install` runs a BUILT-IN
  manifest's install command as the server's user; admin cookie only, never
  public, audited. Accounting in `docs/security.md` §11.10.
- **So is installing tmux** (spec 2026-09-15): `POST /api/setup/tmux/install`
  runs this platform's package manager as the server's user, so the browser
  wizard can offer what the native assistant always could. Same gate (admin
  cookie only, never public in the no-users window, audited `tmux.install`) and
  narrower: the argv comes from a compiled-in table with NO operator input, and
  anything `sudo`-prefixed is refused 409 before anything runs — the server has
  no terminal to answer a password prompt, and that refusal is what keeps this
  from being an escalation. Every Linux entry in the table is `sudo`-prefixed,
  pinned by a test, so in practice it runs only under Homebrew on macOS.
  Accounting in `docs/security.md` §11.10b.
- Trusted-network posture is **unchanged**: node→control traffic is expected to
  ride the same VPN/Tailscale; `wss://` termination is the operator's
  deployment. **Enroll-time loopback trap:** if the server URL is `localhost`-
  ish, a remote node dutifully dials the wrong machine — the enroll flow and
  Nodes page surface the resolved URL and warn on loopback.
- **Repointing a node (`subshell configure --server`) is deliberately
  UNPRIVILEGED and non-destructive**, and it changes no trust relationship. It
  rewrites `serverUrl` in the agent's own `config.json` — a 0600 file the local
  OS user already owns and could edit by hand — while keeping `nodeId`, the
  node key and the pinned `controlPublicKey`. So it spends no setup key, mints
  no second node row, and grants the new plane nothing: it must still hold the
  key matching the pinned `controlPublicKey`, or every command it sends fails
  verification. It DOES disclose, though — the daemon dials the newly named
  host with `Authorization: Bearer <nodeKey>`, so a repoint hands a credential
  valid on the OLD plane to whatever host was typed. No privilege gain (the
  local user already holds that key), but a repoint names a host you trust
  rather than just correcting an address. What changes otherwise is where this
  machine ANNOUNCES itself, which is why it also clears the enroll-time
  `nodeWsUrl` (otherwise the daemon keeps dialing the old host). The old plane
  simply loses the node.

## Which addresses a browser may use (`TRUSTED_ORIGINS`)

The allowlist is DERIVED from the instance's own address plus an explicit
`TRUSTED_ORIGINS` list, and never from the request's own Host — that is the
DNS-rebinding hole the static list exists to close, and it stays closed. What
changed is only where the list is reachable FROM: the `subshell-server` CLI
(`--trusted-origins`) since 2026-09-08, and the dashboard's Server Settings →
Service since 2026-09-12, instead of a hand-edit of config.env. The Subshell
Server console that first carried the field is gone; its half moved into the
served page. Every one of those surfaces writes through the same `applyConfig`,
so the validator below is one narrow point rather than one of several.

That is a usability fix for a real trap, not a widening: on the default
`0.0.0.0` bind the derived set is the two loopback spellings, so a phone or a
LAN hostname sends an `Origin` nothing matches and sign-in dies on 403 "Invalid
origin" — with nothing naming the key that fixes it. Two properties to keep:

- **Every entry is validated by COMPONENT and stored canonicalized** (scheme
  http(s), a host, no path/query/fragment → store `URL.origin`). Both
  consumers match the origin a browser sends, so accepting a spelling without
  canonicalizing it writes a config that 403s while reporting success.
  Credentials are refused rather than silently stripped, since `URL.origin`
  drops them.
- **Wildcards are refused, and that refusal is load-bearing.** Both consumers
  of this array are looser than the list reads: better-auth routes any entry
  containing `*`/`?` through `wildcardMatch` (so `https://*` trusts EVERY
  https origin — measured, 1.7.1), and `@elysiajs/cors` strips the scheme off
  the incoming `Origin`, making a schemeless entry a scheme-wildcard there.
  CORS is not a backstop for the first case: it is a browser courtesy, and a
  non-browser client sends any `Origin` it likes. So `validateValue` is the
  narrow point that makes "static allowlist" true of everything the CLI flag
  and the dashboard can write. An env var or a hand-edit still bypasses it. Adding wildcard support would need this section rewritten first.
- **`APP_BASE_URL` is also better-auth's passkey rpID.** Changing it moves
  which host passkeys work on, so an existing passkey stops working on the old
  address — including the Subshell Server desktop app's own window, which is
  pinned to loopback. Adding a LAN name to `TRUSTED_ORIGINS` does NOT have that
  effect and is the right lever for "also reachable at".

## Network plugins publish this server on a network (spec 2026-09-15)

A `type: "network"` plugin connects the control-plane host to one network
(Tailscale, Headscale, NetBird, Cloudflare Tunnel) and publishes Subshell on
it. Same store, same admin install door, same seeding marker as a harness
plugin. **The rule to code by: a network plugin DESCRIBES, the host
EXECUTES** — it returns argv, parses output and names a secret; it never
spawns, never writes a file, never touches config.env, never reads a credential
back. Everything goes through `PluginHost`. That is what keeps the admin-only,
bounded, audited properties of the existing installers true of third-party
code. Full accounting: `docs/security.md` §11.13.

- **Same gate and the same bounded executor** as the two installers above:
  `/api/network/*` is cookie-admin only (`resolveSetupActor === "admin"`),
  bearer refused, never public — no no-users carve-out, which is why the wizard
  step sits after Create Your Account. The spawn core is the one
  `runInstaller` uses: the `INSTALLER_ENV_KEYS` allowlist (no
  `BETTER_AUTH_SECRET`, no database path), stdin closed, 64 KiB cap, 30 s
  default deadline capped at ten minutes. **The one difference from §11.10b:
  the argv comes from plugin code rather than a compiled-in table** — no new
  trust beyond §11.9, but say it rather than filing it under "plugins are
  trusted".
- **The sudo boundary is absolute.** `host.run` throws on an `argv[0]` that is
  not absolute or whose basename is `sudo`/`doas`/`pkexec`, and the manifest
  parser refuses an `install.command` starting with `sudo`. Every mesh daemon
  needs one root install; those are manifest DATA (`network.privileged`),
  PRINTED for a human and never run. `cloudflared` is the one binary needing no
  root anywhere, which is why it is the only `install.command` the server may
  run itself.
- **`host.secrets` has no `get`, deliberately.** A plugin that could read a
  credential could put it in argv, a log line or a hint that renders in a
  browser. Stored 0600 under
  `<dataDir>/plugins-state/<id>/secrets/<name>` in 0700 dirs; hydrated only
  into a host-spawned child (a 0600 file named by a flag, or an env var).
  **`subshell-server backup` does NOT cover it** — that snapshots the database
  alone, so a restore needs the token re-entered, and the UI says so at the
  field. Short-lived mesh keys never go here: they transit argv once (the
  accepted `enroll --key` class) and the daemon owns the identity after.
- **Cloudflare Tunnel inverts the posture and is bounded in three places.**
  `exposure: "public-with-gate"` is manifest data rendered before the button;
  the plugin REFUSES to publish until a pre-flight confirms an Access
  application covers the hostname; and the server verifies the assertion
  itself, keyed on the **`Host` header** (never a `CF-Ray`-style presence rule
  a LAN client can omit), `jwtVerify` against the team JWKS with issuer and
  `aud` pinned, failing closed with `403 ACCESS_REQUIRED` on every path with no
  exemptions, plus a refusal of a matching Host from a non-loopback address.
  Disable and unpublish stop the process FIRST and drop the guard LAST, so a
  live tunnel is never unguarded. **The assertion is a front door, never a
  session**: the verified email is audit metadata, and Subshell's own cookie is
  still required behind it.
- **No proxy header is trusted.** `X-Forwarded-*`, `Tailscale-User-Login` and
  `Cf-Access-Authenticated-User-Email` are ignored. Login backoff stays
  per-email, which costs nothing under a tunnel today (every request looks like
  127.0.0.1) and is why a per-IP limit added later must read `CF-Connecting-IP`
  behind the guard only.
- **Publishing widens the address surface through `applyConfig` and nothing
  else** — §11.11's writer, so the component validation and the wildcard
  refusal above apply unchanged. `TRUSTED_ORIGINS` is additive and
  passkey-neutral; promoting to `APP_BASE_URL` MOVES the passkey rpID and is
  opt-in with that warning. A key sourced from `process env` reports
  `written:false` rather than a write the next read would mask. Audit rows
  (`network.configure|install|join|publish|unpublish|leave`) name origins and
  field
  NAMES, never values.
- **Tailscale Serve puts the machine's name in public CT logs** (a real Let's
  Encrypt certificate for `<host>.<tailnet>.ts.net`). Said on the publish
  button, not discovered.
- Each address carries `secureContext`, which is a statement about the BROWSER
  and not about encryption: a WireGuard mesh encrypts an `http://` origin end
  to end, but passkeys and `Secure` cookies still will not work there.

## The desktop apps (`apps/server/desktop`, `apps/client/desktop`)

Two Tauri v2 shells. `apps/server/desktop` ("Subshell Server") installs, runs
and manages a `subshell-server`; `apps/client/desktop` ("Subshell Client") is a
person's interface to a control plane AND the place their machine is registered
as a node. Neither adds a server surface — everything privileged goes through a
CLI as the same local user.

**The boundary is window KIND, not window count: CLI-driving commands are
granted only to BUNDLED pages.** Both apps are two windows now, one remote and
one bundled — the server app's console was deleted by spec 2026-09-12 and its
management surface moved into the SPA, leaving the remote SPA window plus one
bundled ASSISTANT (`capabilities/wizard.json`, `console.json` gone) that owns
first run, recovery, update and reset. That assistant is the only surface
allowed to drive the CLI, so it holds every command that changes this machine,
the destructive ones included, and `ui/src/__tests__/ipc-acl.test.ts` pins the
grant equal to what the page actually invokes. The `csp` in each
`tauri.conf.json` governs the bundled pages only — the remote window carries
whatever CSP the plane sends.

- **The server app's remote window is PINNED TO LOOPBACK and holds six
  commands — five harmless, one deliberate exception.** It loads `http://127.0.0.1:<port>` or `http://localhost:<port>` —
  the server this app itself manages — so `capabilities/main.json` scopes it
  with `remote.urls` to loopback and grants only commands that cannot touch the
  CLI, the config, the service or the filesystem (drop this app's own title
  bar, display one fixed-shape notification, raise the assistant at a named
  screen, open a page of THIS server in the system browser, and read this
  app's own macOS permission states — `desktop_permissions`, the sixth,
  2026-09-14: no argument, two facts from the OS, argued in spec 2026-09-14
  §7 because two of the three moments a missing permission must be explained
  are in this very page; requesting one and opening System Settings stay on
  the bundled page) — plus
  `desktop_set_supervision`, the ONE
  CLI-touching command granted there (2026-09-12): switching who runs the
  server is a restart with a different respawner, and an admin page already
  holds the restart route, so the assistant window that carried the consent
  defended less than it cost. `docs/security.md` carries the accounting.
  `open_main` independently refuses a non-loopback origin, and `on_navigation`
  pins the window to the origin it opened with. An XSS in the SPA reaches
  those six commands and nothing else.

  Three caveats on that trade, all in `docs/security.md` and none of them
  decoration: the grant is scoped to the WINDOW, not to an admin session, so a
  `main` window on the sign-in page can invoke it and this is NOT parity with
  the route; the command applies the restart route's own **pane-safety
  refusal** (`pane_safety_refusal`, failing closed on an unreadable
  definition) because `service uninstall` gates on nothing and on an old
  definition takes every live subshell with it — without that the page could
  do silently what the route 409s on, and the whole argument would be false;
  and the **audit row is best-effort and posted by the CALLER**
  (`POST /api/admin/server/supervision`, which records and changes nothing),
  so it makes honest use legible and is not a control. The command also
  refuses to interleave with itself (`ActionGuard::try_new`, a
  compare-and-exchange), because a hundred concurrent chains can leave a
  machine with no definition and no server.

  `capabilities/main.json`'s SCOPE is pinned too, not just its permission
  list: `remote.urls` (both loopback spellings), `local: false` and
  `windows: ["main"]`, plus the granted command's argument list — widening any
  of those would hand this grant to a page on any host with every
  command-name assertion still green.
- **The server app's reset is assistant-only, and the deep link reaches one
  read-only spawn.** The dashboard's danger card calls
  `desktop_open_assistant({ screen: "reset" })`; the remote window's worst case
  is precisely that: it can raise the assistant at a confirmation screen and
  trigger exactly one read-only `status --json` the app already runs on a
  five-second timer, spammably — and no verb that changes the machine.
  `desktop_reset` lives in `wizard.json` alone; it takes ONLY a typed hostname
  (compared against Rust's own memoized `hostname(1)`, so the page supplies a
  string, never a path), the five deletion paths come from the server's own
  `status --json` `paths` block all-or-nothing, an absent or partial block
  means the screen refuses, and a recursive delete that would contain the
  installed `~/.local/bin/subshell-server` is refused before anything runs.
  Enrolled remote nodes and a same-machine `subshell` node agent are NOT
  reached by a reset and keep their keys and processes; that is stated in the
  confirmation itself.
- **The client app's remote window is granted exactly ONE command**
  (2026-09-14; it was granted NOTHING before). A control plane can live on any
  host, so its origin cannot be enumerated in a capability file the way loopback
  can — and that has not changed. What changed is that the boundary moved one
  level in rather than away: `capabilities/main.json`'s scope is a WILDCARD
  (`http://*:*`, `https://*:*` — `http://*` alone does not match a non-default
  port in Tauri 2.11.5's `urlpattern`, which would silently exclude the default
  `:3080` plane), and the narrowness lives in the command's ARGUMENT.
  `desktop_open_in_browser` takes a PATH — no scheme, no protocol-relative
  `//host`, no backslash, no whitespace or control characters
  (`crates/desktop-core`'s `browser` module, shared by both apps) — and joins it
  onto the origin `PlanePin` already enforces for navigation. So an XSS in a
  control plane's SPA can open a page of THAT SAME PLANE in the person's
  browser, and nothing else: no `node_*` verb, no plugin permission, no
  `core:default`, no CLI, config, service or file. The window now carries a
  `SubshellClient/…` user-agent marker, a DIFFERENT product token from the
  server app's, and the SPA branches on it — `isServerDesktop()` gates every
  Subshell Server surface (overlay title bar, update, reset, supervision,
  notifications), `isDesktop()` gates only "Open in browser". `on_navigation`
  still pins the window to the origin it opened with.
- **Each app's ACL manifest is load-bearing BY EXISTENCE.** Tauri gates an app
  command only when `plugin_command.is_some() || has_app_acl_manifest ||
  !is_local`, so deleting `permissions/desktop.toml` leaves every command
  ungated for every LOCAL window. Both apps have a local window that may drive
  the CLI and a remote window that may not, and that file is what keeps a third
  window added later from inheriting the surface silently.
- **The bundled binary is signed with the app's entitlements.** Tauri has ONE
  entitlements slot for the whole bundle, so whatever the Bun-compiled binary
  needs is also granted to the GUI process — which, in the server app, is the
  process holding the session cookie. That set was trimmed to `allow-jit` +
  `allow-unsigned-executable-memory` and is pinned by test in each app;
  `disable-library-validation` and `allow-dyld-environment-variables` — the pair
  that turns a signed app into a code-injection host — are deliberately absent.
  The two apps keep SEPARATE plists: one shared file would silently widen
  whichever pipeline was not being edited.
- **They execute what they find.** Each resolution ladder runs `<candidate>
  version` on files it locates, and the copy it installs — at
  `~/.local/bin/subshell-server` or `~/.local/bin/subshell` — is executed on
  every launch from a user-writable directory. That is not an escalation on
  this posture — the same user already runs these programs and can already write
  there — but it is why a chosen-binary path is validated before it is
  persisted, and why every spawn is bounded. The login-shell PATH probe runs the
  user's own profile, which is arbitrary code by construction, on every launch.
- **A setup key pasted into the node app is `ps`-visible**: it is passed to
  `subshell enroll --key <nsk_…>` as an argv element, the same exposure the CLI
  path already has. Bounded — single-use, 24 h, consumed by that enroll, and it
  confers only the right to register one node. The node key enroll returns is
  never surfaced: the CLI writes it 0600 and `enroll --json` omits it.
- **Subshell Server can run the control plane as its OWN CHILD** instead of
  installing a service (spec 2026-09-12 server-supervision), and the server
  learns this from `SUBSHELL_SUPERVISOR*` in its environment — a claim it
  believes only when the named pid is its actual parent. A forged claim needs
  the forger to BE the parent, and buys only `restart.available: true`, i.e.
  exiting into something that will not respawn: an operator lying to
  themselves on a host they already control, accepted like a hand-edited
  config.env. The supervisor signals the MAIN PID and never the process group,
  which is what earns its `paneSafety: "keeps"` — quitting the app stops the
  server and keeps every live pane.
- **Enrolling twice is destructive**, so the node app spawns nothing until the
  caller confirms: `enroll` overwrites `config.json`, mints a SECOND node row on
  the control plane, and discards the previous node key whose only home was that
  file.

Notifications follow the same owner-targeted rule as push: the server app's
watcher filters to `access === "owner"` and the per-subshell bell, and honours
the account-wide master switch. The list it reads is much wider than that — for
an admin it is every subshell on the instance — so the filter is load-bearing.

## CORS

Permissive CORS is acceptable **only** because the service is not exposed to the public
internet. The allowlist is a **static** one: the instance's own origins (both loopback
spellings of `SERVER_PORT`, a concrete `HOST`, the `APP_BASE_URL` origin) are derived at
boot and `TRUSTED_ORIGINS` adds to them — the dev Vite server comes from there. It is
deliberately NOT "trust the origin that matches the request host": that is the
DNS-rebinding hole the allowlist exists to close.

## Rate Limiting

Login is rate-limited; other endpoints are not — intentional for a local/trusted service
where performance and simplicity are prioritized over protection from abuse.
Passkey sign-in is **not** behind the email backoff — it carries no email to attribute
failures to; the physical authenticator (device + biometric) is the gate.
Approved emergency-logins (the credential rewrite) are audit events + warn log lines.

## Input Validation

Intentional design decisions for this deployment model:

- **No string length limits on log/subshell fields**: they vary legitimately; limiting them
  would break real use cases.
- **No pagination on small per-user lists** (distinct services, channels): expected to be
  small on a local instance.
- **Channel slugs and long-poll waits are bounded**: slugs match `^[a-z0-9][a-z0-9-]{0,63}$`;
  a read's `wait` is clamped to 600 s so a client cannot pin a socket indefinitely.

## Production note

`NODE_ENV=production` refuses to boot with the built-in placeholder `BETTER_AUTH_SECRET`
(a better-auth guard that exits early) — set a real `BETTER_AUTH_SECRET`, plus
`APP_BASE_URL`, when binding beyond loopback; its origin (and a concrete `HOST`) is
trusted automatically, so `TRUSTED_ORIGINS` is only needed for extra names. Production
enforces the origin check strictly — this is where a mismatched origin shows up as
`403 Invalid origin` on sign-in/sign-up, not in dev.

## When This Changes

If this service is ever deployed to a shared or public environment, work through
the full checklist in [`docs/security.md` §12](../../docs/security.md#12-hardening-checklist-for-a-wider-deployment).
The headlines: HTTPS only with `secure` cookies and a real `BETTER_AUTH_SECRET`;
proper CORS origin validation and rate limiting on all routes; input length
validation and pagination on every list endpoint; set `SUBSHELL_FS_ROOT`; rotate
and review system API keys; and re-examine the E2EE threat model, which protects
neither metadata nor a host-compromising local user.
