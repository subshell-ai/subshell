# OIDC sign-in with approval — design (2026-09-24)

Sign people in through external identity providers — Google first, generic
OIDC behind it — under an admin-managed provider list, with an optional
approval step for accounts those providers create.

**Written to be implemented by someone who has not read the conversation that
produced it.** Every decision carries its reason.

The operator's requirements, stated 2026-09-24 and not up for re-deciding:

1. OIDC auth via better-auth, with Google as a first-class provider.
2. An OIDC identity links to an existing account when the emails match.
3. The user action menu must not offer "Reset password" to accounts that have
   no password to reset.
4. The users table gains a **Provider** column.
5. A new **Server Settings → Auth** page where an admin adds an identity
   provider through a dialog.
6. "E-mail" is itself a provider row with two toggles — registration, sign-in —
   and every OIDC provider carries the same two.
7. A provider can **require approval**: signing in creates the account, but the
   person sees a pending-approval screen until an admin acts; a rejected person
   sees the same screen until they are approved, so reject and approve states
   must persist.
8. (Added mid-design) Email registration is refused when an OIDC account
   already exists for that email.

## 1. Which plugin, and why not the other one

better-auth 1.7.1 ships two OIDC doors. The **SSO plugin** is the
enterprise-shaped one: providers resolved by *email domain*
(`POST /sso/sign-in` takes an email and picks the provider), organization
tenancy, SAML, verified-domain membership rules. Our model is the opposite —
an admin-curates-a-list product, and the door is a **button on the login page**
resolved by provider id. The **genericOAuth plugin** is the right shape:
`signIn.social` / `linkSocial` from the client, callback at
`{baseURL}/api/auth/callback/:providerId`, per-provider `providerId` +
`clientId` + `clientSecret` + discovery (`discoveryUrl`, or explicit
authorization/token/userInfo URLs for non-discovering issuers), and
`mapProfileToUser` / `getUserInfo` / `validateUserInfo` hooks.

Decision: **genericOAuth**. The SSO plugin's `ssoProvider` table would sit
beside our own provider table as a second source of truth and buy nothing we
asked for.

## 2. Where provider config lives

New table `auth_providers` — migration `0037-auth-providers.ts` in
`apps/server/api/src/db/migrations/`, registered by name in `db/migrate.ts`
(the file + map entry are both required; the names must match).

| column | meaning |
|---|---|
| `id` | slug (`google`, `keycloak-acme`); becomes better-auth's `providerId`; `"email"` is reserved for the E-mail row |
| `kind` | `"email" \| "google" \| "oidc"` — `google` is a preset (prefilled issuer, logo); `oidc` is the generic form; `email` carries toggles only |
| `name` | display label on the sign-in button |
| `issuer` | OIDC issuer; discovery is `{issuer}/.well-known/openid-configuration`. Null for `email` |
| `client_id` / `client_secret` | Null for `email`. The secret lives in the 0600 DB file — the same posture as setup keys, which are stored in plaintext to their creator |
| `enabled` | master switch — a disabled provider is not offered and not built |
| `entry_origins` | the hosts this provider's door can round-trip through — an admin-curated LIST of origins (§5a). Each admits `{origin}/api/auth/callback/{id}`; the first is the canonical fallback. Null on `email` rows |
| `allowed_domains` | optional comma-separated email domains (`acme.com, acme.io`); null/empty = any. When set, an email outside the list cannot use this door at all — link, sign-in or create (§5) |
| `sign_in_enabled` | offer the door to existing accounts |
| `registration_enabled` | allow the door to CREATE accounts |
| `require_approval` | accounts this provider CREATES start `pending` (§4) |

Row order is list order. `created_at` / `updated_at` as everywhere else.
The E-mail row can never be deleted — it is the fallback door and the
carrier of the bootstrap semantics; it is toggled, not removed. Delete
offers only OIDC rows.

**The E-mail provider row** (`id = "email"`, `kind = "email"`) is created by
the migration with defaults mirroring today's world: `enabled`, `sign_in_enabled`
and `registration_enabled` true. Its `registration_enabled` **replaces** the
global `allow_registrations` settings row: `services/registration-gate.ts`
reads the email row instead, keeping its fail-closed semantics (a corrupt read
means closed), and the "absent row means open only while no users exist"
bootstrap is untouched — it keys off `hasAnyUser`, not the row. The row on
Settings → General loses its switch; the key becomes dead data, harmless.

Migration note: the 0037 migration inserts the email row unconditionally, and
its initial `registration_enabled` copies the live meaning of the old gate —
row present → its boolean; row absent → open iff no real accounts exist.
That keeps a freshly upgraded instance behaving exactly as before.

## 3. How the config reaches better-auth

`AUTH_OPTIONS.plugins` gains `genericOAuth`. Its `config` is a **static array
built when the auth instance is constructed** — the docs show no per-request
provider function, so live table reads per request are not the mechanism.
Instead: `buildAuth()` filters `auth_providers` (`enabled` rows with
`sign_in_enabled` or `registration_enabled`) into the config array, and
`auth.ts` gains `invalidateAuth()` — a sibling of the existing
`resetAuthForTests()` — that drops the memoized singleton so the next request
rebuilds. Every successful write to the table calls it. No process restart.

Consequence that must be handled: genericOAuth fetches discovery metadata at
instance build, and a provider with broken discovery is silently skipped (or
sours the rebuild). Therefore **the admin dialog validates before saving**:
the create/update route fetches `{issuer}/.well-known/openid-configuration`
and refuses (400) an issuer whose document is unreachable, malformed, or
missing the endpoints genericOAuth needs. A save that would produce a
vanishing button is refused loudly instead.

Registration gating per provider rides **`validateUserInfo`**, which
genericOAuth calls per provider with the action in play
(`create-user | link-account | sign-in`): a provider whose
`registration_enabled` is false returns `reject` on `create-user` and passes
the others. The email path keeps the existing `user.create.before`
registration-gate hook, now consulting the email row (§2). Linking relies on
better-auth's own rule plus §5's verified-email condition.

## 4. Sign-in, creation, and approval

The flow on `GET /api/auth/callback/:providerId`:

- **Email matches an existing account** → better-auth links the account row
  and mints a session. `require_approval` does **not** apply here — the admin
  already admitted this person somehow. A pending/rejected arrival counts as
  an existing account for this check (its user row exists; §6 keeps it out of
  member lists, not out of existence).
- **New email, provider `registration_enabled`** → user + account created
  through the normal better-auth flow. `require_approval` on ⇒ mark the new
  user `approval_state = pending` and **refuse the session**; off ⇒ the user
  is a plain approved member.
- **New email, registration off** → refused with the same generic error the
  closed registration gate returns today; nothing leaks about why.
- **A `rejected` person signing in again** → identical pending screen
  (§7). Deliberately indistinguishable; the admin side keeps the truth (§6).
- **`disabled`** still wins over everything: `session.create.before` already
  refuses it and is unchanged.

Session refusal is enforced in **`session.create.before`** — the same seam
where `disabled` is refused today (`auth.ts` `signInAllowed`) — extended to
refuse `approval_state = pending | rejected`. The OAuth callback then
redirects the browser to `/pending?email=…`; the email is echo-only display,
never an authorization. **Measurement for the plan to run first:** whether a
refused session at the OAuth callback surfaces as a browser redirect with an
error parameter or as a JSON body at the callback endpoint. If it is not
already a redirect to our `/pending`, the callback's after-side must issue
that redirect itself (better-auth supports post-callback redirect control;
the exact member is a plan detail). The user-visible contract — a pending
person's OAuth round trip lands on `/pending`, never on `/login` with a
mystery error — is the requirement; the mechanism is what the measurement
decides.

Approval is **creation-only, per the operator's ruling**: it gates account
CREATION by that provider. It is a future-boundary tool like `allow_registrations`
— turning it on never strands people who already signed in.

Audit: `SIGN_IN_ENDPOINT_METHODS` in `auth/audit-hooks.ts` gains the OAuth
callback path with method `oidc:<providerId>` (success rows only, per the
existing rule). Refusals — registration closed, pending, rejected, bad state
— write **nothing**, the same anti-spam rule as failed logins.

## 5. Linking, and its security accounting

The link rule is bidirectional-asymmetric, by decision:

- OIDC sign-in whose email matches an existing account → link, straight in.
- **Email registration whose email is already claimed → refused**, with an
  honest message naming the provider ("an account for this email exists —
  sign in with Google"). This is mostly already true — better-auth's
  `signUp.email` refuses any existing email, and `POST /api/users` 409s on a
  UNIQUE violation — but today it is a happy accident of a unique index, not
  a stated rule. It must hold explicitly against **pending** arrivals (the
  person denied approval cannot enter through the password door), and it gets
  a test pinning it so no future change mistakes it for slack.
- Admin user creation keeps its generic 409 (an admin typing an email that
  exists does not need a provider name back; it discloses account existence
  to... them, and they already see every email per §3 of the security rules).

**The domain gate.** When `allowed_domains` is set, every callback email is
matched (case-folded; the email's domain matches if it **equals** an entry
or **ends with `.` + entry**, so `acme.com` admits `mail.acme.com` and never
`evilacme.com`; no `*` syntax, entries are validated bare-domain) **before** better-auth's link/create
decision — `validateUserInfo` sees all three actions per provider, so the
check rides there and refuses whatever it contradicts: no link, no create,
no pending row, the generic refusal. That includes a pre-existing linked
account: a door whose domains stop matching stops letting its own linked
users in — a door policy, consistent with `sign_in_enabled` turning the same
door off for everyone. For a Google Workspace company this is the difference
between "anyone on Earth with a Google account can knock" and "your staff
can enter," and many instances will prefer it to require-approval.

The cost of the link-straight-in rule, stated plainly: **a generic OIDC
provider can assert any email it likes, and linking turns that into takeover
of the matching account.** Adding a provider is therefore the same class of
trust decision as installing a plugin — admin-only, audited, and the dialog
says so in one line of help text. Google's verified-email assertion is
trustworthy; an issuer the admin pastes in at 2am might not be. Linking
requires the provider's profile to mark the email **verified**
(`mapProfileToUser` sets `emailVerified` only from the provider's verified
claim, never from the mere presence of an email), and `validateUserInfo`
returns `reject` for `link-account` when that claim is absent. This goes into
`docs/security.md` (new subsection under the auth sections) and the working
summary in `.claude/rules/security-context.md`.

**5a. Entry points, and telling the admin what to give the IdP.** A Subshell
instance answers at several addresses by design — loopback, LAN,
`APP_BASE_URL`, mesh addresses published by network plugins — and a person
may click "Sign in with Google" from any of them. An OIDC app registration
pins redirect URIs, and IdPs (Google included) accept **multiple** redirect
URIs on one client, so a provider carries **a list of entry origins**, not
one:

- The dialog's host selector is a **list editor**: add hosts picked from the
  live origin registry (the same set the CORS derivation and the Networking
  page's Addresses card read — `originRegistry().current()`), plus an
  "Other…" escape for an address the registry has not learned yet. Each
  entry is validated bare-origin, no path/query/wildcard — the
  component-wise trusted-origin rule, minus wildcards. `APP_BASE_URL`'s
  origin is pre-added on create and is the **canonical fallback** (list
  position 1); the list can be reordered.
- **The round trip follows the visitor.** A sign-in request originating from
  a host in the provider's list uses that host's callback URL
  (`{origin}/api/auth/callback/{id}`) as `redirect_uri`, so the cookie lands
  where the click happened and the user stays on the address they came from.
  A request from a host NOT in the list falls back to the canonical entry —
  the flow still completes, landing the user on that host's SPA (a page on
  host-B cannot carry host-A's `SameSite=Lax` cookie, so arriving at the
  fallback host is the honest behavior, not a bug to hide).
- **The membership test never composes from the request.** The chosen
  `redirect_uri` is always one of the stored list's strings byte-for-byte —
  the request's origin is matched against the list, and the only value ever
  sent to the IdP is the stored entry plus the fixed callback path. This is
  the same rule that keeps the CORS allowlist from ever trusting the request
  Host (§8 of the security rules): matching, never derivation.
- The dialog shows a **"finish the setup at your provider" panel** listing,
  per entry origin, the exact Redirect URI and the Authorized JavaScript
  origin (Google wants both kinds), each in a copy-field, plus a
  copy-all block — so the admin pastes the whole list at the IdP in one
  pass. Shown live while filling (the provider id is the name slug) and
  again in the edit dialog. Adding an entry warns it must be registered at
  the IdP before that host's door works; removing one warns the reverse.
- A fresh instance's only option is usually `http://127.0.0.1:3080` —
  Google accepts `http://localhost` redirect URIs for development, so the
  selector normalizes the loopback spelling to what the IdP will accept and
  the panel copy says so. Real deployments should point `APP_BASE_URL` at
  the https address before registering production OIDC apps.

Mechanism note for the plan to verify against better-auth 1.7.1: whether the
genericOAuth `redirectURI` can be chosen per request (config-as-function
surface or `queryParameters` override). If it cannot, the shipped behavior
degrades honestly: every round trip uses the canonical entry, and the extra
list entries exist so the registration panel and the follow-the-visitor
behavior light up the moment better-auth supports it — the stored list and
the membership rule are the same either way, so this is a capability
difference, not a redesign.

The anonymous pre-auth surface grows but stays **one route**: the login page
learns which buttons to draw from `GET /api/settings/instance`, whose body
gains `providers: [{ id, name, kind }]` — public facts only, no secrets in any
shape. The existing key-set-pinning test grows to pin the nested array shape,
and the "the one anonymous read" rule in `security-context.md` is amended to
say the read is one route that also names the doors.

## 6. Pending state, and what must not see it

`user_meta` gains `approval_state` (migration, text, default
`"approved"`; an absent row reads `approved`, mirroring how absent reads
`disabled = false` today). Values: `approved | pending | rejected`, exported
as a union + runtime array per the code-style rule.

The load-bearing exclusion: `REAL_ACCOUNT_FILTER` in
`db/repositories/users.repository.ts` — which counts real accounts for
`hasAnyUser` and feeds `GET /api/users` — additionally excludes
`pending`/`rejected`. Without this, the first OIDC arrival at an
unconfigured instance would trip `promoteFirstUserToAdmin` through the
`user.create.after` hook and hand admin to a person no one approved. Pinned
by two tests: first-admin promotion skips a pending creator; the bootstrap
window stays open past a pending arrival.

`GET /api/users` keeps its shape for members and gains nothing unapproved.
The pending list is a separate admin-only read: `GET /api/users/pending`
(rows: id, email, name, provider id/name, arrived-at, `approvalState` —
pending or rejected, which the admin column shows). Members are never told
who is pending.

**Pending-row lifecycle** — an open Google door means anyone with a Google
account can knock, so the tab must not be an unbounded junkyard:

- **Dedup by email.** A callback whose email matches a `pending` or
  `rejected` row updates that row's `arrived_at` and re-shows the pending
  screen; it never mints a second row. (An email is unique in the `user`
  table anyway, so this is better-auth's existing find-or-create behavior
  with the timestamp touch added.)
- **Pending expires.** Unactioned `pending` rows older than
  `pending_approval_expiry_days` (a settings row, admin-set on Settings →
  Auth, default **30**, `0` = keep forever — the log-retention idiom) are
  deleted by the existing hourly sweep pass: the `user`, `account` and
  `user_meta` rows go together. A knocked-and-forgotten person who returns
  later simply re-arrives.
- **Rejected never expires.** Rejection is an explicit admin decision and
  must not silently reopen the door on a timer; rejected rows persist until
  an admin approves or deletes them. No pile-up risk: dedup keeps knockers
  on their one row.

## 7. UI

**Login page** (`routes/login.tsx`): provider buttons above the passkey
block, following its pattern (the OAuth round trip is a full-page redirect,
not the fetch-style call — `authClient.signIn.social({ provider, callbackURL })`).
E-mail sign-in itself is hidden when the email row's `sign_in_enabled` is off;
the passkey button hides with it, since passkeys are credential accounts.
If NO door is open, the page says so rather than showing an empty card.

**`/pending?email=…`**: a third bare frame beside `/login` and `/setup`
(`__root.tsx`): instance name, "Your sign-in is awaiting approval", the email,
and a "Sign in again" button that re-runs the provider round trip — which is
how a rejected person sees the identical screen. No copy distinguishes
pending from rejected; that is the feature.

**Settings → Auth** (new `routes/settings_.auth.tsx` + admin nav entry in
`app-sidebar.tsx` in the Server Settings group): provider list table — name,
kind badge, sign-in / registration / require-approval toggles per row,
enabled master switch, edit/delete. The add/edit dialog: kind picker
(Google preset prefills issuer and shows the Google logo; Generic OIDC shows
the issuer/client-id/secret form), the **host selector and registration-info
copy-panel per §5a**, an optional allowed-domains field, the
three toggles with one sentence of
help each (design-system rule: every control's self-explanation is `detail`,
max two sentences), and the discovery-validation error rendered inline on the
failing field. Deleting a provider stops offering the door; it never touches
user or account rows — a linked person simply loses that door (email login
survives if they have a credential). A confirm dialog says so. The dialog
carries the one-line trust warning from §5.

**Discovery is badge-only, by decision:** a new pending arrival pushes
nothing to admins — no new push plumbing, and an open Google door would
otherwise push drive-by knocks. The Pending tab's count badge (and the
Needs Attention rail, which reads it) is the signal.

**The last door cannot be closed.** A provider write that would leave zero
enabled providers with `sign_in_enabled` — disabling the last door,
deleting it, or closing E-mail sign-in while every OIDC door is closed — is
refused with a **409 naming itself**, before anything is saved; the dialog
shows the reason. The escape hatch of last resort is unchanged from today:
`SUBSHELL_EMERGENCY_PASSWORD` + `config.env` from the CLI. (The guard counts
doors, not users — asking "does any remaining admin have a way in" would
need per-user join logic for a question the simple form already prevents.)

**Users page** (`routes/settings_.users.tsx`): gains its first tabs —
**Members** (the existing table + a **Provider** column rendering the linked
methods as badges: `Email`, `Google`, both) and **Pending approval** (tab
badge with the pending-and-rejected count; rows per §6 with **Approve** /
**Reject** buttons; approving a rejected person reverses the state — nothing
was ever deleted). Approve flips `approval_state`; there is no session to
mint, the person's next OAuth round trip is their first sign-in.

**Action menu** (`components/users/user-row-actions.tsx`): "Reset password"
hides when the row has no credential account. The backend already 409s that
case (`setPassword` returns null); the menu stops offering it. `UserRow`
gains `providers: string[]` (or a boolean `hasPassword` — providers[] is
chosen: the Provider column needs it anyway and one field answers both).

## 8. Routes

`/api/auth-providers` — **cookie-admin only** (`requireAdmin`; bearer refused,
machine credentials never manage auth), the same gate as `/api/users`:

- `GET /` admin list (secrets never serialized — the list carries a boolean
  `hasSecret` and the client id, never the secret; edit dialog re-enters it).
- `POST /`, `PATCH /:id`, `DELETE /:id` — validation per §2/§3 (discovery
  probe on create and on any edit that changes issuer/client id; an edit that
  changes no issuer-bearing field skips the probe), each invalidates the auth
  singleton on success, each audited.
- `POST /test` — optional in-dialog "verify credentials" that runs the
  discovery probe and a client-credentials token-endpoint check without
  saving. Cuts a half-broken provider before it exists. Cheap; include.

`GET /api/users/pending` and `PATCH /api/users/:id/approval` (body
`{ "approvalState": "approved" | "rejected" }`). Cookie-admin, same
sub-instance as the other user PATCHes, audited. The route only ever moves a
row **out of** `pending` or `rejected` — writing `approved` onto a target
whose state is already `approved` is a 409, so the route cannot become a
general state hammer against active members (barring an active member is
`disabled`, which is what that switch is for; §9).

Audits added (names per the §10 convention in `security-context.md`, which
this spec updates): `auth_provider.create|update|delete` (metadata names
fields changed and the issuer — never the secret), `user.approve`,
`user.reject` (metadata: target id, email by the user-management naming
convention, provider id).

## 9. Passkeys, sessions, and what does NOT change

- Passkeys ride the E-mail provider's doors: they are credential accounts;
  no separate toggle. Registration via the setup wizard is untouched.
- Session cookie, backoff, break-glass, `accountDisabled` (with its socket
  sweeps), trusted-origin machinery: unchanged. A pending person never had a
  session, so disabling needs no new sweep for approval; **approve needs no
  socket work; reject of a previously-approved member does not exist** —
  rejection applies to never-approved rows; to bar an active member, admins
  disable, as today. (Turning `approved` → `rejected` via the API is refused
  by the 409 in §8 for exactly this reason.)
- Node tokens, system keys, MCP, WS attach: untouched.
- The mobile app is out of scope for this spec (the client SDK will see the
  new anonymous field and ignore it).

## 10. Testing

`bun test` coverage (no new e2e infrastructure — a stub OIDC provider inside
Playwright buys little over route-level tests, and the OAuth round trip is
better-auth's code, not ours):

- Provider CRUD: cookie-admin only, bearer 403; secret never serialized in
  any response or audit row; discovery probe refuses a bad issuer before save;
  successful write invalidates the singleton (assert the rebuild re-reads the
  table).
- Sign-in matrix: link-existing (including pending-existing) straight in;
  create-approved straight in; create-pending → session refused → redirect
  carries to `/pending`; rejected-again → same refusal; registration off →
  generic refusal, no audit row; provider disabled → endpoint refuses.
- Email registration refused for an email held by an OIDC account, pending or
  approved; refusal message names the provider.
- `REAL_ACCOUNT_FILTER`: pending creator does NOT become first admin;
  bootstrap stays open past a pending arrival; `GET /api/users` never shows
  pending rows.
- `PATCH /:id/approval`: pending→approved lets the next OAuth session mint;
  →rejected keeps refusing; approved-target 409.
- Login `providers` key-set test (anonymous body, nested shape).
- Audit: sign-in via OIDC records `method: "oidc:<id>"` on success only.
- Route-level check that the email row's toggle drives the registration gate
  exactly as the old settings row did (the gate's existing tests move onto it).
- Entry points: each stored origin admits its own callback URL; a request
  from a listed host round-trips through it, one from an unlisted host falls
  back to the canonical entry; the emitted `redirect_uri` is always a stored
  list string (a test sends a request from an unlisted Host and asserts the
  callback URL carries the canonical origin, never the request's); "Other"
  validates bare-origin and refuses paths/queries/wildcards; the panel lists
  Redirect URI + JS origin per entry.
- Domain gate: non-matching email cannot link, create, or land in pending —
  including a previously-linked account once domains are added; empty field
  accepts any.
- Lifecycle: repeat knock on a pending/rejected email updates `arrived_at`
  without a second row; the sweep deletes expired `pending` (user + account +
  user_meta together) but never a `rejected` row; `0` disables the timer.
- Last-door guard: closing the final `sign_in_enabled` door 409s and saves
  nothing; opening a second door first makes the same edit succeed.

Verification per repo rules: `bun run verify-types`, `bun run lint:check`,
`bun run test` — and the spec's changes to `docs/security.md` + both rules
files land in the same change, not as a follow-up.

## 11. Decisions summary (the ones someone might want to re-litigate)

1. **genericOAuth over the SSO plugin** — button model, not domain-routing
   enterprise SSO (§1).
2. **Provider toggles replace the global registration switch** — one mental
   model, E-mail is a row like any other (§2).
3. **Config array + singleton invalidation** — genericOAuth has no
   per-request provider function; rebuilding is near-free and matches the
   existing lazy-singleton seam (§3).
4. **Approval gates creation only; existing email links straight in** — the
   admin already admitted them (§4).
5. **Rejected looks identical to pending from the outside** — the operator's
   explicit ask; the truth lives in the admin tab (§4, §7).
6. **Pending rows are excluded from `REAL_ACCOUNT_FILTER`** — otherwise an
   unapproved arrival wins admin at an unconfigured instance (§6).
7. **Adding a provider is an admin-only trust decision**, priced in the docs
   and one line of UI copy (§5).
8. **Email registration refuses a claimed email explicitly**, including
   pending arrivals, with a message that says what to do (§5).
9. **Pending expires (default 30 days, admin-set); rejected never does** —
   an open Google door knocks forever, an admin decision must not decay on a
   timer (§6).
10. **Admins learn via badge, not push** — drive-by knocks must not page
    anyone (§7).
11. **The last sign-in door cannot be closed** (409, break-glass unchanged)
    — an instance with no way in is a support incident, not a feature (§7).
12. **Providers can be domain-scoped**, and the gate binds the door itself —
    a non-matching email never becomes a pending row, and a linked account
    outside the domains loses that door (§5).
13. **Each provider carries a LIST of entry origins**, the round trip
    follows the visitor among them (canonical fallback otherwise), the
    emitted redirect URI is always a stored string matched by membership,
    and the dialog hands the admin the exact Redirect URI / JS origin per
    entry to register at the IdP (§5a).
