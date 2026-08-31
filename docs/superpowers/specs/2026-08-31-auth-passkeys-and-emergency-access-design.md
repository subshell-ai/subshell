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
  `authClient.passkey.authenticate({})` (discoverable-credential, no email
  needed). Cancel/AbortError from the platform UI returns to the form
  silently; other errors go to the error banner.
- **Settings → new "Passkeys" card** (every signed-in user, their own
  credentials): list via `listPasskeys()`, add via
  `addPasskey({ name })`, remove via `deletePasskey({ id })`. Follow the
  `SystemApiKeysCard` component pattern
  (`components/system-api-keys-card.tsx`).
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

### Sign-in path

Intercept inside the existing `api/auth-rate-limit.route.ts` wrapper (it
already owns `POST /api/auth/sign-in/email` ahead of better-auth and parses
the body):

1. Var unset, or body password ≠ var value → fall through to better-auth
   unchanged (emergency attempts share the normal per-email backoff).
2. Password matches exactly:
   - account exists and `user_meta.role === 'admin'` → create a session via
     better-auth's internal adapter (`internalAdapter.createSession` + the
     context's cookie setter — the same mechanism better-auth uses; exact
     1.7.1 surface to be confirmed at implementation start) and return it as
     a normal successful sign-in.
   - otherwise (no account / non-admin) → respond exactly like a bad password
     (no signal about which half failed, no special case).

### Forced reset

- New endpoint `POST /api/admin/emergency-reset-password` — body
  `{ newPassword }`; guarded by `requireAdmin` (cookie-only, per the existing
  admin-route posture) **and** 403 whenever `MOTE_EMERGENCY_PASSWORD` is
  unset, so it is inert in normal operation.
- Implementation mirrors the admin-mints-user precedent (`users.route.ts:51-63`):
  hash with `better-auth/crypto.hashPassword` and update the caller's own
  credential row directly; revoke all the caller's other sessions. The caller
  keeps their current session (they're mid-recovery).
- No session tagging: while the hatch is armed, the Settings change-password
  card renders in **reset mode** (new password + confirm; current-password
  field replaced by a notice). Rationale: an armed hatch is a conscious
  operator act, and the only sessions that can use the endpoint are admin
  sessions anyway.

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
  - emergency sign-in: match + admin → session cookie; match + non-admin →
    401 identical to bad-password; var unset → pure passthrough; normal
    password still works while armed; backoff still applies.
  - `emergency-reset-password`: 403 unarmed; updates the hash (old password
    fails, new succeeds); other sessions revoked, current session alive;
    non-admin session → 403.
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
