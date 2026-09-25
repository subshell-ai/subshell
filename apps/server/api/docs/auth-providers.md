# Sign-in providers: the full account. Moved verbatim from `apps/server/api/AGENTS.md` ("Architecture"); AGENTS.md keeps the summary and routes here.

**Sign-in providers (spec 2026-09-24).** Provider config lives in the
`auth_providers` table (migration 0037; the E-mail provider is row `email` and IS
the old global registration switch, its `registration_enabled` NULL meaning
the legacy dynamic window; migration 0038 adds `user_meta.approval_state`).
`buildAuth()` filters enabled non-email rows into the `genericOAuth` config
when the better-auth singleton is constructed, and `invalidateAuth()` (a
sibling of `resetAuthForTests()`) drops the memo so every successful
`/api/auth-providers` write takes effect without a restart. Providers are
built FAIL-TOLERANT: each config entry pins `accountIssuer` to the stored
issuer and carries the endpoints discovery resolved AT SAVE TIME, so a rebuild
never re-fetches a dead issuer, `genericOAuth` stays out of `AUTH_OPTIONS`
(a throwing provider must not crash boot's migration path), and a throwing
rebuild serves the last-known-good instance. **Provider policy is one global
seam**, `options.user.validateUserInfo` → `auth/provider-policy.ts` (1.7.1 has no
per-provider hook); it never fires on the password/passkey SIGN-IN paths, so
`auth/provider-guards.ts` (`hooks.before`) carries those two refusals for a
closed E-mail provider, with `closed` meaning EITHER flag: the guard reads
`enabled = 0` beside `sign_in_enabled = 0` (final review, Important 1: the
master switch was hiding the provider in the UI while the API kept signing
people in), with break-glass exempted by a server-held nonce, and, equally
load-bearing, `registration_enabled` does NOT gate SIGN-IN, only creation:
the legacy dynamic window closes the gate while every member keeps their way
in (pinned both ways in `provider-guards.test.ts`). A
`require_approval` provider's first arrival is marked pending at
`databaseHooks.account.create.after` (the only seam that sees the provider at
creation; it also undoes any first-admin promotion its own write caused,
clearing the `setup_step` bookmark with it) and its session dies at
`session.create.before`, where PENDING now sits beside DISABLED
(`services/account-status.ts`); returning pendings are refused by the policy
hook with the code the login page maps to `/pending`. The hourly sweep
(`services/pending-approvals.ts`) expires stale `pending` rows (never
`rejected`) and re-marks failed-mark arrivals. `/api/auth-providers` is
cookie-admin only; verification is the save gate: discovery plus, where the
issuer advertises the grant, one token request (400 `DISCOVERY_FAILED` /
`CREDENTIALS_REJECTED`; the separate probe route was deleted by the 2026-09-25
ruling), the client secret is never serialized or audited, and no write may close the
LAST open sign-in provider (409 `LAST_SIGN_IN_PROVIDER`). The PATCH also refuses
`issuer`/`clientId`/`entryOrigins` on the E-mail row (that row runs no
exchange; the route used to accept them and even probe discovery against a
nonsense email-row issuer), and every provider's `name` goes through the shared
`normalizeLabel` + 120-code-point cap like every other user-visible NAME;
it renders on the anonymous login buttons. On the §5a entry origins: what
reaches the IdP is ALWAYS the stored canonical entry (list position 0),
because 1.7.1's genericOAuth `redirectURI` is a static config string
(measured, `types.d.mts:116`; a function value would be URL-serialized, not
called); follow-the-visitor waits on the upstream capability,
`pickEntryOrigin` stands as the pinned membership rule, and flow-matrix
case 14 pins the emitted URI. The security accounting is
`docs/security.md` §2's "OIDC sign-in with approval".
