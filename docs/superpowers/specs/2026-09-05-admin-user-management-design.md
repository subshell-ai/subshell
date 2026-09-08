# Admin user management — design

**Date:** 2026-09-05
**Status:** draft, pending implementation

## Problem

An admin can create users (`POST /api/users`, already shipped) and read the
roster (`GET /api/users`), but nothing else. There is no way to:

- change another user's **role** (admin ↔ user),
- **reset another user's password** — the only recovery path today is
  `SUBSHELL_EMERGENCY_PASSWORD`, which is destructive by design, instance-wide,
  and warns every signed-in user while it is armed.

Both are ordinary operator needs on a multi-user instance.

## Scope

In: role assignment, admin password reset, and surfacing both in the existing
`/users` page beside the create form that is already there.

Out: **deleting users** (not asked for, and it orphans subshells, shares,
channels and audit rows — its own design), self-service email change, and any
change to the self-service password flow (`account.tsx` → better-auth's
`changePassword`, which correctly requires the current password).

## What already exists

| Piece | Where |
|---|---|
| `POST /api/users` (create, admin-only, audited `user.create`) | `api/users.route.ts` |
| `GET /api/users` (roster + `viewerIsAdmin`) | same |
| `requireAdmin` — cookie-only, rejects every bearer key with 403 | `api/auth-guard.ts` |
| Credential storage: `account.password`, `providerId = "credential"` | `users.repository.ts:createUser` |
| Role storage: `user_meta.role` | `user-meta.repository.ts` |
| `/users` page with the create form | `routes/users.tsx` |

So this is two new endpoints, two repository methods, and UI — not new
infrastructure.

## Endpoints

Both mount on the existing `adminOnly` sub-instance, so they inherit
`requireAdmin` (cookie-only, 401 anonymous / 403 bearer-or-non-admin) with no
new gate to keep in sync.

### `PATCH /api/users/:id/role` `{ role: "admin" | "user" }`

Audited `user.role_change` with `{ email, from, to }`.

### `PATCH /api/users/:id/password` `{ password: string }` (min 8)

Writes `account.password` for the credential account, and **revokes every
session that user holds** (`DELETE FROM session WHERE userId = ?`). Audited
`user.password_reset` with `{ email, sessionsRevoked }` — never the password,
in any form.

Session revocation is not optional. An admin resetting a password is usually
responding to "this account may be compromised"; leaving the existing sessions
alive means the reset changes nothing for an attacker already holding a cookie.

## The guards that matter

These are the parts worth getting right; the CRUD around them is mechanical.

**1. Last-admin lockout.** Demoting the final admin leaves an instance nobody
can administer — no role changes, no user creation, no system keys, no
settings. Recovery would mean `SUBSHELL_EMERGENCY_PASSWORD` and a restart.
Refuse the demotion with 409 and a message naming the reason. The count and
the write happen in ONE transaction: two admins demoting each other
concurrently must not both read "2 admins" and both succeed.

**2. Self-demotion is allowed, but only through guard 1.** An admin stepping
down while other admins exist is legitimate. Blocking it outright would be
simpler but wrong — it forces a second admin to do a trivial thing.

**3. The `system` service user is not editable.** It owns system API keys and
has no credential account to reset; a role change on it is meaningless and a
password write would create a credential row that should not exist. Both
endpoints 403 on it, matched by id resolved from `SYSTEM_USER_EMAIL`.

**4. A user with no credential account** (should not happen today — every user
is created with one — but the schema permits it) gets a 409 on password reset
rather than silently inserting a row. Inventing a credential for an account
that had none is a different operation from resetting one, and doing it by
accident would be a way to gain a password login on an account that
deliberately had no password.

**5. No self-password-reset shortcut.** An admin changing their OWN password
goes through `account.tsx` / better-auth, which requires the current password.
Allowing the admin endpoint to target self would turn "I left my laptop
unlocked" into a full credential takeover with no knowledge of the existing
password. 400 on self, pointing at Account.

## Storage

Two repository methods, both raw `sql` for the better-auth tables (the same
dialect-spelling reason `createUser` and `listWithRoles` already have):

```ts
UsersRepository.setPassword(userId, passwordHash): Promise<{ sessionsRevoked: number }>
UserMetaRepository.setRole(userId, role): Promise<void>   // upsert — a row may not exist
```

`setRole` must UPSERT: `listWithRoles` returns `role: null` for a user with no
`user_meta` row, so that state is reachable and a bare UPDATE would silently
no-op.

## UI

`routes/users.tsx` gains, per row and only when `viewerIsAdmin`:

- a role `<Select>` (Admin / User), disabled on self when self is the last
  admin and on the `system` row;
- a "Reset password" action opening a dialog that states plainly that the
  user's sessions will be signed out, and shows the typed password once —
  there is no email delivery here, so the admin must be able to read what they
  set in order to communicate it.

The roster query is invalidated after either mutation.

## Testing

- Route: role change happy path; last-admin demotion refused (409); the
  refusal holds under two concurrent demotions; self-demotion allowed with a
  second admin present; `system` refused; bearer refused (403); non-admin
  refused (403); anonymous refused (401).
- Password: sets a hash that `verifyPassword` accepts; revokes sessions and
  reports the count; self refused (400); a user with no credential account
  refused (409); the response body and audit metadata contain no password.
- Repository: `setRole` upserts over a missing `user_meta` row.
- Frontend: controls render only for `viewerIsAdmin`; the dialog states the
  sign-out consequence.

## Security notes for `docs/security.md`

- Admin password reset is a **credential takeover primitive**, deliberately:
  an admin can already mint system keys and read every subshell, so this
  grants no new reach — but it is now a one-click action and is audited as
  such. §11's "admins are unconstrained operators" gains this example.
- Sessions are revoked on reset; a reset therefore *does* evict an attacker.
- The last-admin guard is what stands between a misclick and an instance that
  needs `SUBSHELL_EMERGENCY_PASSWORD` to recover.
