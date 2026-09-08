# Session Sharing & Notification Defaults

**Date:** 2026-08-31
**Status:** Approved design, pending implementation plan
**Scope:** backend (apps/backend), web (apps/frontend), mobile (apps/mobile), shared types

## 1. Problem & Goals

Two behavior changes on the session model:

1. **Notifications default on, as a per-user setting.** Today `sessions.notify` is a
   per-session "bell" that defaults **off**, and there is no user-level control. We
   want notifications enabled by default and governed by a per-user preference.
2. **Sessions are private by default and shareable.** Today sessions are strictly
   owner-only (`listByUser(userId)`; no visibility or sharing concept anywhere).
   Owners should be able to share a session with **view** or **view + edit**
   permissions, to either everyone on the instance or specific users.

Non-goals (YAGNI): no per-folder/team sharing, no expiry on grants, no
notification-per-grantee (pushes stay owner-targeted), no share-management UI in
the mobile app (mobile only *honors* the access level).

## 2. Decisions (ratified in brainstorming)

| # | Question | Decision |
|---|----------|----------|
| 1 | Sharing audience | **Both** everyone and specific users |
| 2 | Combine shape | **One share-list** per session; each entry is a user OR "Everyone", carrying view or view+edit. Empty list = private |
| 3 | What edit allows | **Interact + manage, not destroy** — see level table in §4 |
| 4 | Notify model | **Master switch + per-session bell** |
| 5 | Admin reach | **Admins see all**, at **edit** level (drive/restart/terminate; not delete/re-share/notify) |
| 6 | Backfill | **Default on for new sessions only** — existing session bells untouched |

## 3. Data model

### 3.1 `session_shares` (new table)

| column | type | notes |
|--------|------|-------|
| `id` | text PK | uuid |
| `session_id` | text NOT NULL | FK → sessions.id, `ON DELETE CASCADE` |
| `grantee_user_id` | text NULL | `NULL` = the **"Everyone"** entry (all signed-in users) |
| `permission` | text NOT NULL | `"view"` \| `"edit"` |
| `created_by` | text NOT NULL | owner user id who made the grant |
| `created_at` | text NOT NULL | ISO 8601 |

- Unique index on `(session_id, grantee_user_id)`. SQLite treats NULLs as distinct
  in unique indexes, so the "Everyone" row's uniqueness is enforced in the
  repository's replace-list write (delete-by-session then insert, in a transaction),
  not by the index alone.
- Row type: `apps/backend/src/db/types/session-shares.db-types.ts`.

### 3.2 `user_meta.notify_enabled` (new column)

`user_meta` gains `notify_enabled integer NOT NULL DEFAULT 1` — the per-user master
switch. Default 1 so every existing and new user starts opted-in (a user can turn it
off for total silence).

### 3.3 `sessions.notify` (semantics change, **no schema change**)

The column default stays `0` in the schema (avoiding a SQLite table rebuild). New
sessions get `notify = 1` because the **create path sets it explicitly**. Existing
rows are untouched (decision #6). The per-session bell UI now defaults on.

## 4. Access model

### 4.1 Levels

A viewer's effective access to a session, computed server-side:

`owner` > `edit` > `view` > `none`

| Capability | view | edit | owner |
|---|:--:|:--:|:--:|
| Appear in their list / summary | ✅ | ✅ | ✅ |
| Session detail, transcript/log | ✅ | ✅ | ✅ |
| Watch live terminal (read-only frames) | ✅ | ✅ | ✅ |
| **Send terminal input** (drive the agent) | — | ✅ | ✅ |
| Rename, edit notes | — | ✅ | ✅ |
| Restart, terminate | — | ✅ | ✅ |
| Delete session | — | — | ✅ |
| Change sharing | — | — | ✅ |
| Toggle this session's bell | — | — | ✅ |

### 4.2 Resolver (single source of truth)

`apps/backend/src/api/session-access.ts`:

```
resolveSessionAccess(viewerId, isAdmin, ownerUserId, shares): Access
  if viewerId === ownerUserId          -> "owner"
  if isAdmin                            -> "edit"      // supervisory, but can act
  levels = [
    shares.find(s => s.granteeUserId === null)?.permission,   // Everyone
    shares.find(s => s.granteeUserId === viewerId)?.permission, // specific
  ]
  return "edit" if levels includes "edit"
       : "view" if levels includes "view"
       : "none"
```

Used by **every** session route, the WS attach handler, and workspace pane-adding.
No route may re-implement ownership comparison inline — it calls this resolver.

### 4.3 Notifications gating

A push/event fires only when **both** hold for the session's owner:
- the owner's `user_meta.notify_enabled === 1` (master switch), AND
- that session's `sessions.notify === 1` (bell).

Master off ⇒ total silence regardless of bells. Bells only narrow within an
opted-in user. This check lives at the single notify-send site so both transports
honor it.

## 5. Backend plumbing

- **`SessionSharesRepository`** — `listForSession(sessionId)`, `replaceForSession(sessionId, entries, actorUserId)` (transactional delete+insert), `deleteForSession` (also via FK cascade). A `mapForSessions(ids)` batch read for the list route.
- **Route guards** — a `requireSessionAccess(db, viewer, isAdmin, sessionId, minLevel)` helper resolves the row + shares and throws **404 `not_found`** when the session is invisible to the viewer (access `none` — never reveal existence, matching the existing foreign-session behavior) and **403** when it is visible but below `minLevel`. Each route maps to a required level per §4.1:
  - read (get, log, detail) → `view`
  - rename, notes, restart, terminate → `edit`
  - delete, shares GET/PUT, update-notify → `owner`
- **List & summary** — `SessionsRepository.listVisibleTo(viewerId, isAdmin)` = own ∪ (rows with an Everyone share or a share naming the viewer) ∪ (admin: all). Each returned session is annotated with its viewer-relative `access`. `countsByUser` uses the same visibility set.
- **WS attach (`apps/ws`)** — at attach, load the session + shares + viewer role, `resolveSessionAccess`; require `≥ view` else close `4004`. Set `canInput = access ∈ {edit, owner}` on the connection; drop input frames when `!canInput` (frame *writes to the client* are allowed at view). Access is resolved fresh at attach (no grant staleness beyond a connection's life).
- **Workspace pane-adding** — the existing "pane may only reference the caller's own session" check relaxes to `access ≥ view`; typing into that pane still goes through the WS `canInput` rule.
- **Session-key (MCP) actor** — unchanged. A session's own token still acts as its owner; sharing is a human/browser concern only.

## 6. API surface (new/changed Eden routes)

- `GET  /api/sessions/:id/shares` (owner) → `{ shares: [{ id, granteeUserId|null, granteeName|null, permission }] }`
- `PUT  /api/sessions/:id/shares` (owner) body `{ shares: [{ granteeUserId?: string|null, permission: "view"|"edit" }] }` → replaces the list; validates each grantee exists (400 otherwise); returns the saved list.
- `GET  /api/notifications/settings` (cookie) → `{ notifyEnabled: boolean }`
- `PATCH /api/notifications/settings` (cookie) body `{ notifyEnabled: boolean }` → persists the caller's master switch. (Lives with the existing per-user push-subscription route.)
- Grantee picker reuses the existing signed-in-readable user roster.
- **`SessionModelSchema`** gains `access: "owner"|"edit"|"view"` (viewer-relative). Mirrored in `apps/frontend/src/types/session.ts` and the mobile session type. The `PUT/GET shares` routes are additive; `@internal/backend-client` types re-infer from the backend `App`.

## 7. UI

### 7.1 Web (`apps/frontend`)
- **Settings**: a notifications master toggle bound to `/api/notifications/settings`.
- **New-session form**: bell toggle defaults **on** (`notify: 1`).
- **Session list/detail** gate purely on `access`:
  - `view` → terminal read-only (input disabled); hide rename/notes/restart/terminate/delete/share/bell.
  - `edit` → show input + rename/notes/restart/terminate; hide delete/share/bell.
  - `owner` → everything, incl. the **Sharing** dialog.
- **Sharing dialog** (owner only): list current grants (Everyone row + user rows) each with a view/edit selector and remove; add-a-grant control (Everyone or pick a user from the roster, choose level). Mirrors "one share-list".
- Shared sessions the user doesn't own appear in the list with an access badge / shared marker.

### 7.2 Mobile (`apps/mobile`)
- Read `access` on the session; viewer = read-only terminal + no action buttons; editor = the action bar minus delete/share/bell. Share *management* is not built here (owner uses web).

## 8. Migration

New file `apps/backend/src/db/migrations/0016-session-sharing.ts` (next free number
— highest today is `0015`), registered in the
static provider map in `apps/backend/src/db/migrate.ts` (file name == map key):
- `createTable("session_shares")` per §3.1 + unique index.
- `alterTable("user_meta").addColumn("notify_enabled", "integer", notNull default 1)`.
- **No change** to `sessions`.

`down()` drops the table and the column.

## 9. Tests

- **Resolver** (`session-access` unit): owner / admin→edit / Everyone only / user only / both→edit wins / view-only / none.
- **Repository**: `listVisibleTo` shows own, shows shared-by-user, shows shared-by-everyone, hides private from a non-grantee; admin sees all; shares `replaceForSession` round-trips incl. an Everyone row and cascades on session delete.
- **Route × access matrix**: `get` 200 at view, 404/403 at none; `rename`/`terminate` 403 at view / 200 at edit; `delete` 403 at edit / 200 owner; `PUT shares` 403 for non-owner.
- **WS**: attach succeeds at view; input frame ignored at view; input honored at edit/owner.
- **Notify**: master off suppresses even when bell on; bell off suppresses; both on → send. New session row has `notify = 1`; a pre-existing row keeps its value.
- **Migration**: `user_meta.notify_enabled` exists default 1; `session_shares` exists.
- **backend-client**: typechecks against the new `App`.
- **e2e**: owner shares to a second user at `view` and separately at `edit`; the second user's list/detail reflects the level (read-only vs can-rename), and a never-shared session stays invisible to them.

## 10. Docs

Update `.claude/rules/security-context.md`: sessions are now owner-private by
default and shareable (Everyone/user, view/edit); admins have instance-wide edit;
terminal input is gated at edit; notifications are owner-targeted behind a per-user
master switch. Note this widens exposure beyond the owner on a trusted network.

## 11. Phasing (for the implementation plan)

1. **Notifications** — `user_meta.notify_enabled`, master-switch read at the send
   site, `notify: 1` on create, `/api/notifications/settings`, Settings toggle.
   Isolated, ships first.
2. **Sharing core** — `session_shares` table + repository, the resolver, per-route
   `requireSessionAccess`, list/summary visibility, `access` on the session schema.
3. **Realtime & panes** — WS attach/input by access, workspace pane-access.
4. **Web UI** — sharing dialog, access-driven controls, bell default.
5. **Mobile parity** — honor `access`.
6. **Docs + tests** throughout.

Each phase leaves the tree green (`verify-types`, `lint:check`, `test`, and the
touched e2e specs).

## 12. Edge cases & risks

- **Delete** a shared session → shares cascade; grantees simply lose it from their list.
- **Terminating/restarting** by a grantee triggers the **owner's** notify path (correct — pushes are owner-targeted).
- **Everyone + specific**: grantee with both an Everyone(view) and a specific(edit) row gets edit (highest wins).
- **Revoking** sharing takes effect at the *next* access check / new WS connection; an already-open read-only WS stays open until it closes (accepted for a trusted network).
- **Grantee picker data**: relies on the roster being readable by all signed-in users (verified present).
- **Cache keys**: `listVisibleTo`/detail responses are per-viewer; any client query cache must key by the viewer (single-user-per-browser already so in practice fine).
