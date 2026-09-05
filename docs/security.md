# Subshell — Security Model

What Subshell defends against, what it deliberately does not, and where each
boundary is enforced in code. This is the authoritative statement of the threat
model; [`architecture.md`](architecture.md) describes the machinery,
[`node-protocol.md`](node-protocol.md) the node wire contract, and
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
| An unauthenticated party reaching any API | The auth guard — every `/api/*` route except auth and setup-status |
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
(`apps/server/src/api/auth-guard.ts`), which is the only place credentials become
principals; the fourth is a websocket credential and nothing else.

| | Session cookie | System key | Subshell token | Node key |
|---|---|---|---|---|
| Form | `better-auth.session_token`, HttpOnly, `SameSite=Lax`, `secure` in prod | `Bearer subshell_…` | `Bearer subshell_…` | `Bearer` on `/ws/node` only |
| `actor` | `cookie` | `system-key` | `subshell-key` | — (rejected on REST) |
| `principal` | `user:<id>` | `user:<systemUserId>` | `sess:<subshellId>` | — |
| Minted by | sign-up / sign-in / passkey | admin, Settings → System API keys | the server at subshell start | `POST /api/nodes/enroll` |
| Scope | the user's own data; **the only actor admin surfaces accept** | full access, no permission map | permission grant map (`channels`, `subshells` × `read`/`write`) | open `/ws/node` as that node |
| Lifetime | better-auth session | until disabled or deleted | 7 days, self-extending while the MCP child runs | long-lived |
| Revocation | sign-out / password change | instant | **instant** on terminate/delete; rotated on auto-restart | delete the node |
| Stored as | session row | hash only | hash only | hash only |

Plaintext keys are shown exactly once, at creation, and never again.

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
  `/api/admin/status`, and the sharing routes.
- **Machine credentials get no boost and no grants.** On every per-subshell
  route, a bearer actor runs with the admin boost and shared grants switched
  **off**. A subshell's own token can therefore act only on its owner's
  subshells — never a foreign one, never one merely shared with its owner.

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
never reach the agent. Profile env vars merge on top, then the MCP wiring env
last, so a profile cannot silently drop a subshell's comms by setting
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

Wire-level detail is in [`node-protocol.md`](node-protocol.md); the security
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
### Directory allowlist (spec 2026-09-05)

A node owner may restrict **where** subshells can be created on their machine:
`PUT /api/nodes/:id/allowed-dirs` stores a set of absolute directories, and a
subshell may only be launched in one of them or beneath it.

- **Empty means unrestricted**, not "deny everything" — every node predating
  the feature is unaffected, and clearing the rules returns a node to that
  state.
- **Owner-only to edit** (`canManage`), deliberately not the `edit` gate the
  harness toggles use: any node share lets the grantee launch there, so an
  `edit` grantee able to widen the list to `/` would face no restriction at
  all. The rules are **read-visible to everyone who can see the node**,
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

- **Setup keys** are single-use, 24 h, shown once, hashed at rest, revocable, and
  audited. The install command embeds one in a URL, so it lands in shell history
  and server access logs — the same posture as enrollment links everywhere.
  Revoking is deleting the key.
- **Artifacts are never anonymous.** Prebuilt binaries and their `.sha256`
  digests (`GET /api/downloads/node/*`) require a session cookie **or** a valid
  unconsumed setup key. `GET /install.sh` renders a usage script for an
  invalid/absent key — it is never a binary oracle — and the script it renders
  digest-verifies the download before the first `chmod +x`.

**The enroll-time loopback trap.** If the configured server URL is
loopback-ish, a remote node will dutifully dial its own machine. The enroll flow
and the Nodes page surface the resolved URL and warn on loopback; public settings
carries `appBaseUrl` so the dialog shows exactly what the server will bake.

**Disabling the control-plane host as a launch target** means an admin removing
the `local` node's seeded Everyone/`edit` share row (the Settings toggle does
exactly this). The disable survives restarts: boot seeding creates that row only
when the `local` node row itself is created, never to "repair" a deliberate
removal. There is no separate flag to drift out of sync with it.

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

**Binding.** Loopback by default (`HOST=127.0.0.1`).

**CORS is a static allowlist.** The instance's own origins are derived at boot —
both loopback spellings of `SERVER_PORT`, a concrete `HOST`, and the
`APP_BASE_URL` origin — and `TRUSTED_ORIGINS` adds to them. It is deliberately
**not** "trust the origin that matches the request host": that is precisely the
DNS-rebinding hole the allowlist exists to close. Permissive CORS is acceptable
here only because the service is not internet-facing.

**Production refuses to boot on the placeholder secret.** With
`NODE_ENV=production`, better-auth exits early unless a real
`BETTER_AUTH_SECRET` is set. Production also enforces the origin check strictly,
which is where a mismatched origin surfaces as `403 Invalid origin` on
sign-in — not in dev.

**WS attach.** Requires a short-lived (30 s), single-use token minted through an
authenticated REST call, cookie-session only. Replay-resistant: a second use
closes with `4001 unauthorized`.

**Rate limiting.** Login only, per email: no delay on a clean record, then
`2^n` seconds capped at 30 s. Emails are attributed lowercased and trimmed.
Passkey sign-in is deliberately **not** behind this backoff — it carries no email
to attribute failures to, and the physical authenticator is the gate. No other
endpoint is rate-limited.

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
`user.password_reset`, and `emergency_login.rewrite_credential`.

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
   takeover), and the `system` service account is untouchable. A reset
   **revokes every session the target holds**, so it does evict an attacker
   already holding a cookie.
6. **System keys are bearer-equals-full-access** and long-lived. Every holder is
   effectively an operator.
7. **No DoS protection** beyond login backoff.
8. **The post bus is in-process**, so a multi-process deployment would silently
   lose cross-process wakeups.

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
      file permissions stop other OS users, not a stolen disk or a backup.
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
