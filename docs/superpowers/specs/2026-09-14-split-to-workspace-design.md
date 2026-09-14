# Split a subshell into a workspace — Design Spec (2026-09-14)

Implementation plan: `docs/superpowers/plans/2026-09-14-split-to-workspace.md`.
Builds on `2026-08-28-workspace-tiling-design.md` (dockview tiling, one pane = one subshell), which stays in force.

## Context

Workspaces today are reached from the Workspaces page: you create one, then add subshells to
it. The common workflow is the reverse — you are already in a subshell and want a second pane
beside it, like `prefix %` in tmux. Decisions taken in conversation (2026-09-14):

- **A split pane IS a new subshell** (own tmux server, token, log, MCP identity). No change
  to the one-pane-per-subshell model in `pane-runtime`.
- **Splitting always shows the existing add-subshell picker** (existing vs new, plugin,
  preset, node, cwd, direction). No one-click default.
- **The not-yet-saved layout is a draft workspace on the server** — reload-safe, cross-device,
  and it reuses every route, test and ownership rule of workspaces. "Save as workspace" =
  naming it. Existing saved workspaces behave exactly as today.

Vocabulary: `draft` in code; "unsaved workspace" in copy. No new noun.

---

## Design

### 1. Data model

Migration `0029-workspace-drafts.ts` (+ register `"0029-workspace-drafts"` in
`apps/server/api/src/db/migrate.ts`):

- `ALTER TABLE workspaces ADD COLUMN draft integer NOT NULL DEFAULT 0`.
- Drop `idx_workspaces_user_name`; recreate it as a **partial** unique index:
  `CREATE UNIQUE INDEX idx_workspaces_user_name ON workspaces (user_id, name) WHERE draft = 0`.
- `down`: drop the partial index, recreate the full one, drop the column.

Why a flag and a partial index rather than a nullable name: nothing downstream has to handle
`name: null`, drafts get an auto name (the root subshell's name) that may collide freely, and
promotion is one `UPDATE`. Panes and `layout_json` are untouched, so cascade, pruning and
ownership apply unchanged.

`WorkspaceTable.draft: number` (0/1, like `alive`, `configIsolation`); `NewWorkspace.draft?`.

### 2. API (all cookie-only via `requireCookieActor`, owner-scoped, 404-never-403)

| Route | Change |
|---|---|
| `POST /api/workspaces` | body gains `draft?: boolean`, `subshellId?: string`. With `subshellId`, the first pane is created in the same call (visibility check = `addWorkspacePane`'s: `loadSubshellAccess` + `accessAtLeast("view")`, 404 on miss). Not transactional in this codebase (no service uses `db.transaction()`); the check runs before the insert, and if the pane insert throws the workspace row is deleted before rethrowing. |
| `GET /api/workspaces` | **excludes drafts.** New query `?subshellId=` returns the caller's workspaces holding a pane for that subshell, **drafts included**, `updatedAt desc`. |
| `PUT /api/workspaces/:id` | body gains `draft?: false` (`t.Optional(t.Literal(false))`) — the only transition; a saved workspace can never become a draft. A name collision on promotion is the existing 409. |
| `DELETE /:id/panes/:paneId` | on a **draft** that would be left with fewer than two panes, the draft is deleted too. Response becomes `{ ok: true, workspaceDeleted: boolean }`. A saved workspace keeps 0/1 panes as today. |

`WorkspaceSchema` (`api/models.ts`) gains `draft: t.Boolean(...)`; `toWorkspaceResponse` maps
`draft === 1`. `WorkspaceDetailSchema` inherits it.

Nothing else changes: `GET /:id` serves drafts (they are reachable by URL and via the filter),
layout save, add pane, delete workspace all unchanged.

### 3. Splitting from a subshell (SPA)

`routes/subshells_.$id.tsx` header gains a **Split** button (in the `!findTakesRow` group,
before `SubshellDevices`; icon-only below `sm`). Implemented as
`components/split-subshell-button.tsx` so the 334-line route stays thin. It opens the existing
`AddSubshellDialog` with:

- `excludeSubshellIds=[id]` (the dialog's `existing: WorkspacePaneRow[]` prop becomes
  `excludeSubshellIds: string[]`; `SubshellPicker` maps its `existing` to ids).
- `initialForm={{ harnessId, nodeId, workingDir }}` from the current subshell so the New half
  starts as "same plugin, same node, same directory" (new optional prop; `reset()` returns to it).

`onAdd(subshellId, direction)`:
1. `POST /api/workspaces { name: subshell.name, draft: true, subshellId: <current> }` → `{ id }`.
2. `navigate({ to: "/workspaces/$id", params, search: { add: subshellId, dir: direction } })`.

Errors throw out of `onAdd` and render in the dialog as they do today.

`routes/workspaces_.$id.tsx` gains `validateSearch` for optional `add` / `dir` and hands the
parsed intent (`lib/workspace-split-intent.ts`, pure: `parseSplitIntent(search) →
{ subshellId, direction } | null`, direction validated against a new runtime
`SPLIT_DIRECTIONS` array in `types/workspace.ts`) to the presentation. In the dock:

- `ready` state set in `onReady`; an effect on `[ready, intent]` runs once (ref guard):
  if `detail.panes` already holds `intent.subshellId` → skip (a reload with the params still
  in the URL must not add a duplicate pane, regression #13); else `await handleAdd(...)`.
  Then `await onRefetch()` (the prop becomes `() => Promise<void>`), then strip the params
  with `navigate({ search: {}, replace: true })`.
- `WorkspaceTabs` does the same through its own `handleAdd` (direction ignored, as today).

So the first split runs the same `handleAdd` → `addPane` → `addPanel(resolveAddPosition(...))`
path as every later one, and the picker's direction is honoured.

### 4. The draft in the UI

- `WorkspaceHeader`: for `workspace.draft`, the title is static "Unsaved workspace"
  (`text-muted-foreground`), not `EditableText`; the actions slot is prefixed with
  **Save workspace…** (primary) and **Discard** (ghost), then the picker as today.
  - Save → `components/save-workspace-dialog.tsx`: one name field prefilled with
    `workspace.name`, `PUT /:id { name, draft: false }`, 409 re-labelled as the header's
    rename already does; on success invalidate `[...WORKSPACE_QUERY_KEY, id]` +
    `WORKSPACES_QUERY_KEY`. The header then shows the editable name.
  - Discard → `confirmAction({ title: "Discard this unsaved workspace?", description:
    "Its subshells keep running.", confirmLabel: "Discard", danger: true })` →
    `DELETE /api/workspaces/:id` → navigate to `/subshells/$id` of the active panel's
    subshell (fallback: first pane; fallback: `/`).
- **Auto-discard on read** (`routes/workspaces_.$id.tsx`): when `detail.workspace.draft &&
  detail.panes.length < 2` and **no split intent is in the URL**, navigate to the remaining
  pane's subshell page (or `/`) and `DELETE` the draft (ignore already-gone). The intent guard
  is what keeps a freshly created one-pane draft alive while its second pane is being added;
  the dock strips the params only after the refetch shows both panes.
- `handleRemovePane` (dock + tabs): when the response says `workspaceDeleted`, navigate to the
  other pane's subshell page instead of closing a panel. `useWorkspacePaneMutations.removePane`
  resolves `{ workspaceDeleted: boolean }` (`false` on an already-gone 404).
- Drafts never appear on `/workspaces` or in sidebar recents — the list route excludes them, so
  `useWorkspaces`, `recentWorkspaceLinks`, cards and the sidebar need no change.
- Subshell page: `hooks/use-subshell-workspaces.ts` (`GET /api/workspaces?subshellId=`,
  `staleTime` 30 s, invalidated after a split). Renders `components/subshell-workspace-link.tsx`
  in the header actions: prefers a draft ("Open unsaved workspace"), else the most recently
  updated saved one ("In “<name>”"), linking to `/workspaces/$id`. Renders nothing when empty.

### 5. Security note

No new exposure. Every route stays cookie-only and owner-scoped; a draft is a workspace row
the caller already could create. The `?subshellId=` filter returns only the caller's own
rows. Add one line to `apps/server/api/AGENTS.md` (workspaces) and a "Drafts" subsection to
`apps/server/web/AGENTS.md` next to the existing dockview notes. `security-context.md` needs
no edit.

### 6. Out of scope (deferred)

Splitting into a real tmux pane inside one subshell; hiding split children from the sidebar;
mobile (`apps/client/mobile` renders no workspaces); a one-click "same plugin" split; keyboard
shortcuts for split.

---

