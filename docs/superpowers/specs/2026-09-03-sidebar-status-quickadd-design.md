# Sidebar: session status dots, quick-add, and drag-to-workspace

**Date:** 2026-09-03
**Status:** Approved design, pre-implementation

## Summary

Four related sidebar improvements, all on the app's persistent left rail:

1. **Status dots** — every recent subshell row shows its live state (active / idle /
   waiting-for-you / exited / ended / node-unreachable) as a small colored dot,
   reusing the exact state precedence the home cards already use.
2. **Quick-add** — a `+` beside the **Subshells** and **Workspaces** nav links opens
   an in-place dialog (launch a subshell / create a workspace) instead of navigating.
3. **New-workspace with subshells** — the workspace-creation dialog lets the user
   pick existing subshells (multi-select) or launch a new one *before* the workspace
   row is created, so they enter a workspace that already has panes.
4. **Drag a session into a workspace** — a sidebar subshell row can be dragged onto
   the open workspace dock or onto a workspace card in `/workspaces` to attach it.

The list grows from 3 to 8 recents with a compact search field to reach the rest,
and a single SSE feed mounted at the app root keeps every surface's data current so
a dot never lies.

All work is frontend (`apps/frontend`). No new backend endpoints — the pane-attach
and subshell-launch endpoints already exist and are reused verbatim.

## Non-goals

- No virtualized/session-tree abstraction — the whole subshell list already lives
  client-side and 8 + filtered results don't need it (approach 3, rejected).
- No change to the `/new` subshell page (it stays the deep-link/e2e launch surface;
  the sidebar dialog is a second entry point over the same `NewSubshellForm`).
- No touch drag-and-drop. Workspaces are used from tablets/phones, but drag there is
  unreliable and the drawer isn't open mid-drag; the dialogs (§3, §4) are the
  touch-accessible path to every one of these actions.
- No per-pick tiling control in the new-workspace dialog. Fresh panes land as tabs
  in one group; arranging is a dock gesture, unchanged.

## 1. One status vocabulary — `lib/subshell-indicator.ts`

The home card (`subshell-card.tsx`) already computes a status corner badge through a
documented precedence: **node unreachable → exited → waiting-for-you → activity**.
The sidebar dot must never read a subshell as a different state than the card does,
so the precedence moves into a pure, shared module.

```ts
export type SubshellIndicator =
  | "nodeOffline" | "exited" | "waiting" | "active" | "idle" | "terminated";

/**
 * The single source of truth for a subshell's coarse state, shared by the
 * home card's corner badge and the sidebar dot so the two can never drift.
 */
export function subshellIndicator(s: SubshellView): SubshellIndicator;
```

Precedence (identical to the card's `accessoryFor`):
- `nodeOffline === true` → `nodeOffline`
- `status === "running" && !alive` → `exited`
- `isWaiting(s)` → `waiting`
- otherwise `subshell.activity` (`active | idle | terminated`)

The module also owns the label + tone tables so the words ("node unreachable",
"waiting for you", "working", "idle", "ended") are defined once:

```ts
export const INDICATOR_LABEL: Record<SubshellIndicator, string>;
```

`subshell-card.tsx`'s `accessoryFor` and `ACTIVITY_LABEL` are refactored to consume
`subshellIndicator` / `INDICATOR_LABEL` (rendering unchanged — this is extraction,
not a behavior change). `RowStatusBadges` (used by the picker list) is left as-is:
it shows the full badges and already composes the same primitives.

> The dot maps the same six states to fills (a `Record<SubshellIndicator, string>`
> of Tailwind classes beside the dot component, not in the shared module — tone is a
> sidebar concern):
>
> | state | fill |
> |---|---|
> | active | solid green (`bg-success`) |
> | idle | solid grey (`bg-muted-foreground`) |
> | waiting | solid amber (`bg-warning`) |
> | exited | faint solid (`bg-muted-foreground/50`) |
> | terminated | hollow ring (`border border-muted-foreground`) |
> | nodeOffline | solid orange (`bg-orange-500`) |
>
> `waiting` on the home card pulses; the rail does not — six static,
> tooltip-labelled tones are honest enough at 6px and the rail shouldn't animate.
> Each dot is `aria-hidden` and carries `title={INDICATOR_LABEL[...]}`.

## 2. The dot in a recent row

A `SubshellDot` presentational component (in `components/sidebar/`) renders the
6px circle for a `SubshellView`. It lives in the existing recent-row gutter: the
row's current `block truncate` label becomes a two-column row (dot + label/path
stack), keeping the path line under the name.

The row itself moves to `components/sidebar/SubshellRecentRow.tsx` — the same
`Link`, the same path-under-name, wrapped by `SubshellActionsMenu` for the
right-click menu (unchanged from the current sidebar), and now additionally a drag
source (§5). `app-sidebar.tsx` calls it instead of inlining the `<Link>`.

## 3. Recents → 8, compact search, quick-add `+`

**Count.** `RECENT_LIMIT` in `lib/sidebar-recents.ts` goes 3 → 8, for both the
subshell and workspace sub-lists. The `<nav>` already scrolls (`overflow-y-auto`),
so a long tail can't push the nav links off screen. Update the existing
`sidebar-recents.test.ts` truncation cases.

**Search (Subshells only).** A compact `Input` (placeholder "Filter…", a leading
search icon) sits under the Subshells nav link. When non-empty it replaces the 8
recents with `filterSubshells(allSubshells, query)` — the exact predicate the home
page and the add-dialog already use (`lib/subshell-filter.ts`), so a query reads
identically everywhere. Rows render through `SubshellRecentRow` unchanged (dot,
right-click menu, draggable). No matches → a muted "No matches" line. Workspaces get
no search box: 8 is a glanceable handful and the workspace list is short by nature.
(If this is wrong in practice, the input is trivial to mirror.)

**Quick-add `+`.** A ghost icon-button `+` rides at the right end of the Subshells
and Workspaces nav links (expanded rail only; the collapsed rail shows none of this
chrome). Subshells `+` opens **LaunchSubshellDialog** (§4a); Workspaces `+` opens
**NewWorkspaceDialog** (§4b).

## 4. Quick-add dialogs

### 4a. `LaunchSubshellDialog` (`components/sidebar/`)

The sidebar's "new subshell" entry point. A `Dialog` whose body is the existing
`NewSubshellForm` (the same component `/new` and the add-dialog's New half already
share), footer **Start subshell** gated by the existing `canSubmit(form)`, running
through the existing `useCreateSubshell`. On success: close, and navigate to
`/subshells/$id` — matching what `/new` does, so launching from the rail lands you
where launching from the page lands you. Errors render via
`createSubshellErrorMessage` (the node-aware 409 copy) above the footer. The `/new`
route is untouched.

### 4b. `NewWorkspaceDialog` (`components/sidebar/`)

Replaces the immediate "create then enter" on `/workspaces` with a dialog that
seeds panes first. Reuses the add-dialog's two-mode shape (`Segmented`
Existing | New) but drops the `DirectionSelect` — a fresh workspace has no focused
pane to split from, and `resolveAddPosition` with no reference already lays panes
out as tabs.

State: `selected: string[]` (ordered subshell ids), plus the New-half
`NewSubshellFormValue`.

- **Existing tab** — the current `ExistingSubshellList` gains an optional
  `selected: Set<string>` + `onToggle(id)` props. When `selected` is provided the
  rows render as **checkbox** toggles (checked = on the workspace) accumulating
  into `selected`; when omitted they behave exactly today (single-pick, immediate
  `onAdd`). One component, two selection modes — the default-preserving prop keeps
  `AddSubshellDialog` byte-for-byte in behavior.
- **New tab** — `NewSubshellForm` with a primary **Launch & add** action: runs
  `useCreateSubshell.mutateAsync(form)` to launch the subshell (launching *is*
  creating), then adds its id to `selected` and switches to the Existing tab where
  the new one is checked. This is the "create a new one" path the brief asks for —
  the user launches a session and it lands in the workspace they're about to make.
  (A subshell created-but-not-attached, because the workspace POST later fails, is
  still reachable from `/subshells` — the same tolerance the current add-dialog
  documents.)
- Footer line shows `N subshells to add` when `selected.length > 0`.

**Submit ("Create workspace").** Sequence, mirroring the existing workspace create:

1. `POST /api/workspaces` with the placeholder name (reuse `defaultWorkspaceName`
   — extracted from `workspaces.tsx` into `lib/workspace-name.ts` so both the page's
   old inline path and this dialog share one definition).
2. For each id in `selected`, `POST /api/workspaces/:id/panes` **sequentially**
   (through `useWorkspacePaneMutations.addPane` scoped to the new id) — collecting
   failures rather than aborting on the first.
3. `useInvalidateWorkspaces()` then navigate to `/workspaces/$id`.

Error handling:
- Workspace POST fails → inline error, dialog stays open, `selected` preserved
  (nothing was created server-side except any launched new-half subshell, noted).
- Workspace created but one or more pane POSTs fail → the workspace exists and
  already holds the panes that succeeded; show a line
  "Workspace created — couldn't add N subshell(s)" and a primary **Enter workspace**
  button that navigates in. The user adds the rest from inside via the normal
  "Add subshell" control. We never pretend the missing ones are there, and we never
  delete the workspace to "roll back" (it may hold good panes).

`/workspaces` page rewiring: `createAndEnter`'s immediate POST is replaced by
opening this dialog; the EmptyState action opens it too. The page keeps its
invalidate + navigate; the dialog owns the create+seed sequence.

## 5. Drag a session into a workspace

### 5a. Payload — `lib/subshell-dnd.ts`

A dedicated MIME so our drags are unambiguous and never collide with the two other
drag systems already on these surfaces (xterm's file-upload drops, dockview's
internal tab drags):

```ts
export const SUBSHELL_DND = "application/x-subshell-id";
export function encodeSubshellDrag(dt: DataTransfer, id: string): void; // setData + effectAllowed="copy"
export function readSubshellDrag(dt: DataTransfer): string | null;      // getData, guarded by types.includes
```

`readSubshellDrag` returns null unless `dt.types` includes `SUBSHELL_DND`, so a
handler that calls it silently ignores file drags and dockview-internal drags — the
terminals keep their upload gesture and dockview keeps its layout gesture untouched.

### 5b. Source — the sidebar row

`SubshellRecentRow` sets `draggable`, and `onDragStart` calls
`encodeSubshellDrag(e.dataTransfer, subshell.id)`. Right-click still opens the menu,
left-click still navigates — HTML5 drag starts only on a press-drag, so the two
coexist.

### 5c. Target 1 — the workspace dock

`workspace-dock.tsx` wraps its `DockviewReact` in a div carrying the drop handlers:

- `onDragOver`: `if (readSubshellDrag(e.dataTransfer) !== null) { e.preventDefault();
  setDragOver(true); }` — gate on our payload so the default drag cursor over
  terminals is untouched.
- `onDrop`: read the id; **if it is already a pane on this workspace, activate that
  panel and do nothing else** (the existing dock reconciliation would otherwise add
  a second row for one subshell — regression #13). Otherwise
  `handleAdd(id, "right")` — the exact path the "Add subshell" dialog and drop
  handler already share (§ the dock's `handleAdd`).
- A `TerminalDropOverlay`-style dashed outline ("Drop to add this subshell") shows
  while `dragOver`; cleared on `onDrop` and `onDragLeave`. The leave-detection uses
  an enter/leave depth counter (or `currentTarget.contains(relatedTarget)`) so
  crossing child boundaries inside the dock doesn't flicker the overlay.

Duplicate detection uses the dock's live `detail.panes` (each row's `subshellId`),
which is authoritative and already in hand — no extra fetch.

### 5d. Target 2 — a workspace card in `/workspaces`

`routes/workspaces.tsx` gives each `EntityCard` a drop wrapper with the same gated
handlers and a highlight. On drop it attaches the subshell to *that* workspace
without opening it:

- It cannot reuse `detail.panes` (the grid only has `WorkspaceRow` with a count), so
  the drop handler first `GET /api/workspaces/:id` — one fresh request per drop, the
  authoritative duplicate check — and if any pane already holds that subshell it
  posts the transient note "Already on this workspace" instead of creating a second
  row for one subshell (the server does NOT dedupe; duplicates are the regression
  #13 class). Otherwise it proceeds to `POST /api/workspaces/:id/panes`.
- On success: `useInvalidateWorkspaces()` so the card's subshell count updates, and
  the transient note "Added to ‹workspace›". Transient notes are one page-level
  state string cleared by a ~4 s timer (the page has no toast system).
  Errors surface through the page's existing inline error line.

`EntityCard` gains an optional `className` (forwarded to its root `div`) so the drop
wrapper can render the same highlight the subshell cards use, without changing its
link/menu structure.

## 6. Keeping the dots honest — SSE feed at the app root

Today `useLiveSubshells` mounts the `/api/events` EventSource **only on the home
page**; the sidebar's `useSubshellsList()` sees a fresh list only on navigation or
mutation. A dot on the Workspace page would otherwise show last-visit truth.

Refactor, preserving the existing SSE mechanics verbatim (single-use ws-token auth,
30s TTL, bounded-backoff reconnect on token death, REST fallback):

- **New** `hooks/use-live-subshells-feed.tsx` — a provider mounted in `__root.tsx`'s
  `Shell`, **signed-in only** (`{user && <LiveSubshellsFeedProvider>…}`, the same
  gate the `EmergencyLoginBanner` uses, so the token POST never fires pre-auth or on
  `/login`). It owns the EventSource exactly as `useLiveSubshells` does today, and on
  each frame does two things:
  1. `queryClient.setQueryData(SUBSHELLS_QUERY_KEY, parsedList)` — the **one new
     line** that makes the shared cache live everywhere. The sidebar, the add-dialog
     pickers, and the home page (once it reads the cache) all update together.
  2. Exposes `connected` + `lastList` through context for consumers that need them.
- **`useLiveSubshells`** is reduced to a thin consumer of that context (returns
  `{ subshells, connected, isLoading, isError, refetch }` with the same shape), so
  `routes/index.tsx` and `live-status.tsx` are unchanged. `subshells` reads
  `context.lastList ?? rest.data ?? []`, keeping the "stream has spoken → not an
  error" logic intact.
- The sidebar and dot need no changes for freshness — they already read
  `SUBSHELLS_QUERY_KEY`, which the feed now writes.

The connection runs once for the whole signed-in session (was: once per home-page
visit). `EventSource` is a single long-lived socket; this is the same count of
sockets, just not tied to the home route.

## 7. File map

```
apps/frontend/src/
├── lib/
│   ├── subshell-indicator.ts        # NEW  pure state precedence + labels
│   ├── sidebar-recents.ts           # EDIT RECENT_LIMIT 3→8
│   ├── subshell-dnd.ts              # NEW  drag payload encode/read
│   └── workspace-name.ts            # NEW  defaultWorkspaceName (extracted)
├── hooks/
│   └── use-live-subshells-feed.tsx  # NEW  root provider (SSE → cache + context)
│                                    #      useLiveSubshells.ts reduced to a consumer
├── components/
│   ├── app-sidebar.tsx              # EDIT  + quick-add buttons, search, dots
│   ├── subshell-card.tsx            # EDIT  accessoryFor/ACTIVITY_LABEL → shared fn
│   ├── entity-card.tsx              # EDIT  + optional className
│   └── sidebar/
│       ├── SubshellDot.tsx          # NEW  the 6px state dot
│       ├── SubshellRecentRow.tsx    # NEW  Link + dot + menu + drag source
│       ├── LaunchSubshellDialog.tsx # NEW  wraps NewSubshellForm
│       ├── NewWorkspaceDialog.tsx   # NEW  create + seed panes
│       └── __tests__/               # NEW  dialog + indicator/dnd/recents tests
├── components/subshell-picker/
│   └── existing-subshell-list.tsx   # EDIT  + optional checkbox/multi-select mode
├── components/workspace-dock.tsx    # EDIT  + drop target (activate-if-present / addPane)
├── routes/
│   ├── __root.tsx                   # EDIT  mount feed provider (signed-in)
│   ├── workspaces.tsx               # EDIT  open dialog + card drop target
│   └── index.tsx                    # (unchanged — still uses useLiveSubshells)
```

## 8. Testing

Pure functions (no DOM):
- `subshell-indicator` — the full precedence matrix: nodeOffline beats all; exited
  beats waiting; waiting beats activity; terminated/idle/active pass through.
- `subshell-dnd` — `readSubshellDrag` returns the id for our type, `null` for a
  `Files`-only transfer (proves the guard that leaves terminal uploads alone).
- `sidebar-recents` — truncation at the new limit 8.

Component tests (`__tests__/`, happy-dom):
- `LaunchSubshellDialog` — renders `NewSubshellForm`; submit gated by `canSubmit`.
- `NewWorkspaceDialog` — multi-select toggling; **create-with-zero-subshells** still
  creates an empty workspace; partial pane-failure path shows the "couldn't add N /
  Enter workspace" branch (mock the pane POST to fail one).
- `ExistingSubshellList` — checkbox mode toggles `selected`; single mode (no
  `selected` prop) still calls `onAdd` on click (regression guard for the add-dialog).
- `SubshellDot` — one case per state asserting the mapped class.

Manual verification (documented in the plan; `bun run test` can't drive it):
- SSE live: on the Workspace page, terminate a subshell elsewhere → the sidebar dot
  changes without a reload.
- Drag from sidebar → dock: attaches once; dragging a session already present
  activates its existing pane, does not duplicate.
- Drag from sidebar → workspace card: count increments; dropping a session already
  on that card shows "Already on this workspace" and creates no row.
- Drag a **file** onto a terminal still uploads (proves the MIME gate).
- Drag a dock tab to split still works (proves we didn't shadow dockview's drags).
- `bun run verify-types && bun run lint:check && bun run test` green.

## 9. Security / scope notes

- No new endpoints, no new credential paths — reuses session-cookie REST already
  defined for workspace pane add and subshell launch.
- Search filtering is display-only over an already server-visibility-filtered list
  (same note the existing picker carries); it never substitutes for authz.
- The new-workspace dialog and dock drop are cookie-actor surfaces like every other
  workspace mutation (`requireCookieActor` on the routes) — bearer keys remain
  refused on pane management, unchanged.

## 10. Open follow-ups (not in scope)

- Workspace-side search if workspace counts outgrow 8.
- Touch "add to workspace" affordance for phone users who can't drag (the dialogs
  already cover creation; a long-press-to-attach could join them later).
