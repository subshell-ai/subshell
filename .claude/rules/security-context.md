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
is useless against a compromised account); an admin cannot reset their OWN
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
  shared. `edit` (or owner) additionally configures the node (harness
  toggles, re-checks); only the owner manages it (shares, rename) — admin for
  `local`. The owner controls everything launched there; whoever owns the
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
- Trusted-network posture is **unchanged**: node→control traffic is expected to
  ride the same VPN/Tailscale; `wss://` termination is the operator's
  deployment. **Enroll-time loopback trap:** if the server URL is `localhost`-
  ish, a remote node dutifully dials the wrong machine — the enroll flow and
  Nodes page surface the resolved URL and warn on loopback.

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
