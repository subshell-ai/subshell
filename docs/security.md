# Subshell — Security Model

What Subshell defends against, what it deliberately does not, and where each
boundary is enforced in code. This is the authoritative statement of the threat
model; the machinery is in
[`develop/architecture.mdx`](../apps/docs/content/docs/develop/architecture.mdx),
the node wire contract in
[`reference/node-protocol.mdx`](../apps/docs/content/docs/reference/node-protocol.mdx),
and
[`.claude/rules/security-context.md`](../.claude/rules/security-context.md) is
the working summary agents load when writing code here.

- [0. The posture, stated plainly](#0-the-posture-stated-plainly)
- [1. Threat model](#1-threat-model)
- [2. Identity and credentials](#2-identity-and-credentials)
- [3. Authorization](#3-authorization)
- [4. What a harness pane can reach](#4-what-a-harness-pane-can-reach)
- [5. Sharing](#5-sharing)
- [6. Nodes](#6-nodes)
- [7. Encrypted channels](#7-encrypted-channels)
- [8. Network boundary](#8-network-boundary)
- [9. Input handling and untrusted data](#9-input-handling-and-untrusted-data)
- [10. Audit and observability](#10-audit-and-observability)
- [11. Accepted risks](#11-accepted-risks)
- [12. Hardening checklist for a wider deployment](#12-hardening-checklist-for-a-wider-deployment)

---

## 0. The posture, stated plainly

**Subshell is a local / trusted-network service.** It is designed to run on a
developer's machine or inside a trusted perimeter — a VPN, WireGuard, Tailscale,
or an SSH tunnel. **It is not internet-grade and should not be exposed directly
to the public internet.**

That is not a disclaimer bolted onto an otherwise-hardened system. It is a design
input that several deliberate decisions depend on: permissive CORS, rate limiting
only on login, no input length limits on free-text fields, no pagination on small
per-user lists, and a filesystem picker that browses the host by default. Each is
sound at the intended perimeter and unsound outside it. §12 is what would have to
change.

Everything below assumes that perimeter holds.

## 1. Threat model

### Defended against

| Threat | Where it is stopped |
|---|---|
| An unauthenticated party reaching any API | The auth guard — every `/api/*` route except auth, setup-status, and the one anonymous read carved out in §2 |
| One user reading or driving another user's subshells | Ownership checks returning **404, never 403**, so ids cannot be probed |
| A harness pane escalating beyond its own subshell | Per-subshell tokens scoped by permission map, bound to their row, and rejected on every admin surface |
| A compromised harness enumerating the operator's disk | `/api/files/explore` refuses machine credentials outright (403) |
| A stolen WS attach token being replayed | 30 s TTL, single-use, minted only over an authenticated REST call |
| Password guessing | Per-email exponential backoff on sign-in |
| The server (or its backups) reading channel messages | End-to-end encryption — the server stores only opaque JWE ciphertext |
| A compromised relay forging work for a node | Every command is a JWS bound to one node, short-lived and single-use |
| A malicious node path escaping into host paths | Structural id/path guards on both sides of the link |
| DNS rebinding | A static origin allowlist, never "trust the requesting host" |
| Terminal output injecting markup into the UI | PTY bytes are rendered only by xterm, never as HTML |

### Explicitly NOT defended against

| Threat | Why |
|---|---|
| **A local OS user on the host** | They can read subshell keypairs, the node signing key, pane contents, and `/proc/<pid>/environ`. This is the single largest assumption in the model — the host's OS user boundary *is* the trust boundary |
| **Network-level attackers** | No TLS enforcement, no certificate pinning. Transport security is the operator's deployment (a VPN, or TLS terminated in front) |
| **Channel metadata analysis** | Channel names, membership, post timing, ordering, message sizes and principals are all plaintext on the server |
| **Control-plane compromise** | The node signing keypair lives on the backend host and rules every enrolled node. Compromise there is compromise of the whole fleet |
| **A malicious admin** | Admins hold instance-wide edit access and can mint full-access system keys. There is no separation of duties |
| **Denial of service** | Only login is rate-limited |
| **Supply chain of the harnesses themselves** | Subshell launches whatever `claude`/`opencode`/`codex` binary is on the host's PATH and does not verify it |

## 2. Identity and credentials

Four credential kinds exist. Three reach `/api/*` through one guard
(`apps/server/api/src/api/auth-guard.ts`), which is the only place credentials become
principals; the fourth is a websocket credential and nothing else.

| | Session cookie | System key | Subshell token | Node key |
|---|---|---|---|---|
| Form | `better-auth.session_token`, HttpOnly, `SameSite=Lax`, `secure` in prod | `Bearer subshell_…` | `Bearer subshell_…` | `Bearer` on `/ws/node` only |
| `actor` | `cookie` | `system-key` | `subshell-key` | — (rejected on REST) |
| `principal` | `user:<id>` | `user:<systemUserId>` | `sess:<subshellId>` | — |
| Minted by | sign-up / sign-in / passkey | admin, Server Settings → API keys | the server at subshell start | `POST /api/nodes/enroll` |
| Scope | the user's own data; **the only actor admin surfaces accept** | full access, no permission map | permission grant map (`channels`, `subshells` × `read`/`write`) | open `/ws/node` as that node |
| Lifetime | better-auth session | until disabled or deleted | 7 days, self-extending while the MCP child runs | long-lived |
| Revocation | sign-out / password change | instant | **instant** on terminate/delete; rotated on auto-restart | delete the node |
| Stored as | session row | hash only | hash only | hash only |

Plaintext keys are shown exactly once, at creation, and never again.

### The anonymous surface

Authentication is required on every `/api/*` route except the auth endpoints,
`GET /api/setup/status`, and one read added in spec 2026-09-08:

`GET /api/settings/instance` → `{ instanceName }`. The operator-chosen display
name for this control plane, or this host's own name when unset, served to a
caller holding **no credential**. It is read by the sign-in page and is what
lets a person tell which plane is about to receive their password when several
answer on the same VPN — a property worth having rather than a disclosure
merely tolerated. What it costs is exactly one operator-chosen string, readable
by anyone who can reach the port.

Three properties hold it there, and all three are load-bearing:

- **It is its own route module.** `authGuard` is a scoped Elysia plugin applied
  to the whole `/api/settings` group, so an exemption *inside* that group is not
  expressible; a separate module without `.use(authGuard)` is. That boundary is
  why `viewerIsAdmin`, `appBaseUrl` and `nodeArtifactTargets` — all on the
  signed-in `GET /api/settings/public` — did not become anonymous with it.
- **Its entire key set is asserted by test**, not just the field it should
  carry. A field added to this response later cannot quietly become public.
- **The value is normalized on read as well as write** (`normalizeLabel`), so a
  row written by an older release or edited by hand cannot carry CR/LF into a
  log record or an anonymous response body.

It is deliberately NOT folded into the already-anonymous `GET
/api/setup/status`, which the frontend caches with an infinite stale time
because `needsSetup` is true exactly once in an instance's life. A renameable
value must not inherit that cache.

### Passkeys

WebAuthn credentials (`@better-auth/passkey`) mint the **same session cookie** as
a password. They are an additional credential per user and device — **not a
second factor**, and nothing enforces their use.

One deployment trap: better-auth 1.7.1 derives the rpID from the **configured
`APP_BASE_URL` host**, not the request host. Passkeys therefore only work when
browsing on that exact address; reaching the same instance by another name (a
loopback spelling versus the domain, say) fails in the browser with no useful
error.

### Break-glass recovery

While `SUBSHELL_EMERGENCY_PASSWORD` is set, an admin signing in with that exact
value has **their stored credential overwritten by it** and receives a real
session. This is destructive by design — it is a password reset, not a bypass —
and it is signalled loudly: every signed-in user sees a warning banner
(`GET /api/settings/public → emergencyLoginActive`), the rewrite is an audit
event (`emergency_login.rewrite_credential`) and a warn log line.

The comparison is constant-time so the env value cannot be recovered as a timing
oracle, and break-glass attempts share the ordinary login backoff.

**Clear the variable and restart after recovery.** While it is set, anyone who
can read the environment of the server process can become any admin.

### The subshell-token forgery defense

Worth stating separately, because it is subtle. better-auth's api-key plugin
exposes a public create endpoint that lets any signed-in user attach arbitrary
metadata — including `kind: "subshell"`. So the guard does **not** trust that
metadata. A key is a subshell principal only if the subshell row's `api_key_id`
column — written exclusively by the server's `issueSubshellToken` — equals the
presenting key's id. As a second layer, the plugin's self-service
`/api/auth/api-key/*` endpoints are blocked at the mount.

Three related rules, each tested:

- A key whose `referenceId` is not the `system` service user is not a system key,
  whatever its metadata claims.
- A valid key whose subshell row is gone returns 401 — **the row, not the key, is
  lifecycle truth**.
- All raw SQL against the `apikey` table lives in exactly one module
  (`src/auth/apikey-store.ts`). System-key scoping uses `json_extract`, not a
  string `LIKE`, so an upstream serialization change cannot silently make a
  full-access key un-disable-able.

## 3. Authorization

Three independent axes, and confusing them is how authorization bugs happen here.

**Ownership.** A subshell is private to its owner. To everyone else it is 404 —
absent from list, detail, log, terminal and workspace-pane paths alike. The 404
is deliberate: a 403 would confirm the id exists.

**Grants.** The owner may share (§5). Grants confer view or edit; they never
confer delete or re-sharing.

**Admin.** Admins hold instance-wide **edit** — effective operator access. They
can read and drive any subshell. They **cannot** delete one or change its shares;
those stay with the real owner. Admin status lives in the app's `user_meta`
table, not on the better-auth user row.

Two hard rules on top:

- **Machine credentials never manage the instance.** `requireAdmin` rejects any
  non-cookie actor with 403 — `/api/users`, `/api/system-keys`,
  `/api/admin/status`, the `/api/admin/server` group (§11.11), and the sharing
  routes.
- **Machine credentials get no boost and no grants.** On every per-subshell
  route, a bearer actor runs with the admin boost and shared grants switched
  **off**. A subshell's own token can therefore act only on its owner's
  subshells — never a foreign one, never one merely shared with its owner.

**The roster READ is not admin-gated, and it carries display names.** Writes to
`/api/users` are cookie-admin; `GET /api/users` is deliberately instance-wide —
it is what lets the sharing picker name people — so any signed-in caller and
any bearer credential, a running subshell's own token included, reads every
account's email, **display name** (added 2026-09-14), role and disabled state.

**So is the ADDRESS LIST** (2026-09-16). `GET /api/settings/public` carries
`trustedOrigins` — every origin a browser may sign in from: this instance's
own addresses including the LAN interfaces derived on a wildcard bind
(§8), the operator's configured extras, and the addresses of every
enabled network plugin this host is joined to or published on — live, no
restart (§11.13). So any signed-in caller, and any bearer
credential, learns this plane's other names: its tailnet hostname, its LAN
name, its LAN addresses, a proxy domain. It exists for the "Subshell for Mobile" dialog, which
has to offer a PHONE an address — `appBaseUrl` is one spelling and is usually
the wrong one, since the browser asking is often on loopback while the phone
is on the mesh.

It is a real widening and worth naming as one, not filing under "public
settings". It is sound on this posture for the same reason the roster read
above is: every signed-in user is someone the operator admitted, and the
addresses are ones that user may already sign in from. What it costs is that a
compromised subshell token now enumerates where else this plane answers,
without guessing. It carries no credential, and knowing an address grants
nothing on it — every one of them still demands a session.

### `GET /api/admin/status`

The widest single read in the system: versions, host paths, the resolved MCP
command, instance-wide counts, and the security posture in one body. It carries
**no secret in any form** — the auth secret appears only as
`usingPlaceholderSecret`, the break-glass password only as `emergencyLoginActive`
— and a test scans the serialized response for the actual values so a field added
later cannot regress that.

The reasoning: an admin's screen gets screenshotted into issues. Treat it as
quotable.

## 4. What a harness pane can reach

A pane runs a real CLI agent with real filesystem access as the server's OS user.
The boundary is what the *app* hands it, not what the OS stops it doing.

**Curated environment.** Harnesses spawn under `env -i` with an explicit
allowlist — `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`,
`LC_ALL`, plus `CLAUDE_PATH`. App secrets (the database path, the auth secret)
never reach the agent. Preset env vars merge on top, then the MCP wiring env
last, so a preset cannot silently drop a subshell's comms by setting
`OPENCODE_CONFIG` itself.

**Argv is built from parts.** `buildCommand` assembles an argv array; there is no
shell string to inject into.

**The subshell's own bearer token does reach the pane** — that is how the agent
talks as itself. It is scoped, revoked on death, and rotated on restart. It is
also visible to any local process that can read `/proc/<pid>/environ`, `ps`
output, or tmux pane metadata. Accepted (§11).

**The filesystem picker is browser-only.** `/api/files/explore` returns 403 to
machine credentials. A running harness holding its own token must not be able to
enumerate the operator's disk; only a signed-in human uses the picker.

**Optional confinement.** `SUBSHELL_FS_ROOT`, when set, restricts browsing to one
directory tree (paths outside get 403). **Unset — the default — the host
filesystem is browsable by design.** The check compares both the lexical and the
realpath-resolved form against the root, and a present-but-unresolvable path (a
broken symlink) is refused because it cannot be proven confined.

`SUBSHELL_FS_ROOT` never confines a **remote node** — that root belongs to this
host and means nothing on another machine. A node's boundary is its agent user's
filesystem permissions, nothing more.

**Uploads are working-directory-scoped.** Dropped or pasted files land in
`<workingDir>/.subshell/uploads/`, git-excluded, filename-sanitized, capped at
`MAX_UPLOAD_BYTES` (25 MiB). Paths are injected into the pane via bracketed paste.
They are not swept — an uploaded file stays until someone removes it.

### Pane logs: the session transcript on disk

Every subshell streams its pane through `tmux pipe-pane` into
`<SUBSHELL_SERVER_DATA_DIR>/subshells/<id>.log` — on the control-plane host for
a `local` subshell, on the node's own disk for a remote one. It is what the
attach replay is built from, and it is **the single most sensitive artifact the
app writes**: a terminal echoes, so the file holds not only what the commands
printed but what the operator typed — a pasted API token, an `export SECRET=…`,
a value read out of a `.env`.

- **Plaintext.** It is not encrypted, and encrypting it would not help against
  the attacker this model actually names: the key would live on the same host,
  readable by the same OS user that can already read the log (§1). The
  protections are permissions and retention, not cryptography.
- **0600, in a 0700 directory.** The file is created by tmux's own shell
  (`cat >>`), so there is no mode to pass and no post-hoc `chmod` without a
  window — the `umask 077` inside the pipe-pane command is what guarantees it
  (`TmuxRunner.pipePane`). Logs written before that fix are repaired at boot by
  `services/pane-log-hygiene.ts`.
- **Aged out after `SUBSHELL_LOG_RETENTION_DAYS` (default 30).** An hourly
  sweep unlinks the logs of subshells that are no longer running; `0` keeps
  them forever. Deleting a subshell still unlinks its log immediately. A
  terminated-but-kept subshell used to hold its full transcript for the life of
  the instance.
- **Running subshells are never swept**, whatever the file's age: the log is
  the live replay buffer.
- **A remote node's logs are its own.** Deleting a subshell whose node is
  offline cannot name the paths to remove, so those files age out with the node
  rather than at delete time (§5.6).

**Typed input also transits argv.** Input reaches the pane as
`tmux send-keys -t <id> -l -- <input>`, one process per client frame — and a
paste arrives as a single frame, so the whole pasted value is one argv element.
On Linux `/proc/<pid>/cmdline` is world-readable. Accepted (§11), same class as
the bearer token above.

## 5. Sharing

A subshell is private by default. The owner may grant, via
`PUT /api/subshells/:id/shares`, to **Everyone** (all signed-in users) or to named
users:

- **view** — list, detail, pane log, and a read-only live terminal.
- **edit** — view, plus terminal input, rename, and restart.

**Owner-only, never conferred by a grant and not held by admins either:**
delete, managing the shares themselves, and the notification bell.

**Sharing is a human act.** Bearer credentials are refused on the shares routes
entirely.

### What a share actually exposes

This is a real widening of exposure, and it is worth being blunt about it:

- A **view** grant shows the grantee the subshell's full pane output. If a secret
  is on screen, it is shared.
- An **edit** grant additionally hands them the keystroke stream and the ability
  to type into a live agent session.
- **Everyone attached sees everyone else attached.** The `viewers` frame carries,
  to every viewer including a view-only grantee, each other device's chosen name,
  the grid it can display, when it attached, whether it is being rendered, and
  whether it may type.

That last one is deliberate rather than accidental: a pane has ONE grid and is
sized to the smallest visible viewer, so "why is my terminal 80 columns" is
unanswerable without it. But it is a disclosure to everyone the owner shared
with, not only to the owner. Device names are chosen client-side and
re-normalized server-side (`normalizeDeviceLabel`), so a name cannot carry
control characters into another user's screen or a log line.

Revoke by clearing the grant — the sharing dialog, or an empty `PUT`.

### Notifications do not follow shares

Push is **owner-targeted**. A notification goes only to the subshell owner's
devices, gated by a per-user master switch (`user_meta.notify_enabled`) and the
per-subshell bell (`subshells.notify`). Sharing widens who can see and act; it
never widens who gets pushed.

## 6. Nodes

Registering a node **delegates arbitrary command execution under that machine's
OS user** to this control plane. Read that sentence again before enrolling one.

Wire-level detail is in [`reference/node-protocol.mdx`](../apps/docs/content/docs/reference/node-protocol.mdx); the security
consequences are:

- **Any node share — even `view` — lets the grantee launch their own subshells
  on it.** Those subshells stay invisible to the node's owner unless separately
  shared. `edit` additionally configures the node; only the owner manages it
  (shares, rename), or an admin for the built-in `local` node.
- **Node shares and subshell shares are independent axes.** Sharing a node does
  not hand out subshell tokens — but anything launched there trusts the machine.
- **Whoever owns the node's OS user owns every pane launched there**, including
  its files and its subshell bearer token. Subshell tokens ride in the launch
  command and are `ps`-visible on node hosts: the known backend-host exposure now
  extends to every enrolled machine.
- **Command signing is not confidentiality and not resilience to control-plane
  compromise.** The signing keypair (`<data dir>/node-signing.json`, 0600) rules
  every enrolled node and lives on the backend host — same local-user exposure as
  everything else here.
- **A node key can do nothing on REST.** Explicit, permanent guard rejection. Its
  entire blast radius is impersonating that node on `/ws/node`.
- **The plane drives a node's service manager** (2026-09-12). `POST
  /api/nodes/:id/service` sends a signed `service` command carrying one of five
  verbs — start, stop, restart, install, uninstall. `restart` is the verb this
  route used to be: the agent answers, then exits so its service definition
  respawns it. This adds no trust and no
  reach: the plane already runs arbitrary commands on that machine under that
  OS user, and "exit" is the narrowest thing it could be asked to do. The
  agent refuses unless the service manager reports this very process — an
  unsupervised agent would be stopped rather than restarted, so it will not
  exit into nothing — and refuses when the definition would take the node's
  running panes down with it, unless the caller passes `force`. Cookie only,
  owner or `edit`, `local` refused (the control plane manages itself through
  its own routes instead), audited as `node.service` with the verb and whether
  it was forced. The honest note is about availability rather than
  confidentiality: an `edit` grantee may restart a machine they do not own,
  which briefly takes every subshell running there offline — including the
  owner's, and including those of other people the node is shared with. The
  pane-safety refusal is what keeps "briefly offline" from being "closed".
- **`stop` and `uninstall` are owner-only, and that is structural rather than a
  permission nicety** (2026-09-12). Every command reaches a node over the
  AGENT'S OWN socket, so the plane can never start an agent that is not
  running: those two end the connection that would have carried the verb
  undoing them. They are one-way from a browser and reversible only by someone
  with a shell on that machine, so they sit with the owner rather than with an
  `edit` grantee, who is trusted to interrupt a machine and not to make it
  unreachable. `force` is refused outright on `start` and `install`, which
  cannot end a pane — a flag accepted where it does nothing teaches a caller
  that it is noise.
- **An enrolled node's agent log is readable over HTTP** (2026-09-12). `GET
  /api/nodes/:id/logs` serves a byte range of a file the agent now writes
  itself — 0600, capped at 200 KB, replaced when full — because its console
  output goes to a journal under systemd and a file under launchd, and neither
  is readable from a browser. Most nodes are headless, so this is the only way
  to read one at all. Same accounting as the server's own log: the set of
  people who may read it does not change (0600 on disk, owner or `edit` on the
  wire); what widens is the set of PLACES they can read it from. An agent logs
  launch failures, command refusals and connection errors. It does not log pane
  content, and it does not log argv — which carries a subshell's bearer token,
  and is the one thing that would turn a log read into a credential read.
- **The plane can repoint a node, and that IS a widening** (2026-09-12). `PATCH
  /api/nodes/:id/config` sends a signed `set_server_url`, which the agent
  applies through the same `runConfigure` the CLI uses. Doing this locally
  grants nothing (see below); doing it REMOTELY is a different act. The machine
  then dials whatever host was named carrying `Authorization: Bearer
  <nodeKey>` — a credential valid on THIS plane — and it leaves this instance
  until someone points it back. So it is **owner-only**, not `edit`; the
  address is validated by component and stored canonicalized; loopback is
  refused outright, because nobody is sitting at a headless machine to notice
  it dialing itself; and it is audited as `node.config.update`. The audit names
  the NEW value only — which address a node dials lives in that machine's own
  config and is reported by nothing on the wire, so recording a previous value
  would mean inventing one. It does not restart the agent: the address takes
  effect on the next start, and choosing when is the operator's.
- **Repointing a node grants nothing** (2026-09-08). `subshell configure
  --server <url>` rewrites `serverUrl` in the agent's own `config.json` — a
  0600 file whose local OS user could already edit it by hand — keeping
  `nodeId`, the node key, and the pinned `controlPublicKey`. So it spends no
  setup key and mints no second node row, and the new control plane must still
  hold the key matching that pin or every command it sends fails verification.
  What it DOES do is send this node's key to the newly named host: the daemon
  dials with `Authorization: Bearer <nodeKey>` on its next connect
  (`apps/node/agent/src/daemon.ts`), so a repoint discloses a credential valid
  on the OLD plane to whatever host was typed. That is no privilege gain — the
  local user already holds that key and could send it anywhere — but it is why
  a repoint should be treated as naming a host you trust, not merely as an
  address correction. What changes otherwise is where this machine ANNOUNCES
  itself, which is why the enroll-time `nodeWsUrl` is cleared with it (otherwise the daemon keeps
  dialing the old host while the config names the new one). The old plane
  simply loses the node. This is why the operation is deliberately not gated
  behind a confirmation in Subshell Client, where re-enrolling is: it is
  reversible, and it grants nothing. The corollary is that it only WORKS
  between two names for one plane — a different plane refuses the node key and
  the node goes offline until it is pointed back or enrolled afresh, which the
  UI says. It also does not rename: `config.json`'s name never reaches the
  plane outside the enroll body, so the plane owns a node's name.

### What the node discloses to the plane (protocol 10)

Connecting a node is itself a disclosure, and the frames it rides on are
bounded on purpose:

- **`ready` discloses machine facts**: `agentVersion`, protocol/os/arch,
  `hostname`, the agent's `dataDir` path, its capability set, the
  `selfInvoke` prefix for re-entering the agent's own binary (paths under
  the node's own user; `ready.mcpLaunch` became this in protocol 4),
  `homeDir`, and — from agents that report it — the `runtime` supervision
  snapshot. Resume-path defaults hang off the home; the plane cannot
  expand `~` against a filesystem it cannot see.
- **`detect` answers binary facts and named env values.** The PLANE names
  everything it asks: the `detect` command carries the detection rules
  (one per harness this instance's registry resolves) and `envNames` —
  the union of `subshell.hostEnv` across the instance's ENABLED harness
  manifests (today: `CLAUDE_CONFIG_DIR` from claude-code). The node
  answers which binaries exist where, their RAW `--version` text, and
  the VALUES of exactly the asked names it actually has. It never scans
  its environment, never answers an unasked variable, and holds no
  manifests — it cannot even learn what a future plane version might ask.
  The values exist because resume-path computation moved to the plane
  (spec 2026-09-10 §5 as amended): a path built without them silently
  points at the wrong transcript directory.
- **Everything is bounded by the connection's trust, which is the node
  key's trust.** A forged `detect` is impossible without the signing
  keypair (§above), so the question of "who may ask" is the question of
  who owns the control plane. The disclosure is one-directional: the
  plane's manifests shape what the node reveals, and installing a plugin
  (admin-only, §below) therefore also decides what env names every
  enrolled node will be asked about. That is a real widening to
  account alongside §11.9 — a plugin's declaration cannot read an
  arbitrary variable (the node answers only declared names, and only
  harness plugins declare), but it does name what may be asked.
- **Being HELD is disclosed to everyone who can see the row** (spec
  2026-09-15). When the plane refuses an agent for its version or its
  protocol it now holds the socket instead of closing it (§11.12), and
  `held: { reason, agentVersion }` rides on the node view for every viewer,
  not only for a manager. That is deliberate and it is the same disclosure as
  the `agentVersion` already sitting beside it: "the agent on this machine
  needs updating" is what anyone looking at the row needs told, and it is not
  in the class of `runtime`, which names a machine's paths and pids and stays
  owner-or-`edit`.

### Directory allowlist (spec 2026-09-05)

A node owner may restrict **where** subshells can be created on their machine:
`PUT /api/nodes/:id/allowed-dirs` stores a set of absolute directories, and a
subshell may only be launched in one of them or beneath it.

- **Empty means unrestricted**, not "deny everything" — every node predating
  the feature is unaffected, and clearing the rules returns a node to that
  state.
- **Owner-only to edit** (`canManage`), deliberately not `edit`: any node
  share lets the grantee launch there, so an `edit` grantee able to widen the
  list to `/` would face no restriction at all. (Plugin installs used to sit
  behind this same gate; since the 2026-09-10 inversion they are instance-level
  admin acts, and this bullet stands alone.) The rules are **read-visible to everyone who can see the node**,
  grantees included — a refusal is unexplainable without them, and they name
  directories rather than contents.
- **Enforced twice.** The control plane checks the resolved cwd at create and
  restart; the node checks every `launch` and `stat_dir` against a copy it
  persists at `<dataDir>/allowed-dirs.json` (0600). The second check is the
  point: signing proves *who* sent a launch, never *whether* the directory is
  permitted, so a list carried inside the command would be worthless against a
  compromised control plane.
- **Rules are stored already-resolved on their node** (via the same
  `validateWorkingDir` the launch gate uses). Storing them as typed made the
  planes disagree — `/tmp/work` never matching a candidate that resolved to
  `/private/tmp/work` — refusing the owner the directory they had just
  permitted. That divergence was fail-closed (the server refused what the node
  would allow, never the reverse), and it is gone.
- **Restarts are gated too**: a restart spawns a fresh pane in that directory.
  Panes already running are untouched by a rule change.
- **Browsing is not gated on the node** — the folder picker is filtered by the
  control plane for callers who cannot manage the node, and unfiltered for the
  owner, who browses in order to choose what to permit. That filter is UX,
  never the boundary; the launch gates are.
- **Stale window**: a node offline when the rules change keeps its previous set
  until it reconnects, when the `ready` push reconciles it. The control-plane
  check holds meanwhile, so the window matters only if the control plane is
  itself compromised — the assumption the whole node plane already rests on.
  A push failure is logged, not surfaced.
- **Fail-open on an unreadable rules file.** A corrupt or missing
  `allowed-dirs.json` reads as unrestricted rather than deny-all. Deliberate:
  the list is a restriction an owner opts into, not an authentication decision,
  and a disk hiccup must not take a node offline for every launch. The control
  plane still enforces its own copy.
- Changes are audited (`node.allowed_dirs.update`).

- **Setup keys** are single-use, expire in 24 h, are listed in full to the person
  who minted them, are revocable, and are audited. The install command embeds one
  in a URL, so it lands in shell history and server access logs — the same posture
  as enrollment links everywhere. Revoking is deleting the key, and the row it
  leaves behind is the record of what was minted: the mint's audit event carries NO
  metadata, so the key text never enters the audit trail (`create-setup-key.route.ts`).
  Storage and disclosure: the next subsection.
- **Who may MINT one is an instance setting** (`allow_node_enrollment`; admin
  toggle under Settings → General, audited `settings.update`). An absent row
  means TRUE, so an instance that never touched it keeps the behaviour it had:
  any signed-in user may add a machine. Turned off,
  `POST /api/nodes/setup-keys` refuses non-admins with 403 and admins are
  unaffected — the same shape as an admin creating a user through
  `POST /api/users` while sign-up is closed.

  Enforced at the mint and nowhere else, because that is the only chokepoint:
  `NodeSetupKeysRepository.create` has one call site, and `NodesRepository.create`
  has two — the enroll route, which requires a consumed key, and boot seeding of
  the `local` row. Enrolling is unauthenticated by design (the key IS the
  credential), so there is nothing to gate at `POST /api/nodes/enroll`, and
  gating it would refuse keys the instance itself handed out.

  **It does not revoke what is outstanding.** Flipping it off means "stop
  handing these out", not "invalidate the ones already minted" — the same
  semantics as closing registrations, which signs nobody out. An unconsumed key
  stays usable until it expires (24 h) or an admin deletes it, which is the act
  that revokes and is separately audited. The switch bounds the FUTURE; the
  ≤24 h window it leaves is closed by deleting keys.

  It governs ADDING a node only. Who may launch on one they were shared, and
  what a share confers, are the unchanged axes above.
- **Artifacts are never anonymous.** Prebuilt binaries and their `.sha256`
  digests (`GET /api/downloads/node/*`) require a session cookie **or** a valid
  unconsumed setup key. `GET /install.sh` renders a usage script for an
  invalid/absent key — it is never a binary oracle — and the script it renders
  digest-verifies the download before the first `chmod +x`. The render also
  accepts `server=<origin>`, the address the node will dial forever (the
  Add-node dialog's address choice; the process cannot observe its own
  external address — §8): accepted ONLY
  as exact membership of the live trusted-origin registry, else the configured
  base URL is baked as before. The param therefore selects among addresses the
  instance already trusts and already discloses to every signed-in caller
  (§3) — it can name no new master for a node, and whoever runs the command
  chose every byte of its URL.

### Setup keys are stored in plaintext (2026-09-17)

Until the node-setup revamp a setup key existed as a SHA-256 digest at rest and as a
plaintext string exactly once, in the response that minted it. Now the row holds the
`nsk_…` text and the Nodes page lists it, because a page cannot render a digest. What
the digest bought, and what was traded against it:

- **What it cost to lose.** A database read — a stolen backup, a local OS user, a
  `subshell-server backup` file — now yields every key minted in the last 24 hours
  that is still unused, instead of nothing. Anyone with that read can already mint a
  key of their own, and can already read the node keys, the session tokens and the
  password hashes in the same file, so the CLASS of secret is unchanged; what changed
  is that a minted-but-unused key is disclosed by the same read rather than being
  recoverable only from a shell history file or an access log.
- **What it bought, and why it was worth it.** An unused key the dialog was closed on
  used to be an open enrollment door that could be CLOSED but not READ, so the only
  remedy was revoke and re-mint — and the operator standing mid-`curl` with a
  half-copied command had no way back. The card that lists keys exists so those doors
  stay visible; listing the text is what makes it useful.
- **Why the exposure is bounded rather than open-ended.** A key enrolls ONE machine,
  redeems ONCE (`used_at` flips in the redemption transaction, which is the
  single-winner gate), and stops working entirely at `expires_at` (24 h). A used or
  expired row's key is inert on sight, and the card says which state each row is in.
  The list is owner-scoped and cookie-only: a bearer credential cannot enumerate
  enrollment doors (`GET /api/nodes/setup-keys` answers 403 to a machine token), and
  one caller sees its own rows and nobody else's.
- **The `label` went with it.** The mint dialog's "Node name" became only this column,
  because the one-liner ran `subshell setup` with no `--name` and the node was named
  by its own hostname whatever had been typed. Naming moved to the machine that knows
  its own hostname: `setup` asks (the hostname prefilled, Enter accepts), `--name`
  answers for a script, `SUBSHELL_NODE_NAME` answers through the pipe, and the Subshell
  Client Enroll step requires the field. `POST /api/nodes/setup-keys` therefore takes
  no body at all, and `POST /api/nodes/enroll` normalizes the name with the control
  plane's one label rule (`normalizeNodeName`) before it is stored — the same function
  rename applies, so the two doors cannot disagree about what a name is.
- **The migration drops every outstanding key** (`0033-setup-key-plaintext.ts`
  rebuilds the table): a digest cannot become plaintext, so there was nothing to carry
  across. Keys are ≤24 h credentials and the acts on them are already in the audit log;
  an instance mid-install when it boots simply runs the dialog again.

Redemption is unchanged: lookup, validity probe and the transactional consume all
match on the key text, so guessing one is the same 192-bit problem it always was. What
the two key-bearing routes SAY is unchanged too, and is worth stating beside a
credential that is now readable:

- `GET /install.sh` answers the SAME usage script for an absent, unknown, spent or
  expired key — it is no oracle about which of those is true, and that is why it can
  stay unauthenticated.
- `POST /api/nodes/enroll` deliberately answers three distinct 401s (invalid, already
  used, expired) — a decision from the original spec's ledger 17a, so the person
  standing at a new machine learns whether to mint a fresh key or to hurry. It is not
  a widening: it describes only a key the caller already presented, and under the new
  storage a caller who could obtain one would hold it in the clear regardless.

**Agent binaries are fetched lazily from the project's own release
(2026-09-12).** A control plane installed from a release tarball has an empty
`node-artifacts` directory, so every install one-liner used to 404 until an
operator ran `release:node` from a checkout. The repository is public, so the
server now reads the same release it was telling people to copy from. The
posture:

- **Nothing is fetched until a machine asks.** There is no warm-up, no
  boot-time sweep, no admin button and no background poll — the entry point is
  the download route's 404 branch. A plane whose nodes are all one platform
  never spends a byte on the others, and a plane nobody enrolls against never
  reaches the network at all. The request that triggers a fetch is already
  authenticated (cookie or unconsumed setup key), so this is not a way for an
  anonymous caller to make the plane fetch anything.
- **The bytes are streamed through and hashed on the way past**, against the
  digest from the release's own `.sha256` asset, which is fetched first. A
  mismatch ERRORS the response mid-flight, so the node sees a truncated
  download; nothing unverified is ever cached. What makes streaming sound
  rather than merely fast is the check that was already there: `install.sh`
  verifies the digest itself before the first `chmod +x`, so the node never
  trusts the plane's word for what it received.
- **The digest only proves the bytes match what that release published** —
  over the default GitHub HTTPS endpoint that is GitHub's assurance, and over
  an operator-set `SUBSHELL_RELEASE_URL` it is their own network. The
  same sentence the plugin registry carries, for the same reason.
- **`SUBSHELL_RELEASE_URL` was `SUBSHELL_NODE_RELEASE_URL` until 2026-09-15**,
  and the rename is not cosmetic: the same list now answers for the server's
  own `update` and both desktop apps' too (§11.12), so the setting stopped
  being the node agent's. There is no alias — this project has no installed
  base to keep compatible, and an alias is a second thing to read that can
  disagree with the first.
- **Empty disables it**, and that is the supported air-gapped configuration:
  the routes then serve only what is on disk, exactly as before. Since
  2026-09-15 it disables strictly more — `subshell-server update` and
  `POST /api/nodes/:id/update` refuse with the reason and name `--from` or a
  hand install. The Nodes dialog's "no agent binary" warning is kept for
  precisely that case, where it is still exactly true.
- **Only a release this plane can TALK TO is offered** (tightened 2026-09-15).
  The old rule was "newest above `MIN_AGENT_VERSION`", which could hand a
  machine an agent speaking a protocol this server does not — it would enrol,
  reconnect, and be refused forever. `compatibleNodeRelease()` now requires the
  release's own `release-manifest.json` to declare THIS server's
  `NODE_PROTOCOL_VERSION`, and a release carrying no manifest — every cut
  before 2026-09-15 — is refused BY NAME rather than guessed at, with the
  reason rendered on the Updates page. Drafts are still skipped: the release
  pipeline publishes draft-then-live.
- **Only what this instance fetched is ever deleted.** Cached artifacts are
  recorded in `<node-artifacts>/.fetched.json` with the release tag they came
  from; when a newer tag is resolved, files recorded against an older one are
  removed (not refreshed — the platform comes back when a machine of that
  platform next enrolls). A binary an operator published by hand has no
  manifest entry and is never touched, and a file on disk always wins over a
  fetch.

**The enroll-time loopback trap.** If the configured server URL is
loopback-ish, a remote node will dutifully dial its own machine. The enroll flow
and the Nodes page surface the resolved URL and warn on loopback; public settings
carries `appBaseUrl` so the dialog shows exactly what the server will bake.

**Two different things can stop launches on a node, and they are two axes
rather than two switches** (spec 2026-09-14). Shares answer WHO may launch;
**maintenance** answers whether anyone may.

**Narrowing the control-plane host** is still an admin removing the `local`
node's seeded Everyone/`edit` share row, and it still survives restarts: boot
seeding creates that row only when the `local` node row itself is created,
never to "repair" a deliberate removal. What it means is unchanged — nobody is
granted launch access — and the remedy is a share, not a switch.

**Maintenance is a per-node flag** (`nodes.maintenance`, with the stamp and the
origin beside it) that every node has, `local` included. It says the machine
stays enrolled and answers every other command — service control, logs,
detection, restart, config — but takes no new subshells. Turning it on
**terminates every subshell running there**, whoever owns them, and the two
ends that can set it are `PUT /api/nodes/:id/maintenance` (owner only; admin on
`local`; the same gate as delete and re-share) and the machine's own
`subshell maintenance on|off`.

Three properties of that pair are worth stating rather than inferring:

- **It reaches past the person who throws it.** Any node share lets a grantee
  launch there, and what they launch is private to them — so a node's owner
  stops work they cannot enumerate, belonging to people who did not act. The
  owner is told a COUNT and nothing more; the owners of those subshells learn
  by push. `GET /api/nodes/:id` carries that count (`runningSubshells`) on the
  manage gate alone, which is a real disclosure in its own right: it tells a
  machine's owner how much otherwise-invisible work sits on it.
- **It is retroactive, deliberately unlike `allow_node_enrollment`**, which
  bounds only the future. Maintenance stops what is already running; that is
  the point of it, and it is why the confirmation names the number.
- **Either end may overrule the other**, newer stamp winning and ties going to
  the plane. The plane can end a window an operator opened at the machine —
  decision 5 of the spec, with "machine wins" offered and declined. So can the
  reverse: a machine chooses its own stamp, so a COMPROMISED one can always
  present a winning value and clear the flag. That costs nothing, and the
  reason is the boundary already drawn above — whoever can send that frame
  holds the node key, which means they are the local OS user on that machine
  and already own every pane launched there, its files, and the bearer token in
  each pane's argv. **Maintenance is a routing preference, never a quarantine**:
  it keeps answering every other command, so it was never a containment control
  and must not be described as one. What actually contains a suspect machine —
  deleting the node, rotating or disabling its key, clearing its shares — is
  cookie-gated, and a node key reaches none of it.

The node ALSO enforces the flag from its own mirror file, fail-closed, on every
launch. That is defence in depth against a plane that has not learned yet, not
a second switch: both copies fall to the same credential.

**It applies to ADMINS too** (2026-09-12). `resolveNodeAccess` ranks every admin
at `edit` on every node, so before this the one person who could throw the
switch was the one person it never applied to, and the setting quietly meant
something different for whoever set it. `nodeCanLaunchOn` therefore reads the
GRANTED access for `local` — the admin boost still confers management, never
launch. Two consequences worth stating:

- `local` becomes **visible and unlaunchable at once**. That is deliberate: an
  admin has to keep seeing the row to widen it again, and a node they cannot
  see is a control they cannot reach. Maintenance made that state ordinary
  rather than unique — any node in a window is visible and unlaunchable, and
  the launch picker greys it with the reason instead of hiding it, precisely so
  the way back is on screen.
- Its refusal is a **403**, not the 404 an invisible node answers with. The
  404 check runs first, so the 403 can only ever name a row already on the
  caller's own Nodes page — it is not an id-existence oracle.

Nothing else changes: for a viewer who was never boosted the two readings are
the same value, and the machine-actor path (`allowAdminAndShares: false`)
resolves them identically, so a bearer token neither gains nor loses anything.

### Plugin installs from the registry (spec 2026-09-09; instance-level since 2026-09-10)

Phase 3 taught the plugin system a network source, and the 2026-09-10
inversion moved it to a single door: `POST /api/plugins` may carry a package
spec, and the CONTROL PLANE fetches that npm package, verifies it, and
installs it into `<SUBSHELL_SERVER_DATA_DIR>/plugins/` — the one store every
node executes against
([phase-3 design spec](superpowers/specs/2026-09-09-plugins-phase3-registry-design.md),
[inversion spec](superpowers/specs/2026-09-10-plugins-on-the-control-plane-design.md);
bare `§N` below means the phase-3 spec's sections). The master spec's §13
posture carries forward onto the new door, unchanged:

- **It is an explicit act with a named source.** Nothing ever fetches a plugin
  on its own — no catalog, no update sweep the operator did not run. Installing
  a plugin is the same trust decision as installing the harness CLI the plugin
  drives: whatever gets installed runs in the control-plane process,
  unsandboxed, in the process that holds the node signing keypair
  ([§11.9](#119-plugins-run-in-the-control-plane-process)).
- **Admin-only, on the one door.** Every `/api/plugins` write is a cookie-admin
  act (bearer keys refused, like every other management surface) — one install
  arms every node, so it cannot be a node owner's decision. The per-node door
  (`POST`/`DELETE /api/nodes/:id/plugins`) and the agent's `subshell plugin`
  verbs are gone, not widened. And the anonymous setup route stays
  built-in-ids-only forever: it answers with no credential at all on a fresh
  instance, so the registry is not in its grammar at all — its body carries no
  spec field, and the built-in-ids guard in `api/setup.route.ts` stands
  (master-spec §13's load-bearing line).
- **Integrity is verified before anything is written.** The tarball's sha512 is
  checked over the raw bytes against the hash the registry announced, the
  vendored extractor refuses everything npm never ships (links, traversal,
  oversize), and the module load-check runs against a staging copy — a refused
  install leaves the previous state byte-identical.
- **Any package name is installable — deliberately, decided against an
  allowlist** (spec §2.3). The four facts above are the control; a name list
  would be a second one no complaint asked for.

Two sentences about the channel rather than the code:

- **The registry URL is operator-configurable, and integrity is only as strong
  as the channel to the registry you configured.** The server's
  `SUBSHELL_PLUGIN_REGISTRY_URL` may name an http mirror, because a corporate
  mirror is the motivating case — but the hash then only proves the bytes match
  what THAT server published. Over the default `https://registry.npmjs.org`
  that is npm's own assurance; over an http mirror it is the operator's own
  network. `subshell-server status` prints the URL that will be used. (The
  agent's `registryUrl` config and `subshell configure --registry-url` are
  gone: a node fetches nothing.)
- **A plugin id is claimed by the manifest inside the tarball, so id collisions
  are refused against what is installed** — a second package claiming a
  directory another package owns is refused naming both (§2.4). A registry
  package claiming a BUILT-IN id is logged once and never loaded: the compiled
  copy always answers for its own id. Across an uninstall there is nothing to
  collide with, and that is honest: removing the directory is the operator
  saying the slot is free. An id switch is not a privilege hop, either: both
  the old and the new code run in the control-plane process with the same
  visibility.

## 7. Encrypted channels

Cross-subshell messages are sealed per recipient with ECDH-ES + A256GCM (`jose`,
P-256) to each subshell's identity keypair. The server stores and forwards
**opaque General JWE envelopes it cannot read**; all crypto happens client-side
in `subshell mcp`.

### What the boundary protects

Message **bodies**, from: the server's storage and backups, any remote peer that
compromises them, and any subshell that is not a recipient. Reads are
recipient-filtered by a denormalized recipients table, so the server can answer
"posts you can decrypt" **without decrypting them**.

### What it does not protect

- **Metadata** — channel names, membership, post timing and ordering, message
  sizes, and principals are all plaintext on the server.
- **A local OS user on the host** — keypairs live on the same disk the backend
  runs on. Whoever owns that account can read them, and the panes besides.
- **The subshell tokens themselves** — a running harness holds its own bearer key
  by design, and it is `ps`-visible.

### Peer-key pinning (TOFU)

The sealing side pins each peer's exact public JWK on first post
(`<dataDir>/peers.json`, 0600) and requires byte-equality thereafter. A
compromised relay cannot swap a roster key without every sender hard-failing.
Absent or misspelled `SUBSHELL_CHANNEL_PIN` means strict; only the exact value
`trust` opts out.

The honest operational cost: when a member *legitimately* recovers its identity —
corrupt file, fresh keypair, re-register — every peer's next post to a shared
channel **hard-blocks** on the stale pin. That is the pin working, not an attack.
Recovery is manual per peer: delete that principal's entry from `peers.json` (the
error names the file) and the next post re-learns the key.

### Bounds

Envelopes ≤ 128 KiB and structurally validated on POST (must parse as JSON, have
`ciphertext`/`iv`/`tag` strings and a non-empty `recipients[]`). Nothing
server-side ever parses `ct`. Channel slugs match
`^[a-z0-9][a-z0-9-]{0,63}$`. Long-poll waits are clamped to 600 s so a client
cannot pin a socket indefinitely.

**Nudges never press Enter.** A nudge types a fixed, Enter-less line into the
tmux panes of running recipients. It never auto-submits anything into a shell,
and it never fails the post.

## 8. Network boundary

**Binding.** `HOST=0.0.0.0` by default — the LAN bind. A loopback socket is
unreachable from every other machine, and remote nodes and client devices are
the point of a control plane, so since 2026-09-07 a fresh install listens on
all interfaces; `HOST=127.0.0.1` in `config.env` restores loopback-only. This
sits inside the trusted-network posture of this section, not against it: every
`/api/*` route still requires a session or key. It does mean a first-run
instance is reachable from the local network before an operator touches
anything — registration is open by default, and a dev-mode (`NODE_ENV` unset)
boot runs on the placeholder `BETTER_AUTH_SECRET`, so on a network you do not
own, bind loopback or set the env before first boot. Browsers on a LAN
address: the machine's own IP addresses are trusted automatically since
2026-09-17 (`services/lan-origins.ts`, see the allowlist note below) — a
LAN *name* still needs `APP_BASE_URL` pointed at it (or `TRUSTED_ORIGINS`),
because an interface address proves the entry names this host and a name
proves nothing. Both fields are settable from the CLI and from the
dashboard's Addresses card (Server Settings → Networking since 2026-09-17; → Service before that).

**CORS is an allowlist with STATIC SOURCES and a LIVE READ.** Four sources,
none of them the request: the instance's own origins (derived from
`SERVER_PORT`/`HOST`/`APP_BASE_URL` — both loopback spellings, a concrete
`HOST`, the base-URL origin), the machine's own non-internal IPv4 interfaces
on a wildcard bind (`services/lan-origins.ts`, added 2026-09-17 — see the
trap below), the operator's `TRUSTED_ORIGINS`, and the addresses each enabled
network plugin's own daemon reports for THIS host
(`services/trusted-origins.ts`). The list is assembled on demand — better-auth
1.7.1 calls the function form per request, `@elysiajs/cors` per request — so a
network joined a minute ago is trusted without a restart; what was frozen at
boot until 2026-09-16 is read live now, and nothing about a request names an
entry. The LAN probe is the kernel's answer for this host, read the same way
the plugin's daemon answers for its network, and it stays inside the
rebinding rule: an entry naming a LITERAL IP can never be matched by a
rebinding attack, whose `Origin` is always the attacker's hostname string.
The probe re-asks on `GET /api/settings/public` — the request every signed-in
page makes, and the mobile dialog repeats on open — so a laptop that switched
Wi-Fi stops trusting (and so stops offering) the address of the network it
left; between reads, the cached set is what the auth and CORS paths consult. Every derived entry
is serialized through `URL.origin` (fixed 2026-09-08). It used to be string
concatenation for three of the four, which made them **inert on a default-port
deployment**: bound to 80 with a concrete `HOST`, a browser sends
`Origin: http://192.168.1.5` — no port, since 80 is the scheme default — so the
derived `http://192.168.1.5:80` matched neither better-auth's equality nor
either CORS branch, and the LAN address 403'd while `localhost` worked (the
base-URL entry was the one that had been normalized). A mixed-case `HOST` failed
the same way. It is deliberately
**not** "trust the origin that matches the request host": that is precisely the
DNS-rebinding hole the allowlist exists to close. Permissive CORS is acceptable
here only because the service is not internet-facing.

**Since 2026-09-08 the list is configurable without editing config.env** —
`subshell-server configure --trusted-origins <origin,origin>`, and since
2026-09-12 the dashboard as well — the Addresses card, on Server Settings →
Service until it moved to → Networking on 2026-09-17 (the Subshell Server
console that first carried the field is gone; its half of this moved into the
served page, §11.11). This is a usability fix for a real trap rather
than a widening of the model, and the DNS-rebinding rule above is untouched.
Every one of those surfaces writes through the same `applyConfig`, so the
validator below is still the one narrow point rather than one of several. The
trap:
on the default `0.0.0.0` bind the derived set was only the two loopback
spellings (a wildcard bind is a listen address, not one anyone visits), so a
phone or a LAN hostname sends an `Origin` nothing matches and sign-in dies on
`403 Invalid origin` — with nothing in the failure naming the key that fixes it.
Since 2026-09-17 the machine's own interfaces are derived too, which closes
the phone-on-the-same-Wi-Fi case with no operator act at all — it was the
"Subshell for Mobile" dialog that forced the question: a picker can only
offer addresses sign-in will ACCEPT, so the QR it could honestly show on a
stock instance was none. What the trap still holds for is spellings beyond
this machine's own addresses: a LAN hostname (`box.local`, local DNS) still
needs an explicit entry.

Six properties of that surface are load-bearing:

- **Every entry is validated by COMPONENT and stored canonicalized.** Both
  consumers compare against the origin a browser actually sends, so acceptance
  and canonicalization have to agree: the scheme must be http(s), there must be
  a host, and a path, query or fragment is refused — then `URL.origin` is what
  gets written. That admits the spellings people type (a trailing slash,
  mixed-case hosts, the expanded IPv6 form, an explicit `:443`) and stores the
  one form both consumers match. Accepting a spelling WITHOUT canonicalizing it
  would write a config that 403s while the command reported success.
  Credentials are the deliberate exception: `URL.origin` drops them silently,
  so `http://u:p@host` is refused rather than quietly stripped.
- **Wildcards are refused, and that refusal is the only thing making this
  section's static-allowlist claim true.** The consumers of this array read it
  looser than it is written, in different directions — one still does, one has
  not since 2026-09-16 — so the CLI validator is the narrow point:
  - **better-auth** (`matchesOriginPattern`, 1.7.1) branches on the pattern:
    an entry containing `*` or `?` goes to `wildcardMatch` instead of the exact
    `pattern === getOrigin(url)` comparison. Measured: `TRUSTED_ORIGINS=https://*`
    trusts **every** https origin, `https://evil.example` included. That
    dissolves the allowlist entirely — and CORS does not save it, because CORS
    is a browser courtesy rather than a server-side gate (a non-browser client
    sends whatever `Origin` it likes, and better-auth's check is the only thing
    in the way).
  - **@elysiajs/cors** (1.4.2) tries an exact map hit and then strips the
    scheme off the incoming `Origin` and compares the remainder — so a
    SCHEMELESS entry (`box.local:3080`) is a scheme-wildcard there, matching
    both `http://` and `https://`, while better-auth rejects it outright. A
    schemeless entry therefore yields "CORS passes, sign-in 403s". Since
    2026-09-16 the CORS predicate is exact membership of the live registry
    (`corsOriginAllowed`, `server.ts`), so that schemeless-match branch is no
    longer reachable at all — the refusal still matters because better-auth's
    `wildcardMatch` is unchanged.

  `validateValue` refuses both shapes (`config-values.ts`), so nothing the CLI
  flag or the dashboard can write reaches either behaviour. It matters
  that this is enforced rather than conventional: before these surfaces
  existed, the key was reachable only by hand-editing config.env or setting
  the env var — both of which still bypass the validator, and neither of which
  a threat model can assume away. Adding wildcard support means revisiting this
  section first.
- **A value already on disk is preserved, not refused.** `configure` passes
  through a resolved value byte-identical to what config.env already holds,
  warning rather than failing, because preserving what the boot already reads
  grants nothing new — and refusing it wedged the desktop console, which seeds
  stored values and re-sends every field on save. So a hand-edited wildcard
  (honoured by better-auth, refused by this writer) no longer makes the port
  unchangeable from the GUI. Only a CHANGED value must satisfy the validator,
  so this is not an escape hatch: a newly typed wildcard is still refused.
- **The bypass is diagnosed, not blocked.** `subshell-server status` reports
  per-entry `problems` for `TRUSTED_ORIGINS` and `APP_BASE_URL` — what a
  browser will do with a value the boot accepted — together with the LAYER
  that supplied it, and the dashboard's Addresses card (Server Settings →
  Networking since 2026-09-17) renders it beside the field. That is deliberately a diagnostic rather than a boot
  check: a throw in
  `constants.ts` would brick the `configure` that repairs the value, and a boot
  warning could not name the layer, so it would send an operator to edit a
  `config.env` that was already right. Wildcards are excluded from the
  diagnostic because better-auth honours them.
- **The key is written or removed, never written empty.** Its built-in default
  is a non-empty list (the dev Vite origins), and config.env outranks `.env` in
  the precedence ladder, so a `TRUSTED_ORIGINS=` line would silently strip
  those origins on a developer's machine. `--trusted-origins ""` therefore
  removes the key rather than emptying it. A hand-written empty value is
  likewise turned into "absent" by the next `configure` run, which knowingly
  loses a deliberate "trust nothing extra" — the two states differ only in the
  precedence ladder, where an empty value beats `.env`, and that is the footgun
  the key avoids writing in the first place. Set the env var for that.
- **`APP_BASE_URL` is also better-auth's passkey rpID** (§2, Passkeys), so
  changing it moves which host passkeys work on — an existing passkey stops
  working on the old address, the loopback-pinned desktop window included.
  Adding a name to `TRUSTED_ORIGINS` has no such effect, and is the correct
  lever for "this instance is also reachable at".

**Production refuses to boot on the placeholder secret.** With
`NODE_ENV=production`, better-auth exits early unless a real
`BETTER_AUTH_SECRET` is set. Production also enforces the origin check strictly,
which is where a mismatched origin surfaces as `403 Invalid origin` on
sign-in — not in dev.

**Instance-level plugin secrets: designed, NOT yet built** (inversion spec
§9.2). Once plugins run in the control-plane process (§11.9), a credential a
plugin needs while building argv must be readable here. The mechanism was
decided on 2026-09-10 and is deliberately unimplemented until a plugin
actually needs one: AES-256-GCM via `node:crypto`, the key from
`SUBSHELL_SECRETS_KEY` in the environment — never a settings row, never the
database, so a stolen database file is not a stolen credential; write-only
over the API (a read reports only that one is set; no response body, log line
or audit entry carries it); **fails closed** — with the variable unset,
writing a secret is refused rather than stored in the clear. And say it now,
beside the secret guidance above, because an operator who learns it during a
restore has learned it too late: **a lost `SUBSHELL_SECRETS_KEY` is
unrecoverable by construction** — losing it means every operator re-enters
their secrets. Two boundaries the design leans on: this store is NOT for a
credential the agent CLI needs inside its pane — that stays in the node's own
environment, where the control plane never sees it (inversion spec §9.1) —
and nothing in it is encrypted today because there is nothing in it today.

**WS attach.** Requires a short-lived (30 s), single-use token minted through an
authenticated REST call, cookie-session only. Replay-resistant: a second use
closes with `4001 unauthorized`.

**Rate limiting.** Login only, per email: no delay on a clean record, then
`2^n` seconds capped at 30 s. Emails are attributed lowercased and trimmed.
Passkey sign-in is deliberately **not** behind this backoff — it carries no email
to attribute failures to, and the physical authenticator is the gate. No other
endpoint is rate-limited.

## 8b. The desktop apps

Two Tauri v2 shells. `apps/server/desktop` ("Subshell Server") installs, runs
and manages a `subshell-server`; `apps/client/desktop` ("Subshell Client") is a
person's interface to a control plane and the place their machine is registered
as a node. Neither adds a server surface — every privileged thing they do goes
through a CLI as the same local user — but both hold a page this repo did not
ship, and both inherit the entitlement and executes-what-it-finds properties
below.

### The window that loads someone else's page

The split is the boundary, and it is a split by window KIND: every command
that touches a CLI, a config file, a service manager or the filesystem is
granted to BUNDLED pages alone. Each app has **two** windows now — one remote,
one bundled. The server app's `console` was deleted by spec 2026-09-12 and its
management surface moved into the SPA, leaving the remote SPA page plus one
bundled ASSISTANT (`capabilities/wizard.json`) that owns first run, recovery,
update and reset. What differs between the apps is how much the remote window
gets, and the difference follows from whether its origin can be known ahead of
time.

**Subshell Server — loopback, seven commands.** Its `main` window loads
`http://127.0.0.1:<port>`: the SPA served by the very server this app manages,
so the origin is knowable and is pinned four ways.

| Gate | What it does |
| --- | --- |
| `capabilities/main.json` | scopes the window to loopback URLs (`local: false`, `windows: ["main"]`) and grants only `desktop_open_assistant`, `desktop_shell_ready`, `desktop_notify`, `desktop_open_in_browser`, `desktop_permissions`, `desktop_app_update`, `desktop_set_supervision` and window dragging |
| `Probe::origin` | builds the URL from a VALIDATED port and a loopback host, never from `APP_BASE_URL`'s own scheme or port |
| `open_main` | refuses a non-loopback origin outright |
| `on_navigation` | pins the window to the origin it was opened with |

Six of the seven are chosen for what they cannot do: raise the assistant at a
named screen, drop this app's own title bar, display one fixed-shape
notification, open a page of THIS server in the system browser (a path only —
see below), read this app's own macOS permission states (no argument at
all — see the paragraph after the table), and read this app's own two update
version facts (no argument, no fetch — see the paragraph after that). The
seventh, `desktop_set_supervision`,
**does** drive the CLI and is the one deliberate exception; its accounting, including the three
caveats that make it honest, is §11.11 below. The count and the SCOPE are both
pinned — by `ui/src/__tests__/ipc-acl.test.ts` and again in Rust by
`control.rs` — because "a few harmless ones" is how a boundary erodes, and
because widening `remote.urls` would hand the same grant to a page on any
host with every command-name assertion still green.

**The permissions read, and the argument for it (2026-09-14).** `AGENTS.md`
held `main` at five and said a sixth needs the case made in writing. Here it
is. `desktop_permissions` answers two questions about the app's OWN standing
with the OS — may it post notifications, may it read Photos — and takes no
argument: it runs no program, reads no path, touches no service or config, and
changes nothing, so it cannot be pointed at anything. The dashboard needs it
because the operator's requirement is that a missing permission be said at
the moment it is needed, in the surface where it is needed, and two of those
moments (attaching an image; the standing state in Preferences) are in the
dashboard, which cannot know without asking. What an XSS in the SPA gains is
two booleans about the app's permissions, with nothing to act on. What stays
off `main` is everything that ACTS: requesting a permission and opening a
System Settings pane both live on the bundled page and are reached by raising
it — the command `main` already held — because a page that could pop system
panes on its own is a nuisance vector, and the request should come from a
press under a sentence the person can read.

**The acting half grew to two requests on 2026-09-17, and the boundary did not
move.** `desktop_request_photos` sits beside `desktop_request_notifications`
with the same grant (`wizard` only) and the same shape: no argument, one system
sheet, at most once per install, reaching no CLI, config, service or file. It is
pinned that way in `ipc-acl.test.ts` — both request commands are asserted absent
from `main`, present in `wizard`, and to an empty parameter list, because an
"asks a question" command that could take an argument is a different command
with the same name. What it asks is the same TCC subject the app's own image
picker raises when a person attaches a photo (the picker's panel runs in this
process, and `Info.plist` carries the usage description the sheet shows), so it
is a prompt moved to a place where it can be explained rather than a new
capability: an XSS in the served SPA still cannot make macOS ask anything.
`desktop_notify` also widened its
answer from nothing to `{ shown, permission }`: same call, same capability, now
reporting instead of guessing.

**The update read, and the argument for it (2026-09-17, spec 2026-09-17
§ 5.3).** `desktop_app_update` is the seventh. It takes no argument, makes no
network call, and touches nothing on the machine beyond this app's own
settings file: it answers `currentVersion` from this build's `PackageInfo` and
`availableVersion` from the one `settings.json` field the daily launch check
already writes — two version strings, the second `null` for "has not checked,
checked and found nothing, or could not reach", all present and none of them
actionable. **It never checks**: `desktop_check_app_update` stays
`wizard`-only, `desktop_install_app_update` stays `wizard`-only, so a page
cannot spend the daily budget or hammer a release source, and the row's
`[Update]` rides `desktop_open_assistant` — a command this page already holds
— to the bundled screen where installing lives. What an XSS in the served SPA
gains is two strings. Why it is here rather than behind a raised assistant is
the same argument the sixth made — say the fact at the moment it is needed,
in the surface where it is needed — with a smaller payload: the sidebar row
must know whether an update is waiting before anyone presses anything, and
only the app knows the version of its own binary. The server can tell a page
what SERVER build is running; it cannot see the `.app` wrapped around it.

**Subshell Client — any origin, and therefore ONE command.** Its `main` window
loads a control plane's own UI, and a control plane can live on any host: a LAN
address, a VPN name, a public hostname. That origin cannot be enumerated in a
capability file, and that has not changed. What changed on 2026-09-14 is that
the window went from being granted NOTHING to being granted exactly one thing,
so the boundary moved one level in rather than away: the capability's scope is
a wildcard (`http://*:*`, `https://*:*` — `http://*` alone does not match a
non-default port in the `urlpattern` crate Tauri 2.11.5 uses, which would
silently exclude the default `:3080` deployment), and the narrowness lives in
the command's ARGUMENT instead.

The accounting, stated plainly:

- **What it can do.** `desktop_open_in_browser` opens one page of the plane
  this window is already on, in the person's default browser. The page supplies
  a PATH; the ORIGIN is `windows.rs`'s `PlanePin` — the same value that
  window's navigation guard already enforces. So the widest thing an XSS in a
  control plane's SPA gains is opening a page of that same plane, which the
  person can do by typing the address.
- **What it cannot do.** Name a host. The path must begin with `/`, must not
  begin with `//` (protocol-relative is another HOST), must contain no `://`,
  no backslash (the WHATWG URL parser treats `\` as `/` for special schemes, so
  `/\evil.test` is `//evil.test` in another spelling), and no whitespace or
  control characters. The rule and its tests live once, in
  `crates/desktop-core`'s `browser` module, so the two apps cannot disagree
  about what a path is. It touches no CLI, no config, no service manager and no
  file. No `node_*` verb, no plugin permission and no `core:default` is granted
  to that window, and the ACL test asserts each of those by name.
- **Why the wildcard scope is sound.** It is not a widening of WHO may invoke.
  `on_navigation` pins the window to the origin it was opened with — and the
  pin follows a deliberate plane switch rather than being fixed at build time —
  so any page loaded there is the plane the person chose. The scope has to be a
  wildcard because that plane's address is the user's, not ours; the command
  behind it is what makes the grant narrow.
- **The marker now exists.** That window shipped no `SubshellDesktop/…`
  user-agent marker precisely because it was granted nothing: the marker is how
  `apps/server/web` decides it is in a shell, and every call it invited would
  have been refused one at a time. It now carries `SubshellClient/…`, a
  different PRODUCT TOKEN, and the SPA branches on it — `isServerDesktop()`
  gates the overlay title bar and the update, reset, supervision and native
  notification surfaces (all Subshell Server's), while `isDesktop()` gates only
  the two "Open in browser" surfaces. So the marker switches on the one thing
  this window can actually do.

**Two accepted properties, stated rather than left to be discovered.** Both are
true of this command in BOTH apps:

- **There is no concurrency guard.** `desktop_set_supervision` takes
  `ActionGuard::try_new` because a hundred interleaved chains can leave a
  machine with no service definition and no server; nothing here needs that,
  because the worst a loop achieves is opening browser tabs. A compromised page
  can do exactly that — spam the person's browser until they quit the app —
  which is a nuisance on a machine they are sitting at, not a path to anything.
  Adding a guard would buy a rate limit on annoyance and cost a lock on a path
  that otherwise holds none.
- **Refusals are invisible, by design.** The SPA calls it through the
  FORGIVING `desktopInvoke`, which resolves `null` rather than throwing (an
  older shell that knows no such command should do nothing, not error). So a
  path the Rust side rejects, or a Subshell Client with no plane pinned yet,
  renders as a button that does nothing at all. That is the right failure
  direction for chrome — chrome that throws is worse than chrome that is
  absent — but it means this control cannot report why it did not work, and a
  bug in the path it sends would look like a dead button rather than an error.
  The tray and menu routes, which are Rust-side, log their refusal to stderr.

Two consequences a person will notice, neither of which the command tries to
fix: the browser carries no session cookie from the webview, so they sign in
again; and the server app opens its LOOPBACK origin, where a passkey works only
if `APP_BASE_URL` is loopback too (§ `TRUSTED_ORIGINS`: `APP_BASE_URL` is
better-auth's passkey rpID).

**The assistant, and the reset behind it.** The `wizard` window is the app's
one bundled page and holds every command that changes this machine, the
destructive ones included — first run, recovery, update and reset. The app's
one destructive command, `desktop_reset`, is granted there alone. Its deep link
is the boundary working as designed, and its true worst case is precise rather
than implied: an XSS in the served SPA can call
`desktop_open_assistant({ screen: "reset" })`, which raises a window and
performs exactly one read-only `status --json` the app already runs on a
five-second watch — spammable, and nothing else; no verb that changes the
machine is reachable, because execution requires the machine's hostname typed
into the assistant's own box.
The command takes ONLY that string: the five deletion paths are read from the
server's own `status --json` `paths` block at the moment the screen opens,
captured in Rust app state (all-or-nothing — a partial block is refused like
no block, and the page never sends a path), and every recursive delete is
refused before the first mutation if it would contain the installed
`~/.local/bin/subshell-server`. A reset removes accounts, sessions, keys, the
signing keypair, pane logs and config, and clears this app's own choices; it
does NOT reach enrolled remote nodes or a same-machine `subshell` node agent,
which keep their credentials and processes — the confirmation screen says so
verbatim, because a person wiping the signing keypair is making a fleet-wide
statement.

Two limits worth stating rather than implying. Each `csp` in `tauri.conf.json`
applies to that app's bundled page **only** — a remote window's page carries
whatever CSP its origin sends, so an XSS in the server app's SPA reaches those
seven commands, and in the client app exactly one. And each app's ACL manifest is
what makes any of this apply at all: Tauri leaves app commands ungated for local
windows when no manifest exists.

### Entitlements are shared with the bundled binary

Tauri applies ONE entitlements file to every signed target in the bundle, so
whatever the Bun-compiled binary needs is also granted to the GUI process — in
`apps/server/desktop`'s case, the process that holds the session cookie. Both
apps bundle a Bun-compiled binary and so carry the same list, in two separate
files: sharing one plist between the two pipelines would silently widen
whichever was not being edited, and a test in each app pins that separation. The set was trimmed to `allow-jit` and
`allow-unsigned-executable-memory`, pinned by test; the three that the
bare-binary channel carries — `disable-library-validation`,
`allow-dyld-environment-variables`, `disable-executable-page-protection` — are
deliberately absent, because the first two together are what turns a signed app
into a code-injection host.

**Accepted risk:** that trim was measured under an ad-hoc signature, which
cannot exercise library validation. It must be re-probed under a real Developer
ID identity before the first signed release.

### It executes what it finds

Each app's resolution ladder runs `<candidate> version` on files it locates on
the login PATH and in well-known directories, and the copy it installs — at
`~/.local/bin/subshell-server` or `~/.local/bin/subshell` — is executed on every
launch from a user-writable directory. On this posture that is not an escalation — the same OS user already
runs the server and can already write there — but it is why a hand-chosen
binary is validated before it is persisted, and why every spawn carries a
deadline. The login-shell PATH probe runs the user's own shell profile, which
is arbitrary code by construction, on every launch.

### A setup key typed into the node app is `ps`-visible

`apps/client/desktop` passes the pasted key to `subshell enroll --key <nsk_…>`,
so it is one argv element for the life of that process and readable by any
local process that can see the process table. This is the same exposure the CLI
path already has (§8: the key also lands in shell history, and in a URL query
string on `/install.sh` and the download routes), and it is bounded — the key is
single-use, expires in 24 hours, is consumed by the enroll it is being used for,
and confers only the ability to register one node. It is nonetheless the one new
place the GUI puts a credential where the CLI put it too, and the fix, if it is
ever wanted, is a CLI change (read the key from stdin or an env var), not a GUI
one.

The node key that enroll returns is never surfaced: it is written 0600 by the
CLI, and `enroll --json` deliberately omits it, so the GUI cannot display or log
what it never receives.

### Notifications stay owner-targeted

The desktop watcher reads `GET /api/subshells`, which returns every subshell
the caller can SEE — for an admin, every subshell on the instance. It therefore
applies the same three gates the push path applies (§5): owner only, the
per-subshell bell, and the account-wide master switch. Sharing widens who can
see and act on a subshell; it never widens who gets notified about it.

## 9. Input handling and untrusted data

**PTY output is untrusted.** It reaches the browser as bytes and is rendered only
by xterm, never as HTML.

**Node event payloads are untrusted.** Every result shape is *parsed* by a
hand-rolled validator in `node-results.ts`, never cast. A node's answer is input
like any other.

**Ids that reach paths are structurally gated.** Subshell ids are interpolated
into node-side paths, so both sides check `isNodeSubshellId` — hex and hyphen,
≤ 64 chars. A hostile `../../../../x` never reaches path interpolation on either
side of the link.

**Sibling output is data, never instructions.** Anything an agent reads from
another subshell — channel posts, `get_subshell` output — is untrusted content.

### Deliberate non-validation

These are choices, not oversights, and they follow from §0:

- **No string length limits on log or subshell free-text fields.** They vary
  legitimately and capping them would break real use.
- **No pagination on small per-user lists** (distinct services, channels) —
  expected to be small on a local instance.

## 10. Audit and observability

Audit events are written for: `user.create`, `system-key.create`,
`system-key.delete`, `subshell.create`, `subshell.terminate`, `subshell.restart`,
`subshell.delete`, `node.enroll`, `node.delete`, `node.rename`,
`node.key_rotate`, `node.allowed_dirs.update`, `setup_key.create`,
`setup_key.revoke`, `settings.update`, `user.role_change`,
`user.password_reset`, `emergency_login.rewrite_credential`,
`server.config.update`, `server.restart`, `server.logging.update`, and
`node.service` (with `{ verb: "restart", forced }` metadata — the restart
verb shares its action with the rest of the service surface).

Timer- and probe-driven trusted-origin refreshes are observations and write no
row; the acts that change plugin state (`network.join|publish|unpublish|leave`,
`plugin.enable|disable|uninstall`) are the audited events — join and enable are
trust-EARNING, not just trust-shedding.

Read them with `GET /api/audit?limit=50` (admin).

**Sign-in and sign-out are NOT audited** — the auth flow is a better-auth
passthrough. Session lifecycle and `user.create` are. This is a known gap.

**Attach diagnostics can contain secrets.** `SUBSHELL_ATTACH_DEBUG=1` dumps real
pane contents to `/tmp/subshell-attach-debug/`. It is off by default and should
stay off outside active debugging — the dumps land world-readable and nothing
sweeps them.

**Pane logs are the long-lived copy of the same thing** (§4): 0600 in a 0700
directory, swept after `SUBSHELL_LOG_RETENTION_DAYS` (default 30). Application
logs themselves carry no pane content — request logging records method, path,
remote address and status, never bodies or headers, and no log line contains
terminal output or keystrokes.

### The server's own log file (2026-09-12)

The server writes `<data dir>/logs/server.log`: one file, JSON lines, **0600
in a 0700 directory**, **capped at 200 KB and replaced when full** — the file
is truncated and started over, so it is the recent past and never a history.
Nothing is kept in memory, request lines included. It is the same on every
platform by design: the desktop console used to tail launchd's file on macOS
and `journalctl` on Linux, and neither exists in a container or under whatever
a headless install runs. The manager's own log is still named in the
deployment view for anything older than this file holds.

It is the second thing this app writes that is worth reasoning about, beside
the pane logs — and it is the smaller one: pane logs are session transcripts
(§4), while this holds the server's own lines. Note the asymmetry in how they
are bounded. Pane logs are swept by age; this file is bounded by SIZE and
never swept, so it persists for the life of the instance as one file. A reset
deletes it with the data directory.

**Two new things follow, and they are the disclosure worth stating.**

- **An admin can read it over HTTP.** `GET /api/admin/server/logs` returns the
  tail, parsed, to a cookie-admin caller. Before this, reading the server's log
  meant reaching the host. It is still 0600 on disk and still admin-only on the
  wire, so the set of people who can read it is unchanged — but the set of
  PLACES they can read it from is not, and a browser on the LAN is now one of
  them.
- **In debug mode it holds request paths.** HTTP request lines are emitted at
  `debug`, so they reach this file only while debug logging is on and **never**
  reach the service manager's log at all. Debug logging is **off by default**.
  A request line is method, path, remote address and status — no bodies, no
  headers — but a path can carry a secret: `GET /install.sh?key=nsk_…` puts a
  setup key in one. That text was already recorded here as landing in access
  logs, and an admin can mint setup keys anyway, so this widens no one's
  reach. What it adds is a NEW READER of that text, in a new place, and it is
  named as one rather than left to be discovered. The polled routes
  (`/api/admin/status`, the `/api/admin/server` group, `/api/setup/status`,
  `/api/settings/public`, `/ws` and `/ws/node`) are excluded, or a debug
  session would fill the 200 KB cap with the Service page asking after itself.

**The switch is an instance setting, applied live.** `PUT
/api/admin/server/logging` flips the FILE transport's level with no restart;
stdout, which the service manager collects, stays at `info` whatever it says.
Audited as `server.logging.update` with the before and after.
`SUBSHELL_DEBUG_LOGGING=1` forces it on and makes the setting read-only, which
is the config ladder's ordinary rule — the environment wins, and the UI says
so rather than offering a switch that would be overruled at the next boot.
Only truthy spellings force it: `SUBSHELL_DEBUG_LOGGING=0` is treated as a
variable somebody left behind, not as the environment saying "off", because
reading it the other way would take the switch away and give nothing back.

**The UI discloses exposure rather than assuming it is understood.** A subshell
running on a node the viewer does not own, or one that is shared, carries a
permanent amber icon in its header (with the reason on hover) plus a one-time
banner. The banner can be dismissed and switched off per device; the icon
cannot be turned off, because it is the part that answers "is it safe to type
this here?".

## 11. Accepted risks

Recorded so they are decisions rather than surprises:

1. **The host's OS user boundary is the trust boundary.** Subshell keypairs, the
   node signing key, pane contents and process environments are all readable by
   that account. Nothing in the app changes this.
2. **Subshell bearer tokens are `ps`-visible** on the backend host and on every
   node — the token is part of the tmux start command. So is **typed input**:
   keystrokes reach the pane as `send-keys -l -- <input>` argv, and a paste is
   one frame, so a pasted secret is one argv element (§4).
3. **A control-plane key compromise is every node.**
4. **The host filesystem is browsable by default** to any signed-in human.
   `SUBSHELL_FS_ROOT` narrows it; nothing narrows it by default.
5. **Admins are unconstrained operators.** No separation of duties, no
   four-eyes on system-key minting — and, since 2026-09-05, an admin can
   **reset any other user's password** from the Users page. That grants no
   reach an admin lacked (they could already mint a full-access system key and
   read every subshell), but it is now a one-click credential takeover, and it
   is audited as `user.password_reset` with the session count rather than the
   password. Two guards bound it: an admin cannot reset their OWN password
   there (Account requires the current one, so an unlocked laptop is not a
   takeover), and the `system` service account is untouchable.

   **What a reset does and does not evict.** It deletes every row in
   `session` for that user, so an attacker holding a session cookie loses it.
   It does **not** revoke:
   - **Passkeys.** `@better-auth/passkey` stores credentials in its own
     `passkey` table, not in `account`. An attacker who enrolled a passkey
     during the compromise re-authenticates immediately and mints a fresh
     session — the very case the reset is reached for. Removing the target's
     passkeys is not currently part of a reset, and there is no admin path to
     another user's list — they are self-service on the Account page
     (`/api/auth/passkey/delete-passkey`), so the account holder removes a
     suspect credential (or a suspected compromise needs more than a password
     change).
   - **Live WebSockets.** `/ws` authenticates once at connect (cookie, or a
     30 s single-use token) and is never re-checked, so an already-attached
     terminal keeps streaming until it disconnects.

   A password reset is therefore a credential rotation, not a session-kill
   switch for every path into the account.
6. **System keys are bearer-equals-full-access** and long-lived. Every holder is
   effectively an operator.
7. **No DoS protection** beyond login backoff.
8. **The post bus is in-process**, so a multi-process deployment would silently
   lose cross-process wakeups.

## 11.9 Plugins run in the control-plane process

A plugin (`@subshell-ai/plugin-*`) is JavaScript the control plane imports and
calls. It has `node:fs`, the network, and the ability to spawn processes,
because it runs inside the server process with that user's privileges.
**No sandbox is claimed.**

**The 2026-09-10 accounting, in both directions** (inversion spec §8 — the
single largest change in that document, stated here in exactly its terms):

- **What gets worse.** Third-party plugin code runs in the control-plane
  process, which holds the node signing keypair, so a malicious plugin reaches
  EVERY enrolled node rather than one machine. Two things bound this: it was
  already true whenever a plugin was installed on `local` — the server has
  always loaded its own plugins in its own process — and installing is now an
  admin act, which is the right gate for an instance-wide capability.
- **What gets better.** A node no longer executes third-party code at all.
  Under per-node plugins every node carrying one ran that plugin's code as its
  OS user; a node now runs agent CLIs and nothing else. For a fleet, the
  number of machines running third-party plugin code drops from all of them
  to one.
- **What is unchanged.** Signing still proves who sent a command and never
  whether the target supports it; a compromised control plane is still all
  nodes (§6); `preset.flags` still reaches argv, and if that ever needs a
  check the place is where presets are saved, not the node.

What contains what:

- **A plugin that fails to load is reported, never fatal.** The loader wraps
  the import and the factory, so a broken plugin costs its own row rather than
  the server (`packages/pane-runtime/src/plugin-runtime.ts`). Built-ins get
  the same treatment through the lazily-built registry.
- **Containment is not isolation.** A plugin that loads successfully and then
  misbehaves is not constrained by any of this. The `PluginRuntime` interface
  exists so a Worker per plugin is a later change of one class, not a rewrite.
- **The entry path is checked twice** (manifest, then the resolved path) so a
  plugin cannot name a file outside its own directory. That stops a mistake,
  not an attacker who already controls the plugin directory: `resolve` is
  textual and does not follow symlinks.

Installing a plugin is therefore an explicit act with a named source, never
something a catalog does on its own — and an ADMIN act, cookie-only, on the
one door (`/api/plugins`, [§6](#plugin-installs-from-the-registry-spec-2026-09-09-instance-level-since-2026-09-10)).
Weaker doors were deleted rather than widened: there is no per-node install
route and no agent-side install verb any more.

**The node enforces binaries, not plugins.** With no per-node plugin store
there is nothing to check a `launch` against, and the launch carries the
argv the control plane built rather than a plugin id the machine resolves
against its own set. The node still refuses a launch whose binary it cannot
find — the failure an operator actually hits — but the old second refusal
("this plugin is not installed here") is gone by design (inversion spec §3).
A signature proves who sent a command; it says nothing about whether the
target should serve it, and this makes that explicit rather than papered over.

## 11.10 The control plane runs an agent CLI's installer on request

`POST /api/setup/agents/:id/install` makes the server spawn `sh -c <command>`
where `<command>` is the `install.command` of a BUILT-IN plugin's manifest,
compiled into this binary. What it costs: the control-plane process fetches
and runs a vendor's install script, as the server's own OS user on the
server's own host. What it does not add: an admin already has arbitrary code
execution on this host through `POST /api/plugins`, which loads third-party
plugin code IN-PROCESS (§6, §11.9) — measured against that baseline, this
route grants an admin no capability they did not already have. The id is the
only input; the route is admin-cookie-only, never public in the no-users
window, single-flight per id, 10-minute bounded, and audited as
`agent.install` without the output. The output itself is not silent, though:
it is returned over the wire to the admin's own browser and rendered there
(the installer's stdout can legitimately carry a token or a path, which is
why it is not also written to a log). The child's environment is an
allowlist, not the server's own — `BETTER_AUTH_SECRET` and the database path
are not among the variables an installer receives, so a compromised vendor
script cannot read either off this process. Trusted-network posture,
unchanged. A hardening pass for a wider deployment would add an operator
switch to disable the route (§12).

## 11.10b The control plane installs tmux on request

`POST /api/setup/tmux/install` (spec 2026-09-15) spawns this platform's package
manager to install tmux on the control-plane host. It exists because the browser
`/setup` wizard had no tmux step at all — that screen is native-only, so a
headless install discovered the dependency when its first launch failed, or
never. Without tmux the host can launch nothing.

It is the same class as §11.10 and narrower in every dimension that matters:

- **Admin cookie only**, never public. That is deliberately stricter than its
  neighbours in `/api/setup`, which are public during the no-users window: this
  one runs code, so it follows the agent installer's gate rather than its
  neighbours'. Bearer keys are refused like every other admin surface.
- **No operator input reaches the command line.** §11.10 at least takes a plugin
  id; this takes nothing. The argv comes from `chooseTmuxInstaller`, a fixed
  table compiled into the binary, and the request body has no field.
- **Anything `sudo`-prefixed is refused with 409**, before the response body
  opens and before anything runs. The server has no terminal to answer a
  password prompt, so a privileged installer would sit on it until the deadline;
  more importantly, this is what keeps "the server installs tmux" from meaning
  "the server escalates". In practice it means the route only ever runs on macOS
  with Homebrew — every Linux entry in the table is `sudo`-prefixed, and a test
  walks the real table to pin that, so the browser never offers the button
  there and the route would refuse it if it did.
- It reuses §11.10's spawn core, so the environment allowlist, the output cap
  and the bounded deadline are the same ones, not second copies. Audited as
  `tmux.install`.

Everything else in that spec is sentences, sequencing, and one client-side
composition of facts already on screen. Two smaller notes from it:
`subshell-server status` gained a line saying whether the first admin account
exists — it reads the local database as the local user, who can already read the
file — and `install-server.sh` is fetched over the public internet and piped to
a shell exactly as the node one-liner already is, bounded the same way, by
verifying the published digest before the first `chmod +x`.

## 11.11 An admin can reconfigure and restart the server from a browser

`PATCH /api/admin/server/config` rewrites config.env and `POST
/api/admin/server/restart` exits the process for its service manager to
respawn. Both are cookie-admin only — a bearer key is refused like every other
admin surface (§3) — and both are audited, as `server.config.update` with
`{ key, from, to }` per change and `server.restart` with whether it was forced.

**What it costs.** Four keys that used to require a shell on the host now move
from a browser: the port, the bind address, the public base URL, and the
trusted-origin list. Three of those decide who can reach this instance and from
where, so an admin session is now enough to widen the network surface — to move
the bind from loopback to `0.0.0.0`, say — where before it also took filesystem
access. One of the four applies differently, and it narrows rather than widens
the exposure window: the trusted-origin list is read LIVE by the registry
(`services/trusted-origins.ts`), so an origins change takes effect on the next
request with no restart, while port, bind and base URL sit in the file until
the next boot. Changing `APP_BASE_URL` additionally moves better-auth's passkey rpID,
so existing passkeys stop working at the old address; the page says so under
the field, because that consequence is invisible from the form.

**What it is measured against.** An admin already holds effective operator
access to everything this instance runs (§11.5): they can mint a full-access
system key, read any subshell, and reset any other user's password. Editing
four addresses is not a step up from that, and the values are addresses rather
than secrets. `BETTER_AUTH_SECRET` is not among the keys this route can touch,
it is preserved byte-for-byte in the file it rewrites, and a test scans the
audit metadata for it. The deployment view the page reads carries no secret in
any form either — only `authSecret: { state, source }`, never a value, the same
rule `GET /api/admin/status` follows (§3). Its test pins the view's ENTIRE key
set, so a field added later cannot join the payload unnoticed; that structural
check, rather than a scan for the secret's literal value, is what is actually
guarding this one.

**What the restart cannot do.** It is refused unless the service manager
reports **this very pid** — `service.state === "running" && service.pid ===
process.pid`. So a server started by hand, by `bun run start`, or in a
container with no init has `restart.available: false` and the route answers
409: there is no way to press this and exit a server into nothing, which is the
failure that would matter. Where it IS supervised, exiting is a restart by
definition, since the unit is `Restart=always` and the plist is
`KeepAlive=true`. It is refused a second time when the service definition
would take the tmux panes down with the process, unless the caller passes
`force` — the confirmation says which of the two it is about to do.

**The validator is shared, not mirrored.** The route and
`subshell-server configure` call one `applyConfig`, so the component-wise
validation and canonicalization that §8 leans on — no wildcards, no schemeless
entries, `URL.origin` on the way in — is the same code on both paths. That
shared call, not a test, is what keeps §8's static-allowlist claim true of this
writer rather than true only of the CLI: there is no second implementation to
drift. What the route's own test pins is narrower and worth knowing exactly —
that the write lands, that every key this tool does not own is carried forward
verbatim (the once-generated `BETTER_AUTH_SECRET` above all), and that the
audit metadata does not contain the secret. It does not diff the result against
a file the CLI produced. A key whose value comes from the process environment is refused
outright (409) rather than written, because a file write the next boot would
mask is a success report for a change that never happens. And for
`TRUSTED_ORIGINS` — the one key that applies live — env-ownership is decided
once at boot, before any write: on an `EnvironmentFile=` host a post-write
comparison would misread the file the process itself just rewrote as
environment-owned, and the registry would ignore the operator's change on the
platform it is most used on (`productionDeps`, `services/trusted-origins.ts`).

**Not moved, deliberately.** Stop, start, install, uninstall and reset have no
route. Each leaves the server unreachable, so a page the server serves is the
wrong place to drive them; they stay with the CLI and the desktop assistant.
`DATABASE_PATH` is not settable here either — moving the database from a web
form is a footgun with no undo, and the CLI's `--db-path` remains.

**One service preference IS reachable from the page, and it is inside that
rule rather than an exception to it.** `POST /api/admin/server/autostart`
arms or disarms "start at login" for an installed service, and it changes
nothing about the running process — on Linux it is `systemctl --user
enable|disable` with no `--now`, and on macOS it MOVES the plist between
`~/Library/LaunchAgents` (which launchd scans at login) and the config home
(which it does not), leaving the loaded job untouched. So the page asking for
it cannot take itself down. Cookie-admin, bearer refused, audited as
`server.autostart.update` with `{from, to}`, and refused with 409 on the three
machines where the question has no answer: nothing installed, the desktop app
running this server, or a manager that would not say. Switching who runs the
server at all still has no route, for the original reason — the dashboard
offers a door into the desktop assistant instead.

**A browser now presses it in ONE direction only**, and that is a UI choice
rather than a new rule: outside the Subshell Server app the page offers
"Start automatically" where a service is installed but unarmed, and offers no
way to disarm one. The route is unchanged and still takes `{ enabled: false }`
from any admin cookie — the CLI and the app still send it — so nothing here is
a control. It is an admission that the off direction has no honest caller in a
browser: the reader is not at that machine, disarming it strands the server at
the next reboot, and the label that used to offer it ("start at login") reads
on a headless host as a question about a desktop session it does not have.

### One CLI-touching command reaches the loopback SPA window

The Subshell Server app's `main` window is served content pinned to loopback,
and its standing grant is commands that cannot touch the CLI, the config, the
service or the filesystem. **`desktop_set_supervision` is now the one
deliberate exception** (operator's call, 2026-09-12): the dashboard's
supervision card confirms in its own dialog and invokes the switch directly.

Why it cannot be a route is unchanged — both directions leave the server
unreachable, so nothing the server serves can perform the act; only the app
outlives the server. What changed is where the CONSENT lives. It used to be a
screen in the assistant window, which put the confirm button outside the
page's reach: an XSS in the served SPA could raise the window but not press
it. That window read to the operator as a bug rather than a safeguard, and
the exposure it defended against is smaller than one the same page already
carries: an admin session on `main` already holds
`POST /api/admin/server/restart`. Moving the server between two supervisors
is a restart with a different respawner — reversible, no data touched, panes
kept — so a page that can already restart the server gains little by also
being able to say who restarts it.

What an XSS in the SPA can now do that it could not before: flip the machine
to app mode, so the server dies when the app quits, or back. It cannot reach
`desktop_reset`, `desktop_setup`, `desktop_service` or any other CLI verb;
those stay assistant-only, and `ipc-acl.test.ts` (TS) and `control.rs` (Rust)
both pin `main` at exactly five app commands plus
`core:window:allow-start-dragging`. The dialog on the page is a confirmation
for the PERSON, and is not counted as a defence against the page.

**Three things about that comparison are narrower than they sound, and each is
stated here rather than left to be discovered.**

- **The grant is not scoped to an admin session — it is scoped to the
  WINDOW.** "A page that already holds `POST /api/admin/server/restart`" is
  true of an admin session; the Tauri grant is not conditional on one. A
  `main` window sitting on the SIGN-IN page, with no session at all, can
  invoke `desktop_set_supervision`. Rust has no way to check a cookie it
  never sees, so this is a real difference from the route, not parity. What
  bounds it is who can reach that window at all: it is a local desktop window
  pinned to loopback, so the actor is someone at the keyboard — who could
  quit the app and run the CLI — or an XSS in the served SPA.
- **Uninstalling a service can kill live panes, and that is where the "no more
  permissive than restart" claim was actually false.** `service uninstall`
  gates on nothing by design, so a stranded unit can always come down; on a
  definition predating `KillMode=process` / `AbandonProcessGroup`, removing it
  takes every live subshell's tmux server with it. `POST /api/admin/server/restart`
  answers exactly that case with a 409 unless the caller passes `force`. The
  command therefore applies the same refusal (`pane_safety_refusal`), failing
  CLOSED when the definition cannot be read — absence of evidence is not
  evidence of safety. Without it the page could do silently what the route
  refuses, and this section's argument would have been wrong on the one axis
  it needed to be right.
- **The audit row is best-effort and written by the CALLER.** The act happens
  in the desktop app, which holds no session and cannot write the trail, so
  the SPA posts `POST /api/admin/server/supervision` (cookie-admin, records
  `server.supervision.request`, changes nothing) just before invoking. That
  closes a real asymmetry — `server.autostart.update` audited the SMALLER
  change while removing a service definition audited nothing — but anything
  invoking the command directly, an XSS included, simply skips it. It makes
  honest use legible; it is not a control, and it is not evidence of what
  actually happened afterwards.

**The command refuses to interleave with itself**, and that is part of what
makes the accounting above true. One call flips a supervisor; a hundred
concurrent calls are a different act, because the chain uninstalls a service,
writes a setting and installs another — interleaved copies can leave a machine
with no definition and no running server, needing a hand to repair.
`ACTION_IN_FLIGHT` looked like it prevented that and never did: it is a hint
for the watch thread, set unconditionally and cleared on the first `Drop`.
`desktop_set_supervision` takes it with a compare-and-exchange and REFUSES
when it is already held (`ActionGuard::try_new`). A refusal rather than a
queue: these are async commands doing synchronous CLI work, so blocking would
park an executor thread per call and take the app down instead of the server.

The same non-guarantee still applies to the assistant-only commands, and is
left as it is: that page serializes its own presses through one action runner,
and a refusal on the surface that repairs a broken machine would be a new
failure mode for no gain.

### The desktop app as supervisor

Subshell Server can run the control plane as its own child instead of
installing a launchd agent or systemd unit (spec 2026-09-12
server-supervision). The server learns this from three environment variables
the app sets on the child — `SUBSHELL_SUPERVISOR`, `SUBSHELL_SUPERVISOR_PID`,
`SUBSHELL_SUPERVISOR_LOG` — and **believes the claim only when the named pid
is genuinely its own parent** (`appSupervised`).

Be exact about what that check is worth. The variables are a claim any process
could make; parentage narrows a forged one to a shell that set them and exec'd
the server itself — i.e. to whoever started the process and already holds
SIGKILL over it. A forgery buys two things, not one:

- **`restart.available: true`** — an admin exiting the server into a parent
  that will not respawn it.
- **The pane-safety refusal is suppressed.** The app branch reports
  `paneSafety: "keeps"` unconditionally, and `POST /api/admin/server/restart`
  gates its "this would close every running subshell" 409 — and the
  confirmation dialog's warning — on exactly that field. So on a machine whose
  real service definition would kill panes, a forged claim removes both.
  Unlike the first, this one has a victim other than the forger: other users'
  subshells die with no warning to the admin who pressed the button.

The verdict is still "accepted": the forger is the person who launched the
server and could `tmux kill-server` directly, so no privilege is gained. It is
the same class as hand-editing config.env. But a section claiming to be exact
should name both.

The app earns the `paneSafety: "keeps"` it reports: its supervisor signals the
main pid and never the process group, which is what `KillMode=process` and
`AbandonProcessGroup=true` buy under the two managers. A person quitting the
app stops the server and keeps every live pane.

## 11.12 Updates

Spec 2026-09-15. Before it there was no update path at all except one: Subshell
Server installed the server binary it bundled over the one in `~/.local/bin`.
A headless install was never told a newer server existed, a node was never told
anything but "die", and nothing ever backed up the database before a migration
ran over it. What follows is what closing that costs.

**The plane downloads and executes code from the release source; since spec
2026-09-17 it does not have to BELIEVE the release source.** Every release now
carries a `release-manifest.json` and a `release-manifest.json.sig` — a
detached minisign signature over the manifest's EXACT published bytes, made
with the same publisher keypair that signs the desktop apps' updater
manifests (`TAURI_SIGNING_PRIVATE_KEY`; one key, all four components). The
manifest's `assets` map is the digest source: the sha256 every install
compares the downloaded bytes against now comes from that SIGNED payload,
never from the release source's `.sha256` sidecar. So a compromised release
source — or a `SUBSHELL_RELEASE_URL` pointed at an attacker — can withhold
updates or replay any release the publisher ever signed, but it can no longer
put code on a machine merely by being the host that served it. Authenticity is
the publisher's key now; TLS is only delivery. The check runs at every update
path: the server's own `update`, the downloads route's lazy agent fetch, the
Updates page's release selection (a release with no manifest, no signature, or
a signature that does not verify is refused BY NAME, never offered), and each
node — which re-verifies the signature itself rather than taking the plane's
word (below). **Empty still disables all of it**: no server update, no node
update, no lazy artifact fetch, and each refusal names `--from` or a hand
install instead of failing quietly. Two honest residues. The INSTALL one-liners
(`install-server.sh`, the node enroll script) keep the old rule — their digest
comes from the sidecar the same host serves, so a first install is still
TLS-plus-repository trust; the first UPDATE any installed product performs is
verified against the compiled-in key. And a local `release:node` publish into
one's own instance is legal UNSIGNED — those artifacts are served by digest
through the authenticated downloads route and never crossed a network nobody
controls — while every plane's release SELECTION refuses an unsigned release,
so the closing is done by the selector, not by the publisher's discretion.

**The desktop apps verify one link shorter, on the same key.**
`tauri-plugin-updater` checks a minisign signature over the BUNDLE bytes
against a public key compiled into the app (`plugins.updater.pubkey`); the CLI
paths check a signature over the MANIFEST bytes and then match each downloaded
file against a digest read from that verified payload. Both rest on the same
keypair since spec 2026-09-17, which is also what RAISED the stakes on it:
losing `TAURI_SIGNING_PRIVATE_KEY` now means every installed component of all
four kinds can never auto-update again, not just the two GUIs. The private key
lives in two repo secrets and a password manager, never in the tree; a release
cut is REFUSED while the placeholder pubkey is still committed, and every
shard — desktop and CLI alike — fails loudly when `TAURI_SIGNING_PRIVATE_KEY`
is unset, because publishing an unsigned updater artifact, or an unsigned
manifest, is publishing a release every installed product must refuse.

**An admin can now install code on the control-plane host from a browser**,
where before they could only restart it. `POST /api/admin/server/update` is
cookie-admin only (bearer keys refused, like every route in that group), and it
is audited twice: once at the start with the admin as actor, and once at the
next boot by `completeUpdate` with actor `null` — the pair reads as "who asked"
and "what happened", and a job that dies mid-download still leaves the first
half. The same accounting as §11.10 and §11.10b (agent CLI and tmux installs)
applies, with a narrower argv than either: **the URL comes from the release
index, never from the request body**, and `version` only SELECTS among
published tags — naming anything but the newest published release is answered
with what is available rather than fetched. The downloaded file is made
executable and then made to say what it is (`<temp> version` must equal the
version being installed) before it replaces anything; a binary that cannot
answer does not get installed. Seven refusals precede all of it, and the one
that matters structurally is `RESTART_UNAVAILABLE`: a swap with no manager to
respawn the process would leave an old server running beside a new file, so
there is no way to update a server into nothing.

**An `edit` grantee can now replace a node's binary.** `POST /api/nodes/:id/update`
carries the gate `service restart` carries (`nodeCanConfigure`, cookie only,
`local` refused, audited `node.update`), because that is what it is: a restart
with a file swap in front of it. No new trust — the plane already runs
arbitrary commands on that machine under that OS user — and the honest note is
the restart note verbatim: an `edit` grantee may briefly take every subshell on
a machine they do not own offline, the owner's and other grantees' included.
The URL, the digest, and the VERIFIED MANIFEST with its signature travel
INSIDE the signed command (protocol 12, spec 2026-09-17 §6) — and the node
re-verifies that signature against its own compiled-in pubkey before it
replaces anything, so a node's trust is the publisher's, not merely the
plane's: even a control plane persuaded (or compromised) after composing the
command cannot get the node to install bytes the publisher did not sign.
Agents older than protocol 12 PARSE the command but IGNORE those two fields,
so this plane refuses to send one an update at all — the refusal says so and
names the by-hand verb.

**The download token is not a credential in any general sense.** A node key can
do nothing on REST (§5.5) and that stays true: the agent presents a `nut_…`
token, never its key. The token is minted per `update` command, held **in
memory only** (hashed, never in the database), lives ten minutes, works
**once**, and is bound to one node and one platform triple — a token minted for
`linux-x64` cannot fetch the darwin binary. It buys exactly one download of one
file the release source publishes publicly anyway, and it is refused on the
`.sha256` routes outright: the agent already holds the digest from the command,
so spending a single-use token on 65 bytes would leave nothing for the binary.
A server restart forgets every outstanding token, which is the correct
behaviour rather than a gap — the agent's download then 401s, it answers
`download failed`, and the route says so.

**Held sockets are a resource, and a narrow one.** An agent the plane refuses
for its version or its protocol is no longer closed; its socket is HELD. What
that means precisely: it is moved out of the live registry, so `isNodeOffline`
and `listOnline` answer exactly as they did when it closed and no launch, tail
or probe reaches it; its row is explicitly re-projected `offline`; every frame
it sends except the `result` of an `update` is DROPPED rather than acted on —
after the envelope parse and before the dispatch, so nothing it says reaches a
handler (it speaks a protocol this server does not, so applying its `ready`,
`inventory` or `maintenance` would write a machine's facts from a build that
cannot be asked to confirm them); a newer socket for the same
node supersedes it; it is closed after ten minutes unused with the message it
would have got at once; and `disconnectNode` closes it too, so rotating or
deleting a node key takes away the one command a held socket could still carry.
The `update` command's wire shape is FROZEN across protocol bumps for this
reason alone — it is the one command sent to an agent whose protocol the plane
does not share.

**The backup is the whole database** — credential hashes, API-key hashes, audit
rows, channel ciphertext. It is the most sensitive single file this app writes
and it is now written repeatedly: 0600 in a 0700 directory at
`<SUBSHELL_SERVER_DATA_DIR>/backups/`, so it is inside the data dir the desktop
reset deletes recursively and the disk posture is unchanged. SQLite creates the
file with the umask (0644 measured), so the `chmod` after the `VACUUM INTO` is
what makes 0600 true rather than a hope. Five are kept by default; an operator
who wants fewer bytes on disk sets `SUBSHELL_DB_BACKUPS_KEEP`, and `0` keeps
them forever. `subshell-server backup` takes one by hand.

Note which paths now write one. The desktop app's "install the bundled server"
offer used to copy a file into place; when the outcome is a REPLACE of a
managed install it now runs `<installed> update --from <sidecar> --yes
--no-restart --json` instead, so it takes the backup and writes the marker like
every other path. That is a safety gain and a disclosure change in the same
motion: a machine whose owner only ever presses a button in a GUI now
accumulates full copies of its database on disk, bounded by
`SUBSHELL_DB_BACKUPS_KEEP` and by nothing else. The FIRST install still copies
the sidecar — there is no installed CLI to run yet, and nothing to back up.

**Rollback restores a database from before the update.** Anything written
between the snapshot and the failed boot is lost — in practice nothing, since
the backup is taken with the old server still serving and the swap follows
within seconds, and a slow download happens BEFORE the backup by design. The
revert order is the reverse of the swap: the database first (an old binary
cannot boot on a newer database at all — Kysely refuses migration names it does
not know, measured), the binary second, the marker last, so a crash anywhere in
there leaves a marker the next boot still acts on. A `pending.json` naming a
version that is not the one booting is RECORDED as a failure rather than
ignored, which is also what stops a stuck marker refusing every later update
forever.

**One update act now spans a relaunch, and a consent travels with it** (spec
2026-09-18). Each desktop bundle ships the CLI it wraps, so updating the app
and installing that CLI became one press: phase 1 replaces the application and
relaunches, phase 2 runs in the NEW process and installs the bundled binary.
Three properties of that are security-relevant and are recorded here rather
than in the spec alone.

**A pane-safety consent is PERSISTED and honoured by a different process.**
The server app's phase 2 ends in a service restart, and on a definition that
does not spare panes that restart closes every live subshell. The confirm
happens in phase 1; the act happens after the relaunch. So the answer is
written to `settings.json` as `pendingBundledInstall.forced` and read by the
new build. Re-asking would be asking again for something already granted, on a
screen nobody chose to open — but it IS a destructive consent at rest, so it is
narrow by construction: one boolean, about one restart, and cleared with the
marker that carries it.

**The page ASKS for it and cannot grant it.** `desktop_install_app_update`
takes two booleans since 2026-09-18 — `forced`, and whether the CLI half was
ticked (spec § 13) — because a selection made before the relaunch has to reach
the process that acts after it. `forced` is ANDed in Rust with the machine's
own `pane_risk_now`, so a page claiming `true` on a definition that spares
panes still gets `false`: the page can decline a force, never manufacture one.
The command still names no release and no path — every argument is a boolean,
which `ipc-acl.test.ts` pins by shape rather than by count.

Its worst case is what the file's owner can already do by hand — that user can
stop the service themselves — which is why a hand-edited `true` buys nothing.

**The marker never decides that work exists.** Whether phase 2 has anything to
install is re-derived at boot from the machine (the bundled version against the
installed one), using the SAME managed-aware comparison the offer uses — so a
marker can only continue an act the probe would have offered anyway, and one
whose work is done, or whose machine runs a binary this app does not manage, is
dropped without acting. That equivalence is load-bearing: while the two paths
compared differently, a machine whose service named a binary outside
`~/.local/bin` was told the CLI half was refused and then had it installed at
the next boot, with a forced restart nobody had been warned about (found in
review, 2026-09-18, before release).

**Retries are bounded.** An install that fails every boot would otherwise take
the window to a failure screen on every launch forever; after two attempts the
marker stays — so the screen can still name the update and offer Retry — and
nothing fires by itself.

**The deep-link surface is unchanged.** Updating is one more name on the
existing closed screen enum in Subshell Server's assistant — `app-update`
until 2026-09-18, when it and the separate bundled-server screen COLLAPSED
into a single `update` that performs both halves of one act (spec
2026-09-18 D3); the enum lost a member rather than gaining one. `main` gains
no command in either app: the four new updater commands
(`desktop_check_app_update` / `desktop_install_app_update`,
`node_check_app_update` / `node_install_app_update`) are granted to the BUNDLED
window only, in `wizard.json` and `node.json`, and each app's `ipc-acl.test.ts`
pins that. The server app's remote window still holds its commands unchanged
by this — it went from six to seven on 2026-09-17 by the read argued above,
never by any of these verbs — and the client app's still holds its one.

## 11.13 Network plugins publish this server on a network

Spec 2026-09-15. A **network plugin** (`type: "network"`) connects the
control-plane host to one private network — Tailscale, Headscale, NetBird,
Cloudflare Tunnel — and publishes Subshell on it, so the address an operator
used to discover through a 403 becomes something the product knows and writes
down. It is the same store, the same admin install door and the same seeding
marker as a harness plugin (§6, §11.9); what differs is what it implements and
therefore what it costs.

**The rule the whole design rests on: a network plugin DESCRIBES, and the host
EXECUTES.** A plugin returns argv, parses output and names a secret. It never
spawns, never writes a file, never touches config.env, and never reads a
credential back. That is not tidiness — it is what keeps the admin-only,
bounded, env-allowlisted, audited properties of §11.10 and §11.10b true of code
this project did not write.

**What gets worse.**

- **The argv is a plugin's, not a compiled-in table's.** §11.10 takes a plugin
  id and §11.10b takes nothing; here a plugin decides what runs, through one
  host member (`PluginHost.run`). This adds no trust that §11.9 has not already
  accounted for — plugin code runs in the control-plane process with that
  user's privileges and no sandbox, so a plugin that can be loaded can already
  do worse — but it is the first time plugin-chosen argv reaches a spawn, and
  it is worth saying rather than filing under "plugins are trusted". A
  third-party network plugin's commands are exactly as trusted as its install
  was. The bounds are the existing ones, not second copies: the
  `INSTALLER_ENV_KEYS` allowlist (so `BETTER_AUTH_SECRET` and the database path
  are not in the child's environment), stdin closed, the 64 KiB output cap, a
  30 s default deadline capped at ten minutes, and a refusal of any `argv[0]`
  that is not absolute or whose basename is `sudo`, `doas` or `pkexec`.
- **Plugins now make outbound requests from the control plane.** §11.9 already
  granted the network; the Cloudflare Access pre-flight is the first built-in
  that uses it.
- **A new credential class at rest.** The Cloudflare tunnel token IS the
  tunnel's identity and must survive restarts, so it is stored on disk:
  `<SUBSHELL_SERVER_DATA_DIR>/plugins-state/<id>/secrets/<name>`, 0600 inside
  0700 directories, same protection as `BETTER_AUTH_SECRET` and the node key,
  and inside the data dir the desktop reset already deletes. A stolen data dir
  is a stolen tunnel. Two narrowing facts and one gap: the store is
  **write-only to plugins** (`set`, `has`, `delete` — there is deliberately no
  `get`, because a plugin that could read a credential could put it in argv, a
  log line or a hint that renders in a browser), the value is hydrated only
  into a process the HOST spawns (a 0600 file named by a flag, or an
  environment variable), and **`subshell-server backup` does not include it** —
  that verb snapshots the database alone (§11.12). After a restore the token
  must be re-entered, and the UI says so at the field rather than leaving it to
  be discovered.
- **Mesh keys transit argv once.** A Tailscale auth key or a NetBird setup key
  is passed to the vendor CLI as an argv element and is `ps`-visible for the
  life of that one short command. Same accepted class as
  `subshell enroll --key <nsk_…>` (§8b): single-use, consumed by the join, and
  the daemon owns the identity afterwards. Subshell stores nothing.
- **Cloudflare Tunnel inverts §0**, and it is the only thing here that does: a
  `public-with-gate` plugin reaches the open internet. What bounds it is stated
  in three places rather than assumed. The exposure is manifest DATA, rendered
  before any button, so nobody publishes without reading it. The plugin
  **refuses to publish** until a pre-flight confirms a Cloudflare Access
  application covers the hostname (Access evaluates at the edge, before the
  origin, so the check passes before the tunnel is up and fails on a bare
  public hostname). And the server verifies the assertion itself, in its own
  middleware mounted ahead of everything: keyed on the **`Host` header** and
  not on a `CF-Ray`-style header a LAN client can simply omit, `jose`'s
  `jwtVerify` against the team's JWKS with the issuer and `aud` pinned,
  failing closed with `403 ACCESS_DENIED` on **every path with no
  exemptions**, plus a belt refusal of a matching Host arriving from a
  non-loopback address (`cloudflared` always connects from 127.0.0.1). Stopping
  is ordered for the same reason: disabling or unpublishing stops the tunnel
  process FIRST and drops the guard LAST, so there is no instant in which a
  live tunnel is unguarded.
- **A plugin's reported text reaches an admin's browser, and some of it was
  chosen by a machine nobody here controls.** A network plugin's status carries
  hints, and a hint may carry a URL the page renders as a link. Much of that
  text is the plugin author's, but not all of it: a plugin reports what it read
  off a vendor CLI, which reports what its CONTROL SERVER sent. Tailscale's
  `AuthURL` is the worked example — with `--login-server` it comes from
  whatever host the operator pointed the daemon at. An `href` is not inert, so
  a `javascript:` URL in one would be script on the control plane's own origin,
  in the session of the one person who may install plugins. **A URL this
  contract carries is `http:` or `https:` and is checked three times**, at
  layers that fail differently on purpose: the manifest parser REFUSES a bad
  `docsUrl` at load, because a manifest is static data and a bad value there is
  a plugin defect; the network gate DROPS one a plugin reports at runtime,
  keeping the sentence beside it, because refusing to load a working plugin
  over a value some control server chose would be the wrong failure; and the
  page renders no anchor for one that reaches it anyway. React 19 happens to
  neutralize this scheme itself, which is why it was never exploitable here —
  that is an internal of a rendering library and is not what the guarantee
  rests on.
- **Tailscale Serve puts this machine's name in public Certificate
  Transparency logs.** The certificate is a real Let's Encrypt one for
  `<host>.<tailnet>.ts.net`, so the NAME becomes public even though the server
  stays private to the tailnet. Stated on the publish button, not discovered
  afterwards.
- **The address surface follows the network, not a file** (2026-09-16). A
  network plugin's addresses are trusted from its RECORD
  (`services/network/origins.ts`): a `private` network's from membership —
  `http://<tailnet-ip>:<port>` answers with no publish at all, so joined is
  the honest scope — and a `public-with-gate` network's only from a record
  that says `published`, i.e. only once the Access guard is installed.
  Nothing is written to config.env: until 2026-09-16 a publish unioned its
  addresses into `TRUSTED_ORIGINS` and an unpublish subtracted them by value,
  both through §11.11's writer; both writers are gone. Disable, uninstall and
  leave forget the plugin's contribution. The join-is-the-publish rule for a
  `publishImplicit` network stands — the join records the publish, which
  trusts its addresses at once, and audits its own `network.publish` row
  (`by: join`); it was always the same act one press earlier, not a new
  surface. None of this touches the passkey rpID: that is `APP_BASE_URL`,
  changed on the Networking page's Addresses card, warned at the field (§2, §8).
  Audit rows (`network.configure`, `network.install`, `network.join`,
  `network.publish`, `network.unpublish`, `network.leave`) name origins and
  field NAMES, never values. **`network.install` is the §11.10-class act in
  that list**: it runs a plugin manifest's install command as the server's own
  OS user, with the plugin id as the only caller input, and is reachable for
  exactly the plugins whose installer needs no root.

**What gets better.**

- The trusted perimeter §0 assumes stops being something an operator builds by
  hand and then fights the config about. The address that works and the address
  the server trusts become the same decision, made once.
- An `http://` origin over a WireGuard mesh is now LABELLED rather than
  inferred: each address carries whether a browser will treat it as a secure
  context, so "passkeys do not work here" is said before someone tries to
  register one, not after.
- Every privileged step is printed and never run. Every mesh daemon needs one
  root install, and the server has no terminal to answer a password prompt —
  the same refusal §11.10b turns on, applied to a second family of installers.
  `cloudflared` is the one binary that needs no root anywhere, which is why it
  is the only plugin carrying an `install.command` the server may run itself.

**What is not claimed.**

- **The server still trusts no proxy header.** `X-Forwarded-*`,
  `Tailscale-User-Login` and `Cf-Access-Authenticated-User-Email` are all
  ignored. Only the signed Access assertion is verified, and only as a **front
  door**: the verified email is attached for audit metadata and is never a
  session. Subshell's own cookie is still required behind it.
- **Login backoff stays per-email** (§8). Under a tunnel every request appears
  to arrive from 127.0.0.1, which costs nothing today because nothing is
  rate-limited per IP — and is precisely why a per-IP limit added later must
  read `CF-Connecting-IP`, and only behind the guard, where the header has been
  vouched for.
- **The secrets store is not encrypted.** `SUBSHELL_SECRETS_KEY` (§8) remains
  designed and unbuilt; it now has one real customer, which is the condition
  that section named for revisiting it.
- No plugin is sandboxed, and none of this changes §11.9.

## 12. Hardening checklist for a wider deployment

If this is ever exposed beyond a trusted network, the posture in §0 no longer
holds and the following are prerequisites, not improvements:

- [ ] **HTTPS only**, with `secure` cookies, a real `BETTER_AUTH_SECRET`, and a
      strict `TRUSTED_ORIGINS`.
- [ ] **Proper CORS origin validation** and **rate limiting on all routes**, not
      just login.
- [ ] **Input length validation** and **pagination** on every list endpoint.
- [ ] **Set `SUBSHELL_FS_ROOT`** — do not leave the host filesystem browsable.
- [ ] **Shorten `SUBSHELL_LOG_RETENTION_DAYS`**, and encrypt the volume holding
      the data directory. Pane logs are plaintext session transcripts (§4);
      file permissions stop other OS users, not a stolen disk or a backup. The
      server's own log (§10) sits in the same directory, is bounded by size
      rather than by age, and is not swept at all.
- [ ] **Leave debug logging off**, or accept that the server's log file holds a
      request line per call — paths included, and a setup key rides in one
      (§10). It is off by default; `SUBSHELL_DEBUG_LOGGING` in a unit file or
      an environment file turns it on for every boot.
- [ ] **Re-examine the E2EE threat model.** It protects neither metadata nor a
      host-compromising local user; if either matters, the current design does not
      deliver it.
- [ ] **Rotate and review system API keys.** Treat every holder as an operator.
- [ ] **Reconsider node enrollment entirely.** Delegating command execution
      across a hostile network is a different problem from delegating it across a
      VPN, and command signing alone does not close it.
- [ ] **Add sign-in/sign-out audit events** before anyone needs to reconstruct an
      incident.
- [ ] **Separate admin duties**, or accept that any admin compromise is total —
      admin password reset (§11.5) makes that compromise one click from any
      other account.
- [ ] **Clear `SUBSHELL_EMERGENCY_PASSWORD`** and verify it is unset in every
      environment file and unit.
- [ ] **Add an operator switch for `POST /api/setup/agents/:id/install`** (§11.10)
      or disable it outright — it runs a vendor's install script as the
      server's own OS user on request from any admin.
- [ ] **If a `public-with-gate` network plugin is published, the guard IS the
      perimeter** (§11.13). Verify that the Access application covers the whole
      hostname rather than a path prefix, that its `aud` matches the one
      configured here, and that no bypass or service-token policy is attached —
      §0's trusted network is no longer what stands between the internet and
      this instance.
