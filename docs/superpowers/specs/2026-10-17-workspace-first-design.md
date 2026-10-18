# Workspace-first: subshells live in workspaces

Date: 2026-10-17. Status: approved by the operator in session; "just write and impl".

## The problem

Workspaces already are a saved set of references to subshells (the
`workspace_panes` join table, many-to-many, never an owner), but everything
around them reads as second-class: a separate nav item and card page, a flat
Subshells list that is the real spine of the app, a draft half-life spawned
by Split, dedupe re-implemented in four client files (regression #13), and no
server way to ask "what is in no workspace at all".

## Decisions (from the operator, this session)

1. A workspace is a window of panes: a named set of references to live
   subshells. The pane stays the first-class object (this matches the
   existing schema; the revamp matches the product to it).
2. Creating a subshell lands a tab in the workspace you are looking at; if
   none is open, one is created. Dragging a sidebar pane into a workspace
   adds it directly, no dialog in the way.
3. A pane may live in many workspaces (references, already true).
4. The dock stays exactly as it is: per-group headers with dot, name, bell,
   close, maximize; edge-drop splits; tile tab groups. No workspace-wide tab
   strip; the operator rejected it against a screenshot of the current dock
   (this killed earlier strip-placement and click-semantics exploration).
5. The sidebar becomes a tree: workspace rows expanded to their member
   panes, an Ungrouped section for panes in no workspace, and an "All
   subshells" entry that keeps today's flat table for search and bulk
   actions.
6. An empty workspace deletes itself when the last tab is removed. Panes
   keep running, just unfiled.
7. First cut covers the web SPA and Subshell Client (it loads the SPA).
   Mobile, MCP workspace tools, workspace sharing, `/ws/live` frames, and
   notification routing are explicitly unchanged.

## Non-decisions

Layout truth stays split on purpose: membership and rail order are rows
(`workspace_panes`, ordered by `createdAt`); the dock arrangement stays the
opaque `layout_json` pruned on read. The phone strip keeps never writing
`layout_json`.

## Data model

One migration (`NNNN-workspace-first.ts`, registered in the `migrate.ts`
provider map):

- Drop `workspaces.draft`. Existing drafts promote to ordinary workspaces
  (their names already are unique among saved rows; a promoted name can now
  collide with nothing new because of the next point).
- Drop the per-user unique name index. Workspace names stop being unique;
  with auto-created workspaces a collision is normal, not an error. Keep
  `normalizeLabel` + the 120-char cap.
- Add `UNIQUE (workspace_id, subshell_id)` to `workspace_panes`, after a
  keep-the-earliest-row dedupe of existing doubles.
- No new columns. `createdAt` order drives the rail tree and the phone
  strip.

## Server API

- `POST /api/workspaces`: loses `draft`; keeps `{name, subshellId?}`. Name
  collisions are fine now, so the 409 relabel path goes.
- `DELETE /api/workspaces/drafts`: deleted.
- `GET /api/workspaces`: loses `drafts=only`. `subshellId` filter stays
  (the pane-header link uses it). List rows gain `panes[]` (id, subshellId,
  name, status, alive, node offline) in membership order so the rail tree
  renders from one request; `subshellCount` keeps riding along.
- `PUT /api/workspaces/:id`: loses `draft`. Rename only.
- `POST /api/workspaces/:id/panes`: duplicate add now answers 409 with
  `{error: "already_in_workspace", paneId}` (the existing row) instead of
  creating a double. Client dedupe guards can go.
- `DELETE /api/workspaces/:id/panes/:paneId`: if the workspace has zero
  panes after the removal, delete the workspace; response carries
  `workspaceDeleted: true`. This rule replaces the draft-only rule and the
  client `use-discard-thin-draft` hook.
- Subshell deletion (the app's delete cascade) additionally deletes any
  workspace its cascade emptied. No new response fields: the SPA refetches
  its workspace queries anyway.
- `POST /api/subshells` gains optional `workspaceId`: the pane row is
  written in the same transaction as the subshell row; the caller must have
  `view` on that workspace or it is a 404 (ownership reads as 404 as
  everywhere). If the pane insert fails, the subshell row rolls back with
  it (one transaction, no compensating delete needed).
- `GET /api/subshells` gains `workspace=none` (unfiled panes, the Ungrouped
  source) and `workspace=<id>` (members), validated at the boundary as an
  enum-shaped filter over `none` or a uuid-ish id, per the list-search
  rules. It passes no actor changes: visibility semantics of the list are
  untouched.

MCP (`subshell mcp`) keeps calling `POST /api/subshells` without
`workspaceId`, so agent-created panes are born ungrouped, exactly where the
rail's "Created by agents" filing already expects them.

## Web SPA

- Rail: `WorkspacesSection` becomes the tree. Workspace rows expand to
  member panes (status dot, waiting cue), a context menu carries Rename and
  Remove workspace; an Ungrouped section lists `?workspace=none` rows; the
  footer link "All subshells" opens the old table. The Subshells and
  Workspaces top-level nav items and the "Wksp" short label go away. The
  Drafts group and its sweep go away.
- Rail rows and "All subshells" rows learn `draggable` with the existing
  `application/x-subshell-id` payload (`lib/subshell-dnd.ts`); the dock's
  existing drop overlay accepts them. No dock changes.
- Landing: `/` shows the active workspace (last opened per device,
  localStorage), or the empty state with one New subshell button. The old
  Subshells table moves to `/subshells`. Deep links `/workspaces/$id` and
  `/subshells/$id` keep their meanings, so notifications, QR codes, and
  external links are unaffected.
- `/workspaces` card page stays (grid, QR, typed-name delete) but is
  reachable from the rail heading, not from top-level nav.
- The launch dialog sends `workspaceId` = the workspace you're viewing
  (or creates one first at the empty state, via `POST /api/subshells` with
  no workspace then one pane-add; the empty-state path keeps two calls
  because there is no row to race).
- Split means "add a sibling pane here": from the workspace view it adds to
  the current dock; from `/subshells/$id` it creates a workspace holding
  both panes. Same prefill and placement select. "Unsaved workspace" copy,
  Save/Discard dialogs, and the `?add=` intent param are deleted.
- Client-side dedupe guards in `routes/workspaces.tsx`, `workspace-dock.tsx`,
  `workspace-tabs.tsx`, and `use-workspace-pane-mutations.ts` are replaced
  by the server's 409 answer (they still short-circuit locally to avoid a
  wasted request, but they are no longer correctness-critical).
- Copy: titles stay fixed and short per the design system; the workspace
  header keeps "+ Add subshell"; the rail button stays "+ New subshell".
  No em dashes anywhere in shipped strings.

## Error handling

- 409 `already_in_workspace` carries the pane id so the client can focus it.
- `workspaceId` on create: 404 unknown/foreign workspace, same posture as
  every other ownership miss; no enumeration difference.
- Zero-panes auto-delete runs inside the same transaction as the pane
  removal; a concurrent add racing it sees the FK row already gone and gets
  the plain 404 for the workspace it tried to edit.
- The promoted-draft migration keeps every row: drafts are the only rows at
  risk of name collision, and names no longer collide at the index level.

## Testing

- Server: migration dedupe/promotion; add-pane 409 with paneId; remove-pane
  self-delete at zero (saved, not just drafts); subshell-delete cascade
  empties-and-retires; create-with-`workspaceId` transaction (including
  rollback on pane insert failure); `workspace=none` and `workspace=<id>`
  boundary validation (length, shape, foreign ids, anonymous and bearer
  posture unchanged); list `panes[]` payload.
- Route tests mount the production error handler (statuses and bodies).
- e2e: `05-workspaces.spec.ts` and `06-split-to-workspace.spec.ts`
  rewritten around no-draft flows; one new spec: create lands a tab in the
  workspace you are viewing; landing shows the remembered workspace.
- Focused files while iterating; full `verify-types`, `lint:check`,
  `lint:prose`, `test`, and `turbo build` at the boundary. `test:cli` is
  not in scope (no CLI surface changes).

## User docs

`apps/docs/content/docs/guides/workspaces.mdx` and the glossary update to
the no-draft model; the "Project workspace" alt-text drift is fixed on the
way through.

## Out of scope

Workspace sharing, MCP workspace tools, live-feed workspace frames, mobile
workspace UI, per-device active-workspace sync, tab-order editing beyond
drag reorder (membership `createdAt` is the order; reordering the rail tree
is not a feature).
