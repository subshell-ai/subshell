# Standardize UI action menus (⋯) — design

**Date:** 2026-08-28
**Status:** Approved

## Problem

Entity actions are rendered inconsistently. Sessions already use a canonical
overflow menu (`SessionActionsMenu`, a `MoreHorizontal` trigger + `DropdownMenu`)
on their cards and list rows, but every other list surface shows loose, always
visible icon buttons — Edit/Delete pairs on bookmark and profile cards, Open/Delete
on workspace cards — and the session detail header duplicates `SessionActionsMenu`'s
actions as a state-branched block of loose buttons. All destructive confirmations
use the browser's native `window.confirm`, which is off-brand and inconsistent.

## Goal

One visual standard for per-entity actions on the main list pages and the session
detail header:

- The **card/row itself is the primary action** (click-through to the entity's
  natural destination).
- **All discrete actions live in a ⋯ menu** — nothing is a loose button anymore.
- **All confirmations are styled dialogs**, not `window.confirm`.

## Non-goals

- Workspace dock internals: group-header maximize/terminate buttons, tab `×`
  remove buttons, `session-pane`/`session-terminal` state panels. These are
  contextual chrome, not entity lists.
- The bulk-actions bar's button layout in `session-manager-table.tsx` (it is
  ephemeral and appears only on selection; only its confirmation moves to the
  styled dialog).
- Users/settings pages (no per-entity action buttons exist there).
- Adding confirmation gates where none exist today (pane removal, sidebar logout).

## Design

### 1. `ActionsMenu` primitive — `components/actions-menu.tsx`

Pure presentation; no data fetching.

```tsx
type ActionItem = {
  /** Menu item text */
  label: string;
  /** Leading lucide icon */
  icon: LucideIcon;
  /** Action handler. Navigation is the caller's job — `navigate(...)` or
      `window.open(...)` here — so route type-checking stays at the call
      site instead of behind a generic `to`/`params` the menu can't verify. */
  onSelect?: () => void;
  /** Red destructive styling */
  destructive?: boolean;
};

ActionsMenu({ label, items, disabled? })
```

Absorbs everything `SessionActionsMenu` currently hard-codes about look and feel:

- `MoreHorizontal` ghost-icon trigger, `h-7 w-7`, `aria-label="Actions for {label}"`
- Destructive item styling (`text-destructive focus:text-destructive`)
- `stopPropagation` on trigger and content so menus inside clickable cards
  don't navigate

(An earlier draft had the `afterClose` setTimeout deferral; it became obsolete
once confirms stopped blocking the main thread, and the styled dialog made the
`SessionActionsMenu` `afterClose` workaround unnecessary.)

**`EntityCard` (components/entity-card.tsx).** The three list routes copy the
same card shell — relative wrapper, whole-card `Link` as the primary action,
hover-styled `Card`, `pr-7` title inset, and the absolutely-positioned menu
outside the link — so the shell is one component:
`<EntityCard to params title description items accessory? children? />`.
`session-card` keeps its bespoke layout (live terminal preview) and is not
folded in.

`SessionActionsMenu` is refactored on top of the primitive. The lifecycle
mutations move down into `hooks/use-session-mutations.ts` — endpoints, shared
confirmations, and cache refresh in one place — consumed by the menu and by
the session page's exited-state panel; callers only supply what a restart or
delete *means* locally (a refreshed grid, or navigation) via `onRestarted` /
`onDeleted`. This supersedes `hooks/use-session-actions.ts`, which is deleted.

### 2. Styled confirm — `components/ui/confirm-dialog.tsx` + `lib/confirm.ts`

Promise-based replacement for `window.confirm`:

- `ConfirmProvider` mounted once in `__root.tsx`, rendering a single Radix
  `Dialog` built from the existing `dialog.tsx` + `button.tsx` primitives
  (destructive button variant when `danger: true`).
- `confirmAction({ title, description, confirmLabel?, danger? }): Promise<boolean>`
  — callable from anywhere (event handlers, mutation helpers), not just React
  components, so `workspace-dock.tsx` and the bulk bar adopt it without hooks.
- `lib/session-confirmations.ts` keeps `confirmTerminateSession` /
  `confirmDeleteSession` with their exact wording but becomes `async` and
  delegates to `confirmAction`. Adds `confirmRestartSession` for the restart
  prompt currently inlined in `use-session-actions.ts`. Call sites change from
  `if (confirmX(name))` to `if (await confirmX(name))`.

### 3. Per-surface changes

**`routes/bookmarks.tsx`**
- Rendered through `EntityCard` (card = `Link` to `/bookmarks/$id`).
- Edit/Delete icon pair deleted; menu items: **Edit** (onSelect → `navigate`),
  **Delete bookmark** (destructive; confirm keeps "The directory itself is
  untouched" wording, phrased inline in the route via `confirmAction`).
- `deleteBookmark` stays in the route; error display unchanged.

**`routes/profiles.tsx`**
- Identical shape: card → `/profiles/$id`; menu = **Edit** / **Delete profile**.
- Delete failures now surface in the page's existing error line (they used to
  fail silently).

**`routes/workspaces.tsx`**
- Card → `/workspaces/$id` (the old "Open").
- Menu = **Open** (onSelect → `navigate`), **Open in new tab**
  (onSelect → `window.open`), **Delete workspace** (destructive + confirm).

**`routes/sessions_.$id.tsx`**
- The state-branched Restart/Terminate/Delete button block is deleted and
  replaced with `<SessionActionsMenu session={session} onRestarted onDeleted />`.
  The header gains Add/Edit note for free.
- `use-session-actions.ts` is deleted; the page and `SessionActionsMenu`
  consume the same `useSessionMutations(id, session, { onRestarted, onDeleted })`,
  and the page's callbacks carry the navigation the old hook did (follow a
  restart to the new session, leave after a delete).
- Behavior change (accepted): the header no longer shows inline
  "Restarting…"/"Deleting…" labels; the menu closes on select and the status
  badge / exited panel provide feedback. The old `terminate()`'s
  `window.location.reload()` is gone — the shared hook refreshes both the
  `["sessions"]` list and the `["session"]` detail query instead. Restart now
  confirms everywhere via `confirmRestartSession` (the card menu previously
  restarted without asking).

**Query-key convention:** `use-profiles.ts` / `use-workspaces.ts` gained
`PROFILES_QUERY_KEY` / `WORKSPACES_QUERY_KEY` + `useInvalidate*` helpers,
mirroring the existing `use-bookmarks.ts` convention, replacing the routes'
`["profiles"]` / `["workspaces"]` string literals.

### 4. Confirmation call-site conversions

- `session-manager-table.tsx` bulk bar → new count-aware helpers in
  `lib/session-confirmations.ts` (`confirmTerminateSessions(n)` etc.), so bulk
  and singular wording live side by side; button layout unchanged.
- Restart confirmation lives in `useSessionMutations` (see above).
- `workspace-dock.tsx` keeps calling `confirmTerminateSession`/`confirmDeleteSession`,
  now awaiting them.
- Raw inline confirms in the three list routes are replaced by the new async
  helpers/menu logic.

### 5. Error handling

- Menu mutations keep current behavior: failures surface via the routes'
  existing error display or the mutation's silent refresh; no new error UX.
- `confirmAction` resolves `false` on dismiss/cancel/Escape — the same
  semantics as a dismissed `window.confirm`.

## Testing

The frontend had only pure-logic `bun test` files, so a component-test harness
was added: `@testing-library/react` + `@testing-library/dom` +
`@happy-dom/global-registrator` (pinned, then `syncpack fix` + `bun install`),
with `src/test-setup.ts` registering happy-dom globals (plus the
ResizeObserver / matchMedia stubs Radix needs) via a `bunfig.toml` preload —
under `src/` so both tsc and biome cover it.

- `components/__tests__/actions-menu.test.tsx` — trigger aria-label; items
  render; `onSelect` fires; destructive styling applied; `disabled` gates the
  trigger. (Dropped the link-item tests once link items left the API.)
- `components/__tests__/confirm-dialog.test.tsx` — resolves `true` on confirm,
  `false` on cancel/close; a second ask releases the first as cancelled.
- `lib/__tests__/confirm.test.ts` — fail-closed with no provider; options
  passed through; `setConfirmHandler` returns the previous handler.
- Full green: `bun run verify-types && bun run lint:check && bun run test`,
  plus a Chrome smoke pass (setup wizard → create/delete on each of bookmarks,
  profiles, workspaces, and a real session's terminate → start-again → delete
  header flow) with zero console errors.
