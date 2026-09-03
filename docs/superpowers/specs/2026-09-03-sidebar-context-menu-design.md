# Sidebar right-click context menus for recent subshells & workspaces

**Date:** 2026-09-03
**Status:** Approved design, pre-implementation

## Summary

Right-clicking a "recent" row under **Subshells** or **Workspaces** in the sidebar
opens the same actions menu the entity's triple-dot (⋯) button offers — anchored at
the cursor, desktop-native feel. Left-click behavior is unchanged: only navigation.
The rule for the whole spec is **no second menu definition**: the sidebar reaches the
actions through the exact components the ⋯ surface uses today.

## 1. Mechanism — Base UI's native `ContextMenu`

`@base-ui/react` 1.7.0 ships `ContextMenu.Root` + `ContextMenu.Trigger` whose
popup parts (`Portal/Positioner/Popup/Item`) are **the same components** the app's
`ui/dropdown-menu.tsx` wrapper already exports (verified against the installed
package: `context-menu/index.parts` re-exports the `Menu.*` parts). Cursor
anchoring, Escape/outside-close, and focus handling are Base UI's job — no custom
position code.

`components/actions-menu.tsx` gains a **context mode**:

- The `ActionItem[] → <Menu.Item>` mapping is extracted into an internal shared
  renderer used by both modes (and any future menu flavour) so the item look
  (icons, destructive red, disabled grey, 44 px targets) lives in one place.
- `ActionsMenu` gains optional `children: ReactNode`. With no children — the
  current 7 call sites — it renders exactly today's ⋯ button trigger. With
  children it renders `ContextMenu.Root` wrapping them in `ContextMenu.Trigger`
  (composed via the repo's `render`/`className` idiom) plus the same
  `DropdownMenuContent`/`DropdownMenuItem` internals.
- The `disabled` semantics carry over (trigger inert while a bulk action runs).

## 2. Entity menus accept wrapping instead of triggering

**`SubshellActionsMenu`** gains `children?: ReactNode`, forwarded to `ActionsMenu`.
The action list, dialogs (title/notes/replay/share/clone), access rules, and
mutation hooks stay exactly where they are — sidebar use imports the same
component. Access-rule detail: a `view` grantee currently gets `null` (no actions);
in children mode that becomes **the plain children, unwrapped** — the row renders,
right-click does nothing (the browser default is NOT re-suppressed for them since
there is nothing to show… it is suppressed anyway, see §3 note).

**New `WorkspaceActionsMenu`** (`components/workspace-actions-menu.tsx`) — the
workspace's three actions, today inline in `routes/workspaces.tsx` (Open, Open in
new tab, Delete with the destructive `confirmAction` prompt), extracted:

- Owns: the item list, the confirm dialog, `DELETE /api/workspaces/:id`, and
  `useInvalidateWorkspaces()` so every surface refreshes.
- Gains `children?: ReactNode` for the same trigger/context duality.
- On a failing delete it surfaces errors through an optional `onError(message)`
  callback: `workspaces.tsx` passes its existing banner setter; the sidebar passes
  nothing (a sidebar delete failing is rare — the row simply remains; the list
  invalidates regardless), matching the app's no-toast reality.
- `routes/workspaces.tsx` replaces its inline `items={[…]}` with the extracted
  component (via `EntityCard`'s existing `menu` slot) — page behavior unchanged,
  definition now single-sourced.

## 3. Sidebar wiring (`app-sidebar.tsx`)

The recents sub-lists already map over `recentSubshellLinks(subshells)` /
`recentWorkspaceLinks(workspaces)` projections; the **full entities** are in the
same queries the sidebar already holds. Each recent row becomes:

```tsx
<SubshellActionsMenu key={r.id} subshell={fullSubshell} onDeleted={…}>
  <Link …existing classes…>{…}</Link>
</SubshellActionsMenu>
```

(and the `WorkspaceActionsMenu` equivalent). Lookup: `subshells?.find(s => s.id ===
r.id)` beside the existing projection — if the entity vanished between renders,
render the plain link. `ContextMenu.Trigger` wraps the Link element itself (no extra
DOM inside the row, zero visual change); the browser's default context menu is
suppressed on these rows whether or not a menu opens (a half-working right-click is
worse than none).

Collapsed rail: recents are only rendered while expanded — nothing to do. Mobile
drawer (`forceExpanded`): gets the same wiring; touch devices never fire
`contextmenu`, so behavior is unchanged there.

## 4. Testing

- **Component (`components/__tests__/actions-menu.test.tsx`)**: children mode
  renders the wrapped element unchanged; `fireEvent.contextMenu` opens the menu and
  the item labels appear; `view`-access `SubshellActionsMenu` in children mode
  renders its children and no menu opens.
- **Component (workspace menu)**: rendered via children mode, right-click shows
  Open / Open in new tab / Delete; Delete still asks the `confirmAction` question
  before calling the API (fetch-mock asserts the DELETE only after confirm).
- **Sidebar regression**: existing sidebar tests (nav icons, recents) keep passing;
  a row whose full entity is missing renders a plain link.
- **Verification trio** (`verify-types`, `lint:check`, `test`) + live check on the
  :5174 dev server: right-click both kinds of recent rows, run one harmless action
  (e.g. "Edit title" dialog open/close), confirm left-click still navigates.

## 5. Out of scope

- Context menus on nav items (Subshells/Workspaces headers), nodes, profiles rows.
- Touch/long-press menus.
- A toast system for sidebar mutation failures.

## Amendment (2026-09-03, live review)

Two changes after using the first cut:

1. **The sidebar menu is a curated subset, not the full page menu.** An
   `ActionItem` gains `sidebar?: boolean` — each item declares, at its single
   definition site, whether the compact sidebar surface shows it. Children
   (context) mode filters by it; the ⋯ menus are untouched. The sidebar keeps
   the **lifecycle + delete** actions: subshell → Terminate / Restart / Start
   again (the existing state-dependent pair) and Delete subshell (owner);
   workspace → Open in new tab and Delete workspace ("Open" drops — the row
   *is* the link). Dialog-flavoured items (Edit title, Add note, Pin, Terminal
   history, Clone, Share, Edit profile) stay where the dialogs have room to
   breathe: the cards and the detail page.
2. **Anchored to the row, not the cursor.** The menu opens to the RIGHT of the
   row, top-aligned with it (`side="right"`, `align="start"`, small offset) —
   the same place for every right-click within a row, Finder-style, with the
   row itself left visible. Mechanically: the context-mode trigger host is a
   real `block` box (was `display:contents`, which has no box to anchor to)
   whose ref is passed to Base UI's Positioner `anchor` prop, overriding the
   context menu's default virtual-cursor anchor.
