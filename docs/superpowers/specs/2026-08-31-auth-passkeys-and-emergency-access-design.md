# Auth: Passkeys, Setup Password Confirm, Emergency Admin Login

**Date:** 2026-08-31
**Status:** Approved design (brainstorming complete, pending implementation plan)
**Author:** Theo + Claude (brainstorming session)

## 1. Problem

Three gaps in the auth stack:

- **Password is the only credential.** better-auth 1.7.1 is configured with
  `emailAndPassword` + the `apiKey` plugin only; there is no passkey support.
- **First-time setup doesn't confirm the password.** `setup.tsx` has a single
  `#password` field — one typo and the admin is locked out of the very account
  that owns the instance (no reset path exists; see
  [[2026-08-30-auth-experience-design]]'s "no mail surface" note).
- **A forgotten admin password is a hard lockout.** There is no forgot/reset
  flow and no mail sender. Recovery today means editing the SQLite file by
  hand. We want a deliberately crude, operator-controlled break-glass: an env
  var whose value lets admin accounts sign in, a loud banner while it's armed,
  and a UI path to set a new password without knowing the old one.

## 2. Decisions ratified during brainstorming

| # | Decision | Choice |
|---|----------|--------|
| 1 | Passkey posture | **Additional sign-in method** — password stays as-is; passkeys are opt-in per user. Rejected: second factor (overkill for a local/trusted service), passwordless-primary (behavioral shift for existing accounts + e2e churn) |
| 2 | Emergency login target | **Any admin account only** — env value + real admin email = sign-in. Rejected: synthetic `admin` identity (no `user_meta` row → would need special-casing in `isAdmin`/`requireAdmin`) |
| 3 | Banner audience | **Everyone, every page** — an armed break-glass affects all users, so all users see it; also avoids role-gating the banner |
| 4 | Frontend integration | **Approach 1 + 3 combined** — adopt the better-auth client for passkey flows *and* migrate the existing raw-fetch auth calls to it. Rejected: hand-rolled WebAuthn (against the "prefer libraries" preference). Deferred-scope-creep concern accepted deliberately by Theo |
| 5 | Hatch mechanism (post-approval revision) | **Rewrite-then-normal-sign-in** — verified against 1.7.1 that forging a session needs a hand-built `GenericEndpointContext` (fragile), while hashing the env value into the account row reuses the proven `hashPassword` write path (`users.route.ts:54`). Drops the forged-session, the `/api/admin/emergency-reset-password` endpoint, and the reset-mode card. Approved by Theo during plan authoring |

## 3. better-auth client migration (frontend)

The frontend currently has **no** better-auth dependency; every auth call is a
raw `fetch` to `/api/auth/*` (`login.tsx:37`, `setup.tsx:57`, `settings.tsx:51`,
sign-out in `app-sidebar.tsx`, `lib/auth.ts:14-17`).

- New pinned deps in `apps/frontend`: `better-auth@1.7.1`,
  `@better-auth/passkey@1.7.1` (exact pins; run `syncpack` per repo rule).
- New module `apps/frontend/src/lib/auth-client.ts`: one
  `createAuthClient({ plugins: [passkeyClient()] })` instance. The client's
  `baseURL` resolves to `/api/auth`, which works under the Vite dev proxy and
  same-origin in prod. `fetchOptions: { credentials: "include" }`.
- Call-site migration, one-for-one replacements:
  - `login.tsx` → `signIn.email({ email, password })`
  - `setup.tsx` → `signUp.email({ name, email, password })`
  - `settings.tsx` change-password → `changePassword({ currentPassword, newPassword, revokeOtherSessions: true })`
  - `app-sidebar.tsx` → `signOut()`
  - `lib/auth.ts` → `authClient.getSession()`
- Error mapping: the client returns `{ error: { message, status, code } }`;
  map into the existing `ErrorBanner` usage. The rate-limit wrapper's response
  shape for 429s must survive the migration verbatim (asserted by
  `auth-rate-limit.test.ts` / `rate-limit-route.test.ts`).
- `apiFetch` stays for all non-auth APIs; nothing else changes transport.

## 4. Passkey support

### Backend

- `bun add @better-auth/passkey@1.7.1` in `apps/backend` (already present in
  the bun store — it's a peer of `better-auth-ui`; it must still be declared).
- `apps/backend/src/auth.ts`: add the server plugin to `AUTH_OPTIONS.plugins`:
  `passkey({ rpName: "mote", origin: <derived> })`.
  - Verified against the installed 1.7.1 package: `PasskeyOptions` accepts
    `rpID`, `rpName`, `origin`, `authenticatorSelection`, `advanced`,
    `schema`, `registration`, `authentication`. There is **no**
    `login: { enabled }` option — passkey sign-in (`/passkey/authenticate`)
    ships enabled with the plugin.
  - `origin`: leave **unset** — 1.7.1's documented behavior is that the client
    supplies the origin when the option is absent, which self-serves both the
    loopback and NetBird-domain cases. Only if the manual-ceremony check fails
    do we fall back to deriving it from the `TRUSTED_ORIGINS`-style origin set;
    a mismatch surfaces as a WebAuthn failure, so the check is mandatory in the
    plan. `rpID` defaults to the request hostname, which is correct for both
    origins.
- The `passkey` table is created by the existing `runAuthMigrations()`
  (`better-auth/db/migration`'s `getMigrations` reads full `AUTH_OPTIONS`,
  same as the `apikey` table) — no hand-written migration.
- `/api/auth/passkey/*` flows through the existing wildcard mount in
  `plugins/auth.plugin.ts`; confirm it isn't caught by the `api-key/*` 403
  blocklist (it isn't — different prefix).
- Bearer API keys are unaffected: passkeys are a browser credential only.

### Frontend

- **Login page**: secondary "Sign in with a passkey" button →
  `authClient.signIn.passkey({})` (discoverable-credential, no email needed —
  verified action name in the shipped 1.7.1 client). A
  `REGISTRATION_CANCELLED`/`AUTH_CANCELLED` error code (user dismissed the
  platform UI) returns to the form silently; other errors go to the error
  banner.
- **Settings → new "Passkeys" card** (every signed-in user, their own
  credentials): add via `authClient.passkey.addPasskey({ name })`, list via
  the client's `listPasskeys` query, remove via `authClient.$fetch(
  "/passkey/delete-passkey", { method: "POST", body: { id } })` (endpoints
  confirmed present in the 1.7.1 dist). Follow the `SystemApiKeysCard`
  component pattern (`components/system-api-keys-card.tsx`). Exact client
  method shapes to be pinned during implementation against
  `@better-auth/passkey/client` types.
- UI copy must state the WebAuthn reality: a passkey registered on
  `127.0.0.1:PORT` does not work on the NetBird domain and vice versa
  (different RP IDs) — register once per origin you use.

### E2E note

Playwright can drive a virtual authenticator (CDP `WebAuthn` domain), but the
ceremony spans the browser's platform UI; treat a full e2e passkey sign-in
spec as best-effort. Fallback: e2e covers the Settings passkey-card
rendering/add-flow with the ceremony mocked, and the real ceremony is verified
manually in the plan's checklist.

## 5. Setup wizard: confirm password

- `apps/frontend/src/routes/setup.tsx`: add `#password-confirm` below
  `#password` (same `minLength={8}`), submit disabled until both match,
  inline mismatch message once the confirm field is dirty. Client-side only;
  the server registration path is unchanged.
- `e2e/tests/01-setup-wizard.spec.ts`: fill the new field (it currently fills
  only `#name/#email/#password`).

## 6. Emergency admin login (`MOTE_EMERGENCY_PASSWORD`)

### Env plumbing

- `apps/backend/src/constants.ts`: `EMERGENCY_PASSWORD =
  env.get("MOTE_EMERGENCY_PASSWORD").default("").asString()`; empty string ≡
  disabled. Document in `apps/backend/.env.example` with a break-glass-only
  warning comment. No prod boot-guard — this is explicitly an operator
  feature; the banner is the guard.

### Sign-in path (rewrite-then-normal-sign-in)

Intercept inside the existing `api/auth-rate-limit.route.ts` wrapper (it
already owns `POST /api/auth/sign-in/email` ahead of better-auth and parses
the body):

1. Var unset, or body password ≠ var value → fall through to better-auth
   unchanged (emergency attempts share the normal per-email backoff).
2. Password matches the env value exactly:
   - account exists and `user_meta.role === 'admin'` → overwrite that user's
     credential hash (`UPDATE account SET password = <hashPassword(envValue)>
     WHERE userId = ? AND providerId = 'credential'`), then forward the
     ordinary sign-in. better-auth verifies the value it just stored and
     mints a **real session** through its own path — no internal-context
     forging. The wrapper's success branch clears the attempt counter as
     usual.
   - otherwise (no account / non-admin) → fall through unchanged, so the
     response is identical to a bad password (no signal about which half
     failed).

### Recovery (no new endpoint)

After signing in, the admin **knows** the current password — it is the env
value — so the existing better-auth `change-password` flow works unchanged;
no reset endpoint and no "reset mode" UI are needed (the original plan for
both is dropped per decision #5). The banner tells the admin exactly this.

Accepted consequence: the moment the hatch is used, the old (forgotten)
password is destroyed, and clearing the env var without setting a new
password locks the admin out until the hatch is re-armed. The banner exists
to prevent exactly that.

Verified against 1.7.1: sign-in verifies `account.password` with
`ctx.context.password.verify`, whose hasher matches `hashPassword` from
`better-auth/crypto` — the exact primitive `users.repository.ts:62-65`
already uses to create sign-in-able credential accounts.

### Banner

- `GET /api/settings/public` gains `emergencyLoginActive: boolean`
  (`settings.route.ts:19`; already unauthenticated — the flag leaks only
  that break-glass is armed, which the banner itself broadcasts).
- App shell (`__root.tsx`, signed-in branch) renders a new **warning** variant
  on `components/error-banner.tsx` (amber tone, `role="alert"`, not
  dismissible) for every signed-in user:
  *"Emergency admin login is enabled. Admins should set a new password now,
  then remove MOTE_EMERGENCY_PASSWORD and restart the server."*
- Fetch via the existing settings/public query pattern; respect the careful
  `staleTime` discipline used by `setup-status` (avoid polling churn).

## 7. Testing

- **Backend (`bun test`)**, using the `api/__tests__/helpers/auth-tables.ts`
  suite pattern (real migrations + real `signIn` helper):
  - emergency sign-in: match + admin → 200 with session cookie, AND the old
    admin password now fails (hash was replaced); match + non-admin → 401
    identical to bad-password AND the non-admin's password still works (no
    rewrite happened); var unset → pure passthrough (env-value password
    rejected); unknown email + env value → 401; wrong-password backoff still
    applies around it.
  - recovery is just the existing change-password flow (already covered by
    the migrated e2e path), so no new endpoint tests.
  - `settings/public` includes `emergencyLoginActive` in both states.
- **Frontend / e2e (Playwright)**:
  - `01-setup-wizard.spec.ts`: confirm-field parity (mismatch blocks submit).
  - migrated login path keeps the rate-limit 429 display green.
  - passkey card rendering with mocked ceremony; real ceremony manual-check
    list (register on loopback, sign in with passkey, delete).
- **Isolation guarantee**: all tests run on the per-process temp DB
  (`constants.ts:66` forces it under `MOTE_TEST_MODE`, ignoring
  `DATABASE_PATH`); a dev server in this worktree defaults to its own
  `./data/` — the live instance's database is never touched. Serve manual
  checks on a distinct `SERVER_PORT` to avoid colliding with the running
  instance.
- Repo verification loop on every change: `bun run verify-types`,
  `bun run lint:check`, `bun run test`; `turbo build` after backend route
  changes (Eden Treaty inference).

## 8. Out of scope

- Email-based forgot/reset (no mail surface — this design replaces that need
  with break-glass).
- Passkey as second factor; TOTP; WebAuthn Attestation.
- Mobile app (`apps/mobile`) auth — different branch.
- Removing the leftover `better-auth-ui` dep from the backend (noticed in
  passing; unrelated cleanup).
