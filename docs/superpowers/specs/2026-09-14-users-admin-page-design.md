# A dedicated Users page under Server Settings — Design Spec (2026-09-14)

Builds on `2026-09-11-grouped-navigation` (the Server Settings group) and the
admin user-management spec of 2026-09-05 (`POST /api/users`, role and password
routes), both of which stay in force.

## Context

Today the roster lives at `/users`: a page in the Server Settings group of the
rail but outside the `/settings/*` namespace, **reachable by URL for members**
(who see a read-only table), with the admin's "Add user" form sitting inline as
a card above the table. That form asks for email, password and role; the
account it creates gets its email written into the `name` column, because the
route never asked for a name.

The first-run setup (`routes/setup.tsx`, step 0, "Create Your Account") asks
for **Name, Email, Password, Confirm password**, states the password
requirement before it is broken, and flags a mismatch once the confirm box is
left. That is the form an account should be created with, and the admin's
inline form is a second, thinner copy of it.

Decisions taken in conversation (2026-09-14):

- **One Users page, an admin page, at `/settings/users`.** `/users` is deleted
  rather than redirected — the repo has no users to keep a URL for (memory:
  prefer the clean end state). Members lose the read-only roster PAGE; the
  roster API stays instance-wide because the sharing picker reads it.
- **Adding a user is a dialog opened from the page header**, and its form IS
  the setup form — one component, not a copy — plus a Role select, the one
  field setup does not have because the first account is an admin by
  definition.
- **The server learns the name.** `POST /api/users` takes `name`, and the
  roster returns it.

---

## Design

### 1. Server: `POST /api/users` takes a name; the roster returns one

`apps/server/api/src/api/users.route.ts`:

- `CreateUserBodySchema` gains `name: t.String({ description: "Display name for the new account" })`.
  The handler trims it and refuses an empty result with
  `UsersError("bad_request", "Name is required.", 400)` — schema-level
  `minLength` would accept a run of spaces.
- `UserRowSchema` gains `name: t.String({ description: "Display name" })`;
  `CreateUserResponseSchema` gains the same.
- Audit metadata stays `{ email }` — the row names an account, and the email
  is its identity.

`apps/server/api/src/db/repositories/users.repository.ts`:

- `createUser` takes `name` and writes it to `user.name` instead of the email.
- `UserWithRole` and `listWithRoles` carry `name` (`u.name` — better-auth's
  camelCase table, so it is quoted like `createdAt`).

Tests (`users-admin.test.ts`): the create test sends a name and asserts the
roster row and the response carry it; a new case sends a blank name and
asserts 400 with a body that never echoes the password.

`turbo build` afterwards, so `backend-client`'s inferred type sees the field.

### 2. One account form, shared by setup and the dialog

New `apps/server/web/src/components/account/new-account-fields.tsx`:

```ts
export interface NewAccountValue { name: string; email: string; password: string; confirmPassword: string }
export const EMPTY_NEW_ACCOUNT: NewAccountValue;
/** Everything typed and consistent: name and email present, password long enough, confirm matching. */
export function newAccountComplete(value: NewAccountValue): boolean;
export function NewAccountFields(props: {
  value: NewAccountValue;
  onChange: (next: NewAccountValue) => void;
  /** Prefix for the four input ids, so two forms on one page cannot collide. Default: none (setup's existing ids). */
  idPrefix?: string;
  /** Focus the Name box on mount (setup does; a dialog does too). */
  autoFocus?: boolean;
}): JSX.Element;
```

It renders exactly what setup step 0 renders today: the four labelled inputs
(labels **Name / Email / Password / Confirm password**, unchanged so
`setup.test.tsx` keeps passing), the password requirement line
(`PASSWORD_REQUIREMENT`, red only once something has been typed and it is
still short, `aria-describedby` wired), and the "Passwords do not match" line
after the confirm box has been blurred. `autoComplete="new-password"` on both
password boxes. No submit button and no `<form>` — the caller owns those,
because setup's primary button lives in `SetupAssistant`'s footer and the
dialog's in `DialogFooter`.

`routes/setup.tsx` step 0 replaces its four `useState`s and inline inputs with
one `NewAccountValue` state and `<NewAccountFields>`; its Create Account
`disabled` becomes `busy || !newAccountComplete(account)`. Behaviour is
unchanged, and the existing setup tests are the proof.

### 3. The Add user dialog

New `apps/server/web/src/components/users/add-user-dialog.tsx`:

- `AddUserDialog({ open, onOpenChange, onCreated })`, the same shape as
  `AddNodeDialog`.
- Body: `<NewAccountFields idPrefix="new-user" autoFocus />` then a **Role**
  select (`USER_ROLES` from `types/user-role.ts`, default `user`, options
  labelled as the roster's badges spell them).
- Footer: **Cancel** and **Add user** — disabled until
  `newAccountComplete(value)`, pending label "Creating…".
- Submit: `POST /api/users` with `{ name, email, password, role }` via
  `apiFetch`. On success: clear the form, close, call `onCreated`. On failure:
  the server's message via `errMessage(err, "Couldn't create the user.")`
  rendered inside the dialog under the fields, `text-destructive text-sm`.
- The password is cleared on close and on unmount, like `UserRowActions`
  does — navigating away with the dialog open must not be the path that keeps
  it in state.

Title "Add user"; description "Creates a credential account that can sign in
immediately." (today's card copy, carried over).

### 4. The page: `/settings/users`

New `routes/settings_.users.tsx` (route id `/settings_/users`, like its
siblings). `routes/users.tsx` is **deleted**.

- Gate: `usePublicSettings().viewerIsAdmin`, the shape Status uses —
  `undefined` renders nothing, `false` renders the "for admins" sentence
  linking to Preferences and Account, `true` renders the page. The roster
  query (`["users"]`, `GET /api/users`) is `enabled` on `viewerIsAdmin ===
  true` so a member mount fires no request at all.
- `PageHeader` title "Users", subtitle "Who can sign in to this instance
  (admins)", `action` = `<Button>Add user</Button>` opening the dialog. The
  accessible name **"Add user"** is what e2e pins.
- One card, the roster table, columns **Name, Email, Role, Created, Manage**.
  Row rendering, the `manageable === false` "Service account" cell and
  `UserRowActions` move over verbatim. `onCreated` and `onChanged` both
  invalidate `["users"]`; `onCreated` also invalidates `["sharable-users"]`
  so an open sharing picker learns about the new person.
- Loading and load-failure states as today (the card's description says
  "Loading the roster…" / the connection sentence).

The rail entry becomes `{ to: "/settings/users", label: "Users", icon: Users, short: "Users" }`
in `NAV_ENTRIES`.

### 5. What else references `/users`

- `components/__tests__/sidebar-nav.test.ts` (`GROUP_PAGES`) and
  `app-sidebar-group.test.tsx` (its `paths` list): `/users` → `/settings/users`.
  The comment in `sidebar-nav.test.ts` about members reaching `/users` by URL
  is deleted with the route it describes.
- `routes/__tests__/users-page.test.tsx` → `settings-users.test.tsx`,
  rendering the new route at `/settings/users`. The non-admin case changes
  meaning: it now asserts the "for admins" sentence AND that `/api/users` was
  never fetched. Add: the header offers "Add user" to an admin; the system row
  gets no controls.
- New `components/users/__tests__/add-user-dialog.test.tsx`: submit disabled
  until complete; posts `{ name, email, password, role }`; a 409 message is
  shown and the dialog stays open; success closes and calls `onCreated`.
- New `components/account/__tests__/new-account-fields.test.tsx`:
  `newAccountComplete` edge cases (blank name, short password, mismatch,
  whitespace-only name); the requirement line is muted while empty and red
  once short text is typed; the mismatch line appears only after blur.
- e2e: `10-auth-experience.spec.ts` navigates to `/settings/users` (admin sees
  "Add user"; the member case now asserts the "for admins" sentence rather
  than a roster with no button); `08-mobile-shell.spec.ts` swaps `/users` for
  `/settings/users` in its path list.
- `apps/server/web/AGENTS.md`: the paragraph naming the six admin pages says
  `/settings/users`, and the clause about `/users` staying reachable by URL
  for members goes — the roster API is what the sharing picker reads, and
  that is unchanged. Note the shared account form there too, as the one
  place a new-account form comes from.
- `hooks/use-subshell-shares.ts`: `RosterUser` gains `name: string`; the
  picker's label stays the email (out of scope to change).

### 6. Out of scope

User deletion (deliberately absent per the 2026-09-05 spec), editing a name
after creation, showing names in the sharing picker, and any change to who
may read `GET /api/users`.

### 7. Changeset

One `@internal/server` **minor** changeset: the SPA ships embedded in the
server binary, and `POST /api/users` gained a field. Never a changeset for
`@internal/server-web` — it is ignored and wedges the version PR.

---

## Implementation tasks

Ordered so each is independently verifiable; 1 and 2 have no dependency on
each other, 3–5 depend on both.

1. **Server** (§1) — schema, handler, repository, tests; `turbo build`.
2. **Shared form** (§2) — `NewAccountFields` + tests; refactor setup step 0;
   setup tests green.
3. **Dialog** (§3) — `AddUserDialog` + tests.
4. **Page and move** (§4, §5) — new route, delete `/users`, rail entry, every
   test and e2e path, AGENTS.md.
5. **Verify** — `bun run verify-types`, `bun run lint:check`, `bun run test`,
   `bun run lint:design`; changeset.
