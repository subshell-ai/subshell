# Sessions → Subshells rename, Clone action, and Profiles icon

**Date:** 2026-09-02
**Status:** Approved design, pre-implementation

## Summary

Three related changes to the product vocabulary and the session actions menu:

1. **Rename the product entity** from "session" to "subshell" — user-facing copy,
   code identifiers, REST routes, the frontend route, the WS attach param, DB
   tables/columns, the shared protocol package, and the harness env vars.
2. **Add a "Clone…" action** to the per-entity overflow menu that launches a fresh
   subshell from the source's node + profile + working directory, with an optional
   name as the only input.
3. **Give the Profiles nav item its own icon** (`SlidersHorizontal`) so it no longer
   shares the `Settings` gear with the Server (settings) item.

The operator is the sole user; **no backward-compatibility layer** is built. This is
a clean cut applied at deploy time (see Rollout).

## 1. The Sessions → Subshells concept rename

### 1.1 Boundary rule — what renames, what does not

Rename *the product entity*: "a running agent harness" (today a "session"). This
covers UI copy, code identifiers, types, file names, route paths, wire frames, and
DB schema.

**Keep the word "session"** wherever it means one of three foreign things that a
product rename does not touch:

- **better-auth session cookie** — the human's authenticated login session
  (e.g. "sign out of my session"). Stays `session`.
- **tmux session** — tmux's own term for the underlying pty session the backend
  drives. Internal tmux plumbing keeps `session`.
- **WebSocket session** — generic socket/plumbing vocabulary. Stays `session`.

The judgement test: if a sentence about "my login" or "the tmux session" still makes
sense after the product is called Subshell, that identifier does not rename. The
implementation is a **curated concept-rename** driven by this rule, verified
per-package with `verify-types`, **not** a blind find-replace. A blind sweep of the
~6,600 `session` occurrences would mis-rename auth-cookie and tmux internals and is
explicitly rejected.

### 1.2 Wire and storage renames (clean cut, no aliases)

| Surface | Before | After |
|---|---|---|
| REST collection | `/api/sessions/:id/...` | `/api/subshells/:id/...` |
| Frontend route | `/sessions/$id` | `/subshells/$id` |
| WS attach query param | `/ws?session=<id>` | `/ws?subshell=<id>` (path `/ws` unchanged; frontend builds this at `use-session-ws.ts:100`, backend parses via `attachUrlFromQuery`) |
| DB tables | `sessions`, `session_shares` | `subshells`, `subshell_shares` |
| DB FK columns | `session_id` (on `session_shares`, `workspace_panes`, and any other referencing table) | `subshell_id` |
| TS types | `SessionView`, `CreateSessionInput`, … | `SubshellView`, `CreateSubshellInput`, … |
| Frontend files/hooks | `session-card.tsx`, `use-sessions.ts`, `session-actions-menu.tsx`, `lib/session-*` | `subshell-*` equivalents |
| Backend dirs/modules | `api/sessions/`, `ws/session-ws.ts`, session repositories/services | `api/subshells/`, `ws/subshell-ws.ts`, … (except tmux-plumbing names per §1.1) |
| Shared package | `@internal/session-protocol` (`packages/session-protocol`) | `@internal/subshell-protocol` (`packages/subshell-protocol`) |
| Harness env vars | `SUBSHELL_SESSION_ID`, `SUBSHELL_SESSION_NAME` | `SUBSHELL_ID`, `SUBSHELL_NAME` |
| Backend data-dir env | `SESSION_DATA_DIR` | `SUBSHELL_SERVER_DATA_DIR` — chosen to avoid collision with the agent's existing `SUBSHELL_DATA_DIR` |
| API-key scope tokens | — none exist: keys carry a free-form optional permission array, there is no `sessions:*` wire token | nothing to rename (plan-phase correction) |

`SUBSHELL_NODE_ARTIFACTS_DIR`, `SUBSHELL_API_KEY`, `SUBSHELL_BASE_URL`, `SUBSHELL_DATA_DIR`
(agent's own dir) are unchanged.

### 1.3 Database migration

One new migration in `apps/backend/src/db/migrations/`, registered under the matching
key in the static provider map in `apps/backend/src/db/migrate.ts` (AGENTS.md: the
boot migrator reads the static map, not the folder).

It applies:

- `ALTER TABLE sessions RENAME TO subshells;` and `ALTER TABLE session_shares RENAME
  TO subshell_shares;` — SQLite rewrites `REFERENCES` clauses on rename.
- `ALTER TABLE ... RENAME COLUMN session_id TO subshell_id;` on every referencing
  table (SQL is snake_case — `session_shares`, `workspace_panes`, …; the Kysely
  interfaces' camelCase `sessionId` fields follow to `subshellId`).
- `sessions.harness_session_id` **stays** — it holds the harness's own session id
  (a foreign sense per §1.1), not a reference to the entity.
- `harness_session_id` stays untouched (foreign sense, §1.1).
- No API-key permission rewrite — planning verified that keys carry free-form
  optional permission arrays; no `sessions`-named scope exists on the wire or in
  stored JSON (this supersedes the earlier draft assumption).

The Kysely type file `db/types/sessions.db-types.ts` → `subshells.db-types.ts` and its
`session-shares` sibling follow the table rename; `session-status.ts` (a status enum,
not the entity) is reviewed against §1.1 and renamed only if it names the entity.

### 1.4 E2E and docs

- Update the pinned strings/selectors in `e2e/tests/01-setup-wizard.spec.ts`
  (`heading "Sessions"`), `e2e/tests/05-workspaces.spec.ts` and
  `e2e/tests/08-mobile-shell.spec.ts` (button `"New session"` → `"New subshell"`).
- Update `apps/frontend/AGENTS.md`, `apps/agent/AGENTS.md`, and root `AGENTS.md`
  where they name the entity/routes/env vars; the security-context rule doc's
  "session sharing" section is updated to "subshell sharing" for the product sense
  while keeping its tmux/auth senses intact.
- Historical specs under `docs/` are dated records and are **not** rewritten.

## 2. The "Clone…" action

### 2.1 Menu item

In `subshell-actions-menu.tsx` (renamed from `session-actions-menu.tsx`), add a
**"Clone…"** item inside the `canEdit` group (visible to `edit` and `owner`; viewers
already receive no menu). Place it adjacent to the Terminate / Start-again pair,
since both are launch actions. Icon: `Copy` from lucide.

### 2.2 Dialog

Selecting Clone opens a new `CloneSubshellDialog`:

- Three **read-only** rows showing exactly what is copied: **Node**, **Profile**,
  **Working directory** (values read off the source `SubshellView`).
- One **editable Name (optional)** field: `maxLength={NAME_MAX_DEFAULT}`, placeholder
  "Defaults to date/time". This is the only input.
- One primary action: **Launch clone**.

### 2.3 Launch semantics

Submit calls the renamed `useCreateSubshell` with
`{ profileId, workingDir, nodeId, name }` taken directly from the source
`SubshellView`. **No new backend endpoint** — the existing `POST /api/subshells`
(renamed from `/api/sessions`) runs its normal server-side checks under the **caller's**
credentials. Consequences:

- The clone is a brand-new subshell **owned by the caller**, never by the source's
  owner. Sharing grants on the source are **not** copied.
- Because it goes through the caller's own create path, cloning only works if the
  caller can launch that profile on that node — the same rule as any fresh launch.

On success, **navigate to the new subshell's page** (`/subshells/$id`), mirroring the
`/new` page's post-create behavior.

### 2.4 Error handling

Server-side rejections (profile not launchable by the caller, node offline, harness
disabled, …) surface **inside the dialog** through the existing
`lib/create-session-error.ts` mapping (renamed `create-subshell-error.ts`), the same
copy the `/new` page shows. The dialog stays open on error so the name can be retried;
it closes and navigates only on success.

## 3. Profiles icon

`app-sidebar.tsx` `NAV_ITEMS`: Profiles changes from `Settings` to
`SlidersHorizontal`; the Server item keeps `Settings`. `SlidersHorizontal` is chosen
for internal consistency — the actions menu already uses it for the "Edit profile
…" item, so sliders now consistently mean "profile".

During implementation, audit the other places a profile is represented (page headers,
profile cards, mobile nav) and align any that currently borrow the gear icon.

## 4. Testing

- **Clone mapping (pure):** source `SubshellView` → create body produces the exact
  `{ profileId, workingDir, nodeId, name }` with a blank name omitted (reuse
  `toSubshellCreateBody` behavior).
- **Clone dialog (component):** renders the three read-only rows from a fixture
  subshell; posts the correct body on submit with the typed name; a failing POST
  keeps the dialog open with the mapped error.
- **Icon:** extend the existing sidebar nav test to assert Profiles → 
  `SlidersHorizontal` and Server → `Settings` remain distinct.
- **Rename regression:** the full `bun run test` suite plus per-package
  `verify-types`; e2e specs updated to the new strings and run for the touched files.

## 5. Verification (all three, per `.claude/rules/verification.md`)

```bash
bun run verify-types
bun run lint:check
bun run test
bun run test:e2e   # for the touched e2e specs (real tmux available)
```

Boot the migrated dev DB once to confirm the rename migration runs clean and existing
rows/keys survive.

## 6. Rollout (one-time, appended to the existing rollout doc)

This is a breaking deploy; order matters:

1. `bunx turbo build` then `bun run release:agent` — rebuild/publish node binaries,
   which now bake `SUBSHELL_ID` / `SUBSHELL_NAME`.
2. Update the backend service unit's `EnvironmentFile`: `SESSION_DATA_DIR` →
   `SUBSHELL_SERVER_DATA_DIR`, and point it at the renamed data directory.
3. Restart the backend; the DB rename migration runs on boot.
4. Re-run the enroll/update one-liner on each enrolled node so its agent binary picks
   up the new env var names.
5. Rebuild/redeploy the mobile app (it calls the renamed REST paths).

## 7. Out of scope

- Any backward-compat shim, alias route, or dual-read env fallback (operator alone,
  explicitly waived).
- Rewriting historical specs/design docs under `docs/`.
- Renaming tmux-session and auth-session vocabulary (§1.1).

## 8. Suggested commit phasing

To keep the giant diff reviewable, the implementation lands as independent,
individually-green commits in roughly this order:

1. Clone action + Profiles icon (small, self-contained, on today's vocabulary).
2. `@internal/session-protocol` → `subshell-protocol` package rename (touches imports
   everywhere at once, but mechanically).
3. Backend: routes, services, repositories, DB migration, env vars, scopes.
4. Frontend + mobile: routes, types, files, copy.
5. Agent/harness env-var consumers + e2e string updates + AGENTS.md/docs.
6. Rollout-doc addendum (§6).

(Steps 3–5 are one wire-cut in reality — merged commits may be squashed together if
intermediate states cannot typecheck green.)

## Amendment (2026-09-02, final review)

The "plan-phase correction" is wrong: the §1.2 table row and the §1.3 bullet that
claim **no API-key permission rewrite is needed** were disproven at final review.
Session-scoped keys do carry a rewriteable shape — `{kind:"session",sessionId}`
metadata (the discriminator auth-guard reads) and a `sessions` permission key in the
stored optional permission array (`requirePerm`'s vocabulary). Migration 0019
therefore **does** rewrite both: metadata `{kind,sessionId}` → `{kind,subshellId}`
and permission key `sessions` → `subshells`, with a matching downgrade path —
see `apps/backend/src/db/migrations/0019-subshell-rename.ts` and its test
`apps/backend/src/db/migrations/__tests__/0019-subshell-rename.test.ts`, which
roundtrip-tests the rewrite (`down()` reverses it, `up()` re-applies it) alongside
the untouched system/node-kind rows. The rewrite is required and implemented; the
earlier text above is left in place as the historical record of the (incorrect)
planning conclusion.

Second amendment (post-merge code review): §2.1's `canEdit` placement for "Clone…"
is superseded — profiles are strictly per-user, so an `edit` grantee's clone can
never launch (guaranteed 404). The item is owner-only in
`subshell-actions-menu.tsx`; the edit grantee's menu omits it entirely.
