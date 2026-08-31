# Security Context

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
  - *Break-glass*: while `MOTE_EMERGENCY_PASSWORD` is set, an admin signing in with that
    exact value has **their credential overwritten** by it and a real session is minted —
    destructive by design, signalled by a warning banner to every signed-in user
    (`GET /api/settings/public → emergencyLoginActive`). Clear the var after recovery.
- **Bearer API keys** (`Authorization: Bearer mote_...`, via `@better-auth/api-key`) —
  machine credentials:
  - *Per-session tokens*: minted when a session starts (7-day TTL, self-extending for
    long-running agents), scoped by permissions, and **revoked immediately** when the
    session is terminated/deleted (restart rotates the key — auto or manual — on the same row). This is what the
    `mote mcp` server and any harness tooling authenticate with.
  - *System keys*: long-lived, no permission ceiling, owned by the `system` service user,
    created by admins under **Settings → System API keys** (plaintext shown exactly once;
    only a hash is stored). Treat them as full-access bearer credentials — disable/delete
    revokes instantly.

Admin-gated routes (`/api/users`, `/api/system-keys`, …) **reject bearer keys** (403):
machine credentials can never manage the instance.

WS attach requires a short-lived (30 s) single-use token minted through an authenticated
REST call — replay-resistant.

## Session sharing (spec 2026-08-31)

A session is **private to its owner by default** — it is absent (404, never 403) from
every other user's list, detail, log, terminal, and workspace-pane path, so ids cannot be
probed. The owner may grant two levels, to **Everyone** (all signed-in users) or to
specific users, via `PUT /api/sessions/:id/shares`:

- **view** — read only: list, detail, pane log, and a read-only live terminal.
- **edit** — view + interact and manage: terminal input, rename, notes, restart,
  terminate.

Owner-only actions (never conferred by a grant, and not held by an admin either): **delete**,
**managing the shares themselves**, and the **notification bell**. Sharing is a browser
(human) act — a bearer/session key is refused on the shares routes and, on every other
per-session route, runs with the admin boost and shared grants switched **off**, so a
machine token can act only on its own owner's sessions, never a foreign or shared one.

Admins hold instance-wide **edit** (effective operator access) — they can read and
interact with any session but cannot delete it or re-share it; those stay with the real
owner.

Notifications are **owner-targeted**: a push goes only to the session owner's devices,
gated by a per-user master switch (`user_meta.notify_enabled`, on by default) and the
per-session bell (`sessions.notify`, on by default for new sessions). Sharing widens who
can *see/act* on a session; it never widens who gets *pushed* about it.

This is a deliberate widening of exposure beyond the owner, sound only on the
trusted-network posture below — a share makes a session's full pane output (potentially
secrets on screen) and, at `edit`, its keystroke stream visible to the audience. Revoke by
clearing the grant (the sharing dialog or an empty `PUT`).

## Encrypted channels (cross-session comms)

Channel posts are sealed per-recipient with ECDH-ES + A256GCM (`jose`) to each session's
identity keypair; the backend stores and forwards only opaque ciphertext it cannot read.
The E2EE boundary protects message bodies from **the server's storage, backups, and any
remote peer that compromises them** — and from other sessions that are not channel
recipients. It does NOT protect:

- **Metadata** — channel names, membership, post timing/order, message sizes, and
  principals are plaintext on the server.
- **A local OS user on the host** — session keypairs live on the same disk the backend
  runs on; whoever owns that user account can read them (and the harness panes).
- Session tokens themselves: a running harness holds its own bearer key by
  design — and the token is part of the tmux start command, so it is visible to
  any local process that can read `ps` output or tmux's pane metadata.

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

- **No string length limits on log/session fields**: they vary legitimately; limiting them
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

If this service is ever deployed to a shared or public environment:

- Serve over HTTPS only; set `secure` cookies, a real `BETTER_AUTH_SECRET`, and strict
  `TRUSTED_ORIGINS`.
- Proper CORS origin validation and rate limiting on all routes.
- Input length validation and pagination for every list endpoint.
- Rotate/review **system API keys** via Settings — they are long-lived bearer-equals-full
  credentials; every holder is effectively an operator.
- Re-examine the E2EE threat model: it does not protect metadata or a host-compromising
  local user (see above).
