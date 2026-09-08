# Workspace: enter-on-create, inline title/description, session count — design

**Date:** 2026-08-28
**Status:** Approved

## Problem

Creating a workspace means filling a form on the list page before seeing the
workspace itself, and renaming it later means returning to that page's model
(there is no edit surface at all for workspaces today). The list cards also say
nothing about what a workspace holds.

## Goal

- **New workspace** creates immediately with a default title and lands the user
  inside the workspace.
- Inside the workspace, **click the title to rename it** and click the
  description to set it — no dialog, no form page.
- Each workspace card on the list page **shows how many sessions** the
  workspace contains.

## Design

### 1. Create-and-enter (`routes/workspaces.tsx`)

- "New workspace" and the empty box's CTA both POST `/api/workspaces` with
  `name = "Workspace · Aug 28, 4:45 PM"` (locale-formatted timestamp; names are
  unique per user, and a timestamp is the scheme that stays unique without a
  lookup — it mirrors how unnamed sessions default to date/time), no
  description. Then `navigate` to `/workspaces/$id`.
- The button is disabled while the POST is in flight; a failure lands in the
  existing page-level error line.
- The inline create card (name/description inputs, Cancel) is deleted — and
  with it `lib/workspace-form.ts` and its test, whose only consumer it was.

### 2. Click-to-edit (`components/workspace-header.tsx`)

- `EditableText`, defined and exported from `workspace-header.tsx` (its only
  consumer's file): renders a value as a flat button with a text-edit cursor
  affordance and a tooltip; clicking swaps to an inline `<input>` prefilled
  and selected. Enter or blur saves when the trimmed value is changed and
  non-empty; Escape or an empty value reverts.
- `WorkspaceHeader` owns the save mutation, the way `SessionActionsMenu` owns
  its mutations: `PUT /api/workspaces/:id` with `{ name }` or
  `{ description }`, then invalidate `["workspace", id]` and
  `WORKSPACES_QUERY_KEY` (the header reads from the polled detail query, and
  the list page's cards refresh too). No new props — the dock and the tab
  strip presentations get editing for free.
- A null description renders as a muted **"Add description"** placeholder so
  the affordance is discoverable.
- Duplicate name → the backend's 409: the input stays open with a small
  `text-destructive` message beside it.

### 3. Session count on cards

**Backend** — `WorkspaceSchema` (`api/models.ts`) gains
`sessionCount: t.Number({ description: … })`; a workspace always knows how
many sessions (panes) it has, so it rides every response:

- `POST /` → `0` (a fresh workspace has no panes).
- `GET /:id` → `panes.length` (already fetched).
- `PUT /:id` → fresh count via `WorkspacePanesRepository.countForWorkspace(id)`.
- `GET /` → one `countByUser(userId)` query (`GROUP BY workspace_id`), merged
  into the list at route level — the composition-of-repositories pattern
  `GET /:id` already uses. No N+1s.

`workspaces-route.test.ts` covers the new field. `turbo build` runs after the
schema change per the build rule.

**Frontend** — `WorkspaceRow` gains the documented `sessionCount`; the card
renders `3 sessions` (singular at 1) as a muted body line via the
`EntityCard` children slot, like the bookmark path line.

## Testing

- New: `EditableText` component tests (open, save on Enter/blur, revert on
  Escape/empty, failed-save keeps editing with the error).
- Updated: backend route tests for `sessionCount` on create/list/detail/update.
- Full green: `verify-types`, `lint:check`, `bun run test`; then a Chrome pass
  (create → lands in workspace → rename by click → set description → back to
  list shows new name and session count after a pane is added).

## Out of scope

- Renaming from the list cards (the workspace page is the rename surface).
- Description editing anywhere but the workspace header.

## Amendment (same day, post-merge)

The description was removed outright — the field shipped, met no users, and
a workspace is better summarized by its session count than by prose nobody
writes. Migration `0008` drops the column; the API, `WorkspaceRow`, the
header's second `EditableText`, and the card subtitle for workspaces are
gone. `EditableText` stays for the rename, and `EntityCard` now omits the
subtitle row entirely when a caller passes no `description` at all.
