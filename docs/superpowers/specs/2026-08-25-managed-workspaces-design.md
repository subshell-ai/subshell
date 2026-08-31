# Managed Workspaces — Design Spec (2026-08-25)

**Deployment model:** local-first (bare-metal) + single-container Docker. Today a session's `workspacePath` is a freeform absolute directory string the user types into the new-session form (or picks via the Browse folder picker). There is **no first-class "workspace" entity**: no name, no label, no read-write flag, and no registry of the directories a Mote operator cares about. This round turns workspaces into a managed, install-wide resource.

**Goal:** let an operator register named directories as **workspaces** (each with a path, optional description, and an rw/ro access marker), pick them by name in the new-session form, and — under Docker — mount multiple host directories into the container read-write, aligned to the host uid so dragged-in code is owned by the operator.

**Out of scope (deferred):**
- Session↔workspace foreign key / workspace snapshots / per-session branch pinning.
- Hard read-only enforcement via the DB `access` flag (see "Access is advisory" below) — enforcement is the host mount.
- Workspace templates, git-branch awareness, "workspace used by N sessions" analytics.

---

## Core architectural decision: workspaces are a registry, sessions keep raw paths

Today a session always carries its `workspacePath` (a string) and `restart` reuses the original path. This round **keeps that model**: sessions stay keyed by `workspacePath`, and a "workspace" is a *named alias* on top — a `workspaces` table the operator edits, and a dropdown in the new-session form that fills `workspacePath` from a workspace's `path`.

- **No FK from sessions → workspaces.** A session is launch-time-frozen at its path, so renaming/deleting a workspace never breaks historical sessions. This matches the existing `restart` behavior (which reuses the original `workspacePath`).
- **Global scope.** Workspaces are install-wide (like the `settings` table), **not** per-user (unlike `profiles`/`recent_paths`). Any authenticated user can *list* them (needed for the session form); only **admins** mutate (create/update/delete), since a workspace is a shared machine-level resource the harness runs against.

### Access is advisory, not enforcement

Each workspace stores an `access` (`"rw" | "ro"`) marker. This is **metadata/UX**, not a sandbox: nothing in `session-manager.service.ts` gates writes on it. Read-only enforcement is a *deployment* concern — the operator mounts a host directory `:ro` in compose, or accepts that `ro` is a signal. This is stated explicitly so the implementation doesn't over-build a permission layer.

---

## Backend

### 1a. Migration `0005-workspaces.ts` (`apps/backend/src/db/migrations/`)

New `workspaces` table:

| column | type | notes |
|---|---|---|
| `id` | text PK | `crypto.randomUUID()` |
| `name` | text | friendly label, 1..120, unique |
| `path` | text | absolute directory, unique, must exist when created |
| `description` | text null | 0..500 |
| `access` | text | `"rw"` \| `"ro"`, default `"rw"` |
| `created_at` / `updated_at` | text | `strftime('%Y-%m-%dT%H:%M:%fZ','now')` defaults (same as profiles) |

Indexes: `idx_workspaces_name` (unique), `idx_workspaces_path` (unique). `down()` drops the table. Registered in the provider map in `apps/backend/src/db/migrate.ts` (key `"0005-workspaces"`).

### 1b. DB types (`apps/backend/src/db/types/workspaces.db-types.ts`)

Mirror `profiles.db-types.ts`: `WorkspaceTable` (raw row), `NewWorkspace` (omits `createdAt`/`updatedAt`), `WorkspaceUpdate = Partial<Omit<NewWorkspace, "id">>`. `access` typed as `"rw" | "ro"` union. Register in the `Database` interface at `apps/backend/src/db/types/index.ts` (`workspaces: WorkspaceTable`).

### 1c. Repository (`apps/backend/src/db/repositories/workspaces.repository.ts`)

`WorkspacesRepository extends BaseRepository`:
- `create(NewWorkspace): Promise<WorkspaceTable>` — stamps `createdAt`/`updatedAt`, `returningAll().executeTakeFirstOrThrow()`.
- `findById(id)`.
- `list(): Promise<WorkspaceTable[]>` — **no user filter** (global), ordered `name asc`.
- `update(id, WorkspaceUpdate)`, `delete(id)` — mirror profiles (`updatedAt` via `sql\`(datetime('now'))\``).

### 1d. Route (`apps/backend/src/api/workspaces.route.ts`)

`new Elysia({ prefix: "/api/workspaces" })`, **`.use(requireAdmin)` on the mutation routes** and **`.use(authGuard)` on the list route**. `requireAdmin` composes `authGuard` internally and injects `{ role }`; non-admins get a 403, anonymous a 401 (existing `auth-guard.ts`).

Schemas (`api/models.ts` + route-local): `CreateWorkspaceBodySchema` = `{ name (1..120), path (minLength 1), description? (max 500), access? ("rw"/"ro") }`; `WorkspaceSchema` = id, name, path, description|null, access, createdAt, updatedAt.

| Endpoint | Guard | operationId | Notes |
|---|---|---|---|
| `POST /` | `requireAdmin` | `createWorkspace` | validations → 400/409; 201-ish `WorkspaceSchema` |
| `GET /` | `authGuard` | `listWorkspaces` | `WorkspaceSchema[]` |
| `PUT /:id` | `requireAdmin` | `updateWorkspace` | body `t.Partial(CreateWorkspaceBodySchema)`; 404 if missing |
| `DELETE /:id` | `requireAdmin` | `deleteWorkspace` | `{ ok: true }`; 404 if missing |

**Validation** (reuses `validateWorkspacePath` from `session-manager.service.ts`):
- `path` must exist on the container FS and be a directory → else **400**.
- `name`/`path` uniqueness → **409** (`EXISTS_ERROR`-style).
- Unknown `:id` → **404** (`NOT_FOUND_ERROR`-style).

**Error handling:** define `WorkspacesError extends Error` with a **`readonly status`** field (400 / 404 / 409). This deliberately fixes the `ProfileError` quirk, which omits `status` and therefore surfaces as a **500** today. Matching the sibling-route private-class idiom (not `@internal/backend-errors`, which no route uses).

Wire into `apps/backend/src/api/routes.ts`: `new Elysia().use(workspaceRoutes)`.

---

## Frontend

### 2a. Hook + types
- `apps/frontend/src/types/workspace.ts` → `WorkspaceRow` (id, name, path, description|null, access, createdAt, updatedAt) — client subset, mirrors `ProfileRow`.
- `apps/frontend/src/hooks/use-workspaces.ts` → `useWorkspaces()` → `useQuery({ queryKey: ["workspaces"], queryFn: () => apiFetch<WorkspaceRow[]>("/api/workspaces") })`. Single query key `["workspaces"]`; mutations invalidate it.

### 2b. Manage page (`/workspaces` → `routes/workspaces.tsx`)
Mirror `profiles.tsx`:
- Create form inline (Name, Path, Description, Access switch) → `POST /api/workspaces`, then `invalidateQueries(["workspaces"])`.
- Card grid of workspaces (name, path, description, access badge).
- Delete with `confirm()` → `DELETE /api/workspaces/${id}`.
- **No client-side admin gating** (matching `/settings` and `/users`, which rely on the API returning 403): the manage page is list-first and any non-admin who attempts create/update/delete gets an inline error from the 403. This is consistent with how the app already treats admin-only pages. (Gating controls by role would need the client to know the acting user's `role`, which `getSessionUser()` does not expose today — deliberately out of scope; see Open questions.)

### 2c. Shared fields (`components/workspace-fields.tsx`) + form logic (`lib/workspace-form.ts`)
Mirror `profile-fields.tsx` / `profile-form.ts`: a fully-controlled `WorkspaceFields({ value, onChange })` — Name, Path, Description, Access — reused by create + edit. Pure helpers: `emptyWorkspaceForm()`, `toWorkspaceForm(row)`, `toCreatePayload()`.

### 2d. Edit page (`/workspaces/$id` → `routes/workspaces_.$id.tsx`)
Mirror `profiles_.$id.tsx`: `useParams({ from: "/workspaces_/$id" })`, find the row in the `["workspaces"]` list, `WorkspaceEditor` keyed by `workspace.id`, `useMutation` → `PUT /api/workspaces/${id}`, on success invalidate + navigate `/workspaces`.

### 2e. New-session form (`routes/new.tsx`)
- Load `useWorkspaces()`.
- Add a **Workspace dropdown** (Radix Select) above the existing freeform path input. Picking a workspace sets `workspacePath = workspace.path` (and clears the freeform field). Keep **freeform + Browse** as-is for custom/ad-hoc paths.

### 2f. Nav (`components/app-sidebar.tsx`)
`NAV_ITEMS` gains `{ to: "/workspaces", label: "Workspaces", icon: FolderOpen }`.

---

## Docker compose

`docker-compose.yaml`:

```yaml
services:
  mote:
    # Run as the host user so files the harness writes are owned by the operator.
    user: ${UID:-1000}:${GID:-1000}
    volumes:
      - mote-data:/data
      # Read-write host workspace mount(s). Add one host:dir:container-path:rw per dir.
      - ${PROJECTS_DIR:-~/projects}:/workspace:rw
      - ${WORK_ITEMS_DIR:-~/work-items}:/work-items:rw
      - ${CLAUDE_BIN:-/home/theo/.local/bin/claude}:/usr/local/bin/claude:ro
      - ${HOME:-$HOME}/.claude:/home/mote/.claude:ro
      - ${HOME:-$HOME}/.config/claude:/home/mote/.config/claude:ro
```

- **`user:`** — container processes run as the host uid/gid, so dragged-in code the agent edits is owned by the operator.
- **Two host dirs, two mount lines** — `~/projects` appears at `/workspace`, `~/work-items` at `/work-items`. Each is independent; register each at its own *container* path (the paths below).

### Pathing in Docker (all paths are container-relative)

Mote (API + tmux + the harness binary) runs **inside** the container, so every path it sees, validates, and stores is a **container** path. There is **no host↔container translation** anywhere in Mote — the browser talks only to the API in the container.

```
Host                       Container (what Mote sees / stores)
─────────────────────────────────────────────────────────────
~/projects/…               /workspace
~/work-items/…             /work-items
```

In the Manage UI you register workspaces with **container** paths:

| Name | `path` (what the user types / the picker stores) |
|---|---|
| `Projects` | `/workspace` (or `/workspace/<subdir>`) |
| `Work items` | `/work-items` (or `/work-items/<thing>`) |

Registration → **session**:
1. Register `path = /workspace` → `validateWorkspacePath` (`session-manager.service.ts:431`) runs inside the container, `existsSync("/workspace")` is true, stores `/workspace`.
2. New-session dropdown fills `workspacePath = /workspace` → tmux `new-session -c /workspace` launches claude with `cwd = /workspace`.
3. Agent writes land in `/workspace` → backed by host `~/projects`, owned by the container's effective uid (your uid via `user:`).

**Consequences to live by:**
- **Type container paths, never host paths.** Registering `/home/theo/projects/...` fails `validateWorkspacePath` because that path doesn't exist in the container.
- **The Browse picker shows container paths** — rooted at `["/", $HOME, $MOTE_FS_ROOT]` (`files.route.ts:119`); from `/` you'll see `/workspace` and `/work-items` as sibling dirs and can navigate either. Picking naturally stores the container path.
- **Multiple scatter** = one mount line per host dir. Names can't collide; each host dir is a distinct container path.
- **Nesting footgun:** mounting `~/projects:/workspace` **and** `~/other:/workspace/sub` is allowed, but don't also bind something at bare `/workspace` *and* use `/workspace/sub` — a top-level mount covers/obscures nested mounts. Side-by-side mount points (`/workspace`, `/work-items`) are the robust default.

Bare-metal (non-Docker) is unaffected: workspaces are just paths that exist on the host.

---

## Testing

- **Repo test** `apps/backend/src/db/repositories/__tests__/workspaces-repository.test.ts`: create/list/update/delete; ordered `name asc`; unique name + unique path (in-memory Kysely, migrations 0001-0005, `beforeEach` wipe — mirror `repositories.test.ts`).
- **Migration test** `apps/backend/src/db/migrations/__tests__/0005-workspaces.test.ts`: temp DB, run `up`, assert columns + indexes (mirror `0002-operator-ux.test.ts`).
- **Route test** `apps/backend/src/api/__tests__/workspaces-admin.test.ts` (mirror `users-admin.test.ts`): admin can `POST`/`PUT`/`DELETE` (and non-admin `GET` lists); **non-admin mutating → 403**; anonymous → 401; duplicate name → 409; missing id → 404.
- **Frontend test** `apps/frontend/src/lib/__tests__/workspace-form.test.ts`: pure helpers only (round-trip, `access` union validation) — matches the no-component-tests house convention.

---

## Rollout

1. **Backend:** migration → db-types → repository → route → wire in `routes.ts`.
2. **Frontend:** hook + types → manage page → edit page → shared fields → nav → new-session dropdown.
3. **Docker:** compose `user:` + workspace mount.
4. `turbo build` (regenerates `@internal/backend-client` from OpenAPI), then `bun run verify-types && bun run lint && bun run test`.

---

## Open questions / follow-ups (not blocking)

- Whether `ro` should eventually drive a hard mount-level read-only (needs a compose/mount hint per workspace — deferred).
- Whether the new-session Workspace dropdown should show only rw workspaces (today it shows all).
- Whether to expose the acting user's `role` client-side (so `/workspaces`, `/settings`, `/users` can hide admin-only controls). Currently `getSessionUser()` returns only `{ id, email, name }`; adding `role` is a small follow-up that would let all three pages gate properly.
