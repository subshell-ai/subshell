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
  admin; registration is gated by a settings toggle.
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
    created by admins under **Settings → System API keys** (plaintext shown exactly once;
    only a hash is stored). Treat them as full-access bearer credentials — disable/delete
    revokes instantly.

Admin-gated routes (`/api/users`, `/api/system-keys`, `/api/admin/status`, …) **reject
bearer keys** (403): machine credentials can never manage the instance.

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
- **Disabling the control-plane host as a launch target** = an admin removing
  `local`'s seeded Everyone/`edit` share row (the Settings toggle does exactly
  this). The disable **survives restarts** — boot seeding creates that row only
  when the `local` node row itself is created, never to "repair" a deliberate
  removal. The row then vanishes from non-admin views like any invisible node —
  no separate flag exists to drift out of sync with it.
- **Agent artifacts are never anonymous.** Prebuilt `subshell` binaries and
  their `.sha256` digests (`GET /api/downloads/node/*`) require a signed-in
  session cookie OR a valid unconsumed setup key; `GET /install.sh` renders a
  usage script for an invalid/absent key (it is never a binary oracle), and the
  rendered script digest-verifies the download before its first `chmod +x`/exec.
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
changed (2026-09-08) is only that the list is now reachable from the
`subshell-server` CLI (`--trusted-origins`) and the Subshell Server console
instead of a hand-edit of config.env.

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
  and the desktop console can write. An env var or a hand-edit still bypasses
  it. Adding wildcard support would need this section rewritten first.
- **`APP_BASE_URL` is also better-auth's passkey rpID.** Changing it moves
  which host passkeys work on, so an existing passkey stops working on the old
  address — including the Subshell Server desktop app's own window, which is
  pinned to loopback. Adding a LAN name to `TRUSTED_ORIGINS` does NOT have that
  effect and is the right lever for "also reachable at".

## The desktop apps (`apps/server/desktop`, `apps/client/desktop`)

Two Tauri v2 shells. `apps/server/desktop` ("Subshell Server") installs, runs
and manages a `subshell-server`; `apps/client/desktop` ("Subshell Client") is a
person's interface to a control plane AND the place their machine is registered
as a node. Neither adds a server surface — everything privileged goes through a
CLI as the same local user.

**The boundary is window KIND, not window count: CLI-driving commands are
granted only to BUNDLED pages.** The client app is two windows (one remote, one
bundled); the server app is three (the remote SPA window, plus the bundled
console AND the bundled first-run wizard, which share one Vite build and one
ACL rule). The `csp` in each `tauri.conf.json` governs the bundled pages only —
the remote window carries whatever CSP the plane sends.

- **The server app's remote window is PINNED TO LOOPBACK and holds three
  commands.** It loads `http://127.0.0.1:<port>` or `http://localhost:<port>` —
  the server this app itself manages — so `capabilities/main.json` scopes it
  with `remote.urls` to loopback and grants only commands that cannot touch the
  CLI, the config, the service or the filesystem (show an existing window, drop
  this app's own title bar, display one fixed-shape notification). `open_main`
  independently refuses a non-loopback origin, and `on_navigation` pins the
  window to the origin it opened with. An XSS in the SPA reaches those three
  commands and nothing else.
- **The server app's reset is console-only, and the deep link reaches one
  read-only spawn.** The dashboard's danger card calls
  `desktop_open_console({ screen: "reset" })`; the remote window's worst case
  is precisely that: it can raise the console at a confirmation screen and
  trigger exactly one read-only `status --json` the app already runs on a
  five-second timer, spammably — and no verb that changes the machine.
  `desktop_reset` lives in `console.json` alone; it takes ONLY a typed hostname
  (compared against Rust's own memoized `hostname(1)`, so the page supplies a
  string, never a path), the five deletion paths come from the server's own
  `status --json` `paths` block all-or-nothing, an absent or partial block
  means the screen refuses, and a recursive delete that would contain the
  installed `~/.local/bin/subshell-server` is refused before anything runs.
  Enrolled remote nodes and a same-machine `subshell` node agent are NOT
  reached by a reset and keep their keys and processes; that is stated in the
  confirmation itself.
- **The client app's remote window is granted NOTHING.** A control plane can
  live on any host, so its origin cannot be enumerated in a capability file the
  way loopback can — and rather than reach for runtime ACLs, no capability names
  that window at all, so every `invoke` from it is refused. It is also built
  WITHOUT the `SubshellDesktop/…` user-agent marker, so the SPA never takes its
  desktop-shell branch and never tries; `on_navigation` still pins it to the
  origin it opened with. An XSS in a control plane's SPA therefore reaches
  nothing in Subshell Client.
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
