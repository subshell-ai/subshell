# Workspaces — Design Spec (2026-08-27)

**Goal:** a **workspace** is a saved, free-form canvas of windows, each window holding one
agent session, so an operator can watch and drive several sessions in a single view.

The name was freed for this on 2026-08-27: the directory registry that used to be called a
workspace is now a **mount**, and a session's own path is `workingDir`. See
`2026-08-25-managed-workspaces-design.md` for what that entity was.

**Out of scope (deferred):**
- Sharing a workspace with another user, or any real-time co-presence.
- Non-session panes (notes, log tails, file trees) — `kind` is not modelled; every pane is a
  session. Adding a discriminant later is a migration, not a redesign.
- Broadcast input (typing into several sessions at once).
- Workspace templates, or auto-arranging panes.

---

## Decisions taken up front

| Question | Decision | Why |
|---|---|---|
| Layout model | **Free-form canvas** — drag/resize windows on a pannable surface; **no zoom** | Chosen over preset grids and tmux-style splits |
| Persistence | **Server-side, per user** (`user_id`, like `profiles`) | Layouts follow the operator across browsers/machines |
| Liveness | **Virtualized by viewport** — only visible panes hold a socket | A live pane costs an xterm + WebGL context + WebSocket, and browsers cap WebGL contexts at ~8–16 |
| Pane content | **Attach an existing session, or launch a new one into the pane** | Reuses the `/new` profile + mount form rather than duplicating it |
| Reading a pane | **Hover peeks, click expands to a full view** | Replaces canvas zoom, which cannot be done to a terminal without wrecking it |

### Why virtualization is load-bearing

Three costs scale with the number of *attached* panes, and they are the reason this is not
simply "render N terminals":

1. **WebGL contexts.** `sessions_.$id.tsx` loads `WebglAddon` per terminal. Browsers cap live
   contexts (~8–16); past the cap the oldest is silently killed, which looks like a randomly
   blank terminal.
2. **Full history replay.** Every attach re-streams the session log from byte 0 (see
   `use-session-ws.ts`) — opening a workspace with 8 panes means 8 full replays at once.
3. **One `ws-token` round trip per attach.** Tokens are single-use with a 30s TTL.

So a pane is attached only while it intersects the canvas viewport. Panning a window
off-screen serializes its screen and drops the socket; panning it back re-attaches, and the
replay rebuilds it. There is no client-side scrollback to preserve — the server already
re-streams everything, which is what makes detaching cheap and safe.

---

## Backend

### 1. Migration `0006-workspaces.ts`

Two tables. **These are the schema's first foreign keys.** `PRAGMA foreign_keys = ON` is
already set in `packages/sqlite-dialect/src/database.ts:41`, so they are enforced.

`workspaces`:

| column | type | notes |
|---|---|---|
| `id` | text PK | `crypto.randomUUID()` |
| `user_id` | text not null | owner; every query filters on it |
| `name` | text not null | 1..120, unique **per user** |
| `description` | text null | 0..500 |
| `canvas_x` / `canvas_y` | real not null default 0 | saved viewport pan |
| `created_at` / `updated_at` | text | `strftime` defaults, as in `mounts` |

Indexes: `idx_workspaces_user` on `(user_id, name)` unique.

`workspace_panes`:

| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `workspace_id` | text not null | **FK → `workspaces(id)` ON DELETE CASCADE** |
| `session_id` | text not null | **FK → `sessions(id)` ON DELETE CASCADE** |
| `x` / `y` | real not null | canvas coordinates of the window's top-left |
| `width` / `height` | real not null | window size in canvas units |
| `z_index` | integer not null default 0 | click-to-front ordering |
| `collapsed` | integer not null default 0 | 1 = title bar only |
| `created_at` / `updated_at` | text | |

Index: `idx_workspace_panes_workspace` on `(workspace_id)`.

Cascade is the whole answer to dangling panes: `deleteSession` already removes the session
row, so its panes vanish with it and no application code has to sweep them. A **terminated**
session is different — the row survives, so the pane survives and shows a restart affordance.

Registered in the provider map in `migrate.ts` under `"0006-workspaces"`. Per
`AGENTS.md`, the file name and the map key must match.

### 2. DB types

`workspaces.db-types.ts` and `workspace-panes.db-types.ts`, mirroring `mounts.db-types.ts`:
`WorkspaceTable` / `NewWorkspace` / `WorkspaceUpdate`, `WorkspacePaneTable` / `NewWorkspacePane`
/ `WorkspacePaneUpdate`. Both registered in the `Database` interface.

### 3. Repositories

`WorkspacesRepository`
- `create`, `findById`, `listByUser(userId)` (ordered `name asc`), `update`, `delete`
- every read takes `userId` and filters on it — a workspace is private to its owner

`WorkspacePanesRepository`
- `listByWorkspace(workspaceId)`
- `create(NewWorkspacePane)`, `delete(id)`
- `replaceGeometry(workspaceId, panes)` — one transaction, used by the debounced bulk save

### 4. Routes — `apps/backend/src/api/workspaces.route.ts`

`new Elysia({ prefix: "/api/workspaces" }).use(authGuard)`. Unlike mounts there is **no admin
gate**: a workspace is the caller's own, so ownership is the check. Every handler resolves the
workspace by `(id, user.id)` and 404s on a miss — never 403, so the endpoint cannot be used to
probe another user's workspace ids.

| Endpoint | operationId | Notes |
|---|---|---|
| `GET /` | `listWorkspaces` | caller's workspaces, no panes |
| `POST /` | `createWorkspace` | `{ name, description? }`; 409 on duplicate name for that user |
| `GET /:id` | `getWorkspace` | workspace **plus** its panes, each with the session's name/status |
| `PUT /:id` | `updateWorkspace` | name, description, and the canvas viewport |
| `DELETE /:id` | `deleteWorkspace` | cascade removes panes |
| `POST /:id/panes` | `addWorkspacePane` | `{ sessionId, x, y, width, height }`; 404 if the session is not the caller's |
| `PUT /:id/panes` | `saveWorkspaceLayout` | bulk geometry, one transaction |
| `DELETE /:id/panes/:paneId` | `removeWorkspacePane` | |

`WorkspacesError extends Error` with a `readonly status` (400/404/409), matching the shape
`mounts.route.ts` uses.

**`GET /:id` joins the session row** so a pane can render its title and status without N extra
requests. It returns the session's `id`, `name`, `status`, `alive`, `exitCode`, `workingDir`.

Every `t` schema property carries a `description`, per the Elysia rule in `code-style.md`.

---

## Frontend

### 5. The enabling refactor: extract `<SessionTerminal>`

Nothing can render a second terminal today — the xterm instance, its four addons, the
`ResizeObserver`, and the `/` key handler all live inline in `sessions_.$id.tsx`, which is
**442 lines** and already past the ~200-line limit `code-style.md` sets for route files.

New `components/session-terminal.tsx` owns exactly the reusable half:

- creating the `Terminal` with the shared theme + `FitAddon`/`SerializeAddon`/`SearchAddon`,
  and `WebglAddon` behind the existing try/catch
- `term.open()`, the `ResizeObserver` → `fit()` loop, and disposal
- `useSessionWs` attach, the `connected` / `closed` state, and the "reconnecting…" pill
- `useTerminalUploads` and the drop overlay
- the exited / not-running state panels

```ts
interface SessionTerminalProps {
  sessionId: string;
  /** false = detach the socket and render a frozen snapshot (canvas virtualization). */
  active?: boolean;
  /** Hands the page the term + addons so it can mount the command palette and finder. */
  onReady?: (handles: { term: Terminal; serialize: SerializeAddon; search: SearchAddon }) => void;
  onStatusChange?: (status: { connected: boolean; closed: boolean }) => void;
}
```

`active` is the single lever the canvas pulls, and it is why this prop exists at all. When it
goes false the component serializes the screen, disposes the terminal (releasing the WebGL
context — merely closing the socket would not), and renders the snapshot as static text with
`stripAnsi`. When it goes true it rebuilds and re-attaches; the server's replay restores the
real content, so the snapshot only has to cover the gap.

What stays on `sessions_.$id.tsx`: the header, session switcher, terminate/restart/delete
actions, status polling, the `/` command palette and `CommandBar`, and `TranscriptSearch`.
The route should land near ~200 lines.

**This refactor must not change `/sessions/:id` behaviour.** It is a pure extraction, done and
verified first, before any workspace code is written.

### 6. The canvas

- `routes/workspaces.tsx` — list, create, delete (the `mounts.tsx` shape)
- `routes/workspaces_.$id.tsx` — thin: loads the workspace, renders `<WorkspaceCanvas>`
- `components/workspace-canvas.tsx` — the pannable surface
- `components/workspace-pane.tsx` — one window: title bar, status dot, drag handle, resize
  corner, close button, and a `<SessionTerminal>` body
- `hooks/use-workspaces.ts`, `hooks/use-workspace.ts`
- `lib/canvas-geometry.ts` — **pure math, no React**
- `lib/workspace-form.ts` — form state, mirroring `mount-form.ts`

Interaction model:

| Gesture | Effect |
|---|---|
| Drag empty canvas, or middle-drag anywhere | Pan |
| Drag a pane's **title bar** | Move that window |
| Drag the corner handle | Resize |
| Click a pane's terminal body | Focus it for typing, raise `z_index` |
| **Hover** a pane | Peek: lift and scale it slightly |
| **Click its title bar / expand button** | Expand to a full-viewport view; Esc or close returns |

The canvas is one absolutely-positioned layer under `transform: translate(x, y)`, with panes
positioned in canvas coordinates inside it. There is **no zoom**, and that is a deliberate
constraint rather than a missing feature: a CSS-scaled xterm renders blurry and its
mouse-coordinate mapping breaks, while re-fitting on zoom reflows every visible agent's output.
Reading a pane closely is served by expanding it instead.

**xterm owns its mouse events**, so dragging is bound to the title bar and the resize corner
only — never the terminal body, which needs its clicks for selection and focus.

### 6a. Hover peek

Hover applies `transform: scale(1.06)` plus a shadow and a raised `z-index`, with a short
delay-in so sweeping the mouse across the canvas does not strobe.

This is **purely visual — no re-fit, no resize frame**. Growing a terminal for real would
change its cols/rows and make the agent re-wrap its output; doing that on pointer-over would
reflow every session the cursor passes. The cost is that hovered text is slightly soft while
the pointer rests on it, which at 1.06 reads as a lift rather than as blur. Peek is an
affordance that says "there is more here", not a way to read output.

### 6b. Expand to full view

Clicking the title bar (or its expand button) animates the pane out to fill the viewport and
mounts the full session chrome. Esc, the close button, or clicking the dimmed backdrop returns
it to its place on the canvas.

The expanded pane is **the same mounted `<SessionTerminal>` instance**, re-parented into a
larger container — not a second terminal and not a navigation to `/sessions/:id`. So expanding
costs exactly one `fit()` and one resize frame; there is no detach, no re-attach, and no
history replay. The pane's canvas geometry is untouched, so collapsing puts it back exactly
where it was.

While a pane is expanded the others are off-screen and the visibility rule would detach them.
The detach debounce (§6c) means a quick look costs nothing, while a long focused session does
free their sockets and WebGL contexts — which is the desirable outcome, since the operator is
demonstrably not watching them.

Expansion is **ephemeral UI state and is not persisted**: reopening a workspace always lands on
the canvas.

`lib/canvas-geometry.ts` holds everything worth testing:

```ts
screenToCanvas(pt, viewport)                 // pointer → canvas coordinates
canvasToScreen(pt, viewport)
paneIsVisible(pane, viewport, size, margin)  // drives `active`
clampPaneSize(size)                          // a pane must stay big enough to be a usable terminal
nextPanePosition(existing)                   // where a new pane lands, cascaded, no overlap
```

### 6c. Detach damping

`paneIsVisible` uses a **margin** (roughly half a viewport) so a pane just off the edge stays
attached — otherwise nudging the canvas would thrash sockets. Detach is additionally debounced
(~2s) so a pan across the canvas does not tear down every terminal it sweeps past.

### 7. Layout persistence

Geometry changes constantly while dragging; it must not be a write per frame. Local state is
authoritative during a gesture, and `PUT /:id/panes` fires **debounced ~800ms after the last
change**, plus on unmount and on `visibilitychange`. The canvas viewport saves the same way via
`PUT /:id`.

### 8. Pane states

| Session state | Pane shows |
|---|---|
| running, visible | live terminal |
| running, hovered | live terminal, scaled up 1.06 (visual only) |
| running, expanded | live terminal at viewport size, full chrome |
| running, off-screen | frozen snapshot, socket closed |
| exited (`status running`, `alive false`) | exit code + label, **Restart** / **Remove pane** |
| terminated | "session ended", **Restart** / **Remove pane** |
| deleted | pane is gone — FK cascade, no UI path needed |

Restart calls the existing `POST /api/sessions/:id/restart`, which mints a **new** session id;
the pane is then repointed at it in place, so the window keeps its position.

### 9. What lives in a pane vs. the expanded view

Expansion gives a natural home for the heavier chrome, so panes stay legible at small sizes:

| | Pane | Expanded |
|---|---|---|
| Title, working dir, status | ✓ | ✓ |
| Type into the session | ✓ | ✓ |
| Drag-and-drop file uploads | ✓ | ✓ |
| Move / resize / close pane | ✓ | — |
| Transcript search (find) | — | ✓ |
| Terminate / restart / delete | — | ✓ |
| `/` command palette | — | — (full-page view only) |
| Session switcher | — | — (canvas replaces it) |

Uploads stay in panes because dropping a file **onto a specific window** is unambiguous and is
exactly the gesture you want with several sessions on screen. Search and the lifecycle actions
appear once a pane is expanded, where there is room for them.

**The `/` palette stays off the canvas entirely** — panes and expanded panes alike pass `/`
straight to the session. Two reasons. The interception in `sessions_.$id.tsx` is subtle (it must
cancel the event outright, not merely return `false`, or xterm's keypress path still emits the
char), so it is worth having exactly one home for it. And agent CLIs are themselves driven by
slash commands, so passing `/` through is usually what you want from a workspace. The rule is
then simple and uniform: **the canvas never swallows a keystroke.** `/sessions/:id` is where the
palette lives.

---

## Testing

Backend, matching `testing.md`:
- `0006-workspaces.test.ts` — both tables, defaults, and that **both cascades actually fire**
  (delete a workspace → panes gone; delete a session → its pane gone). The cascade is the whole
  dangling-pane strategy, so it gets a test rather than an assumption.
- `workspaces-repository.test.ts` / `workspace-panes-repository.test.ts` — CRUD, user scoping,
  `replaceGeometry` atomicity.
- `workspaces-route.test.ts` — auth (401), **ownership isolation** (another user's workspace
  reads as 404, and panes cannot be added pointing at a session you do not own), duplicate name
  409, bulk layout save.

Frontend — pure functions only, matching the three existing `lib/__tests__` suites:
- `canvas-geometry.test.ts` — round-tripping `screenToCanvas`/`canvasToScreen`, `paneIsVisible`
  at the margin boundary, `clampPaneSize` floors, `nextPanePosition` not overlapping.
- `workspace-form.test.ts` — as `mount-form.test.ts`.

There is no component-test harness in this repo and this design does not add one; the canvas is
verified by the geometry tests plus driving the real app. Two claims can only be checked that
way and should be checked explicitly: that expanding a pane does **not** re-attach (watch for a
single resize frame and no replay), and that hover applies no resize frame at all.

Then the full gate: `bun run verify-types`, `bun run lint:check`, `bun run test`.

---

## Risks

1. **The extraction is the risky step, not the canvas.** `sessions_.$id.tsx` has subtle
   behaviour — the `/` key handler's double-cancel, reconnect semantics, the exited-vs-closed
   split. Extract first, verify `/sessions/:id` is unchanged, commit that alone.
2. **Re-parenting the terminal on expand.** Keeping one `<SessionTerminal>` instance across the
   canvas → full-view transition is what makes expanding cheap, but React re-parenting can
   remount a subtree, and a remount here means a dispose + re-attach + full replay — exactly
   what the design is avoiding. The pane must therefore hold a **stable position in the tree**
   with only its container's size and position animating, rather than being conditionally
   rendered in two places. If that proves unworkable, the honest fallback is to accept one
   replay per expand.
3. **WebGL churn.** Rapid attach/detach cycles create and destroy contexts. The visibility
   margin plus the detach debounce exist to damp this; if it still churns, `@xterm/addon-canvas`
   is already a dependency and is the per-pane fallback renderer.
4. **Bulk layout saves racing.** The debounced `PUT` sends the full pane set; a save in flight
   when another starts is dropped rather than queued, since the next one carries the complete
   state anyway.
