# Phone session header: two-line title/subtitle + menu-driven rename + title validation

Date: 2026-09-02
Status: approved (user delegated remaining choices to the implementer)
Surface: `apps/frontend` (responsive web shell, used as a PWA on phones). No
`apps/mobile` (RN) changes — the RN detail header already has Rename +
`PromptModal` and shows no path.

## Problem

On a phone the session detail page's one-row `DetailBackHeader` crams the
hamburger, back button, click-to-rename title, workingDir, status badge, ⋯
menu, and (when open) the transcript search into a single flex row. The title
truncates to a few characters — unreadable — and the workingDir is
`hidden sm:inline`, i.e. invisible below 640px. There is also no way to rename
from the ⋯ menu or from a list card/row; renaming requires finding and tapping
the tiny inline title.

Title inputs across the app also lack client-side validation: the backend
rejects blank-after-trim and >120-char session names (nodes: 64), but the web
inputs neither cap length nor explain a rejected save before the round-trip.

## Decisions

- Two-row header **below the tiling breakpoint only** (`useIsWide()`,
  `WORKSPACE_TILING_MIN_WIDTH` = 1024px — the same signal `MobileNav` keys
  off; no hardcoded breakpoint in class strings). Wide screens keep today's
  one-row layout.
- On phones the row-2 title is **display-only**; editing moves to an
  **Edit title** item in the (shared) `SessionActionsMenu`, which opens a
  modal. Desktop keeps inline click-to-edit AND gains the menu item.
- Validation lives in the shared pieces (`EditableText` + the new dialog) so
  every name surface inherits it in one pass.

## Design

### 1. `DetailBackHeader` — optional `subtitle` + narrow-screen reflow

`apps/frontend/src/components/detail-back-header.tsx` gains
`subtitle?: ReactNode` and calls `useIsWide()`:

- **Wide:** unchanged one-row layout; `subtitle` renders inline after the
  title (muted, `text-xs`, truncating) — replacing the `hidden sm:inline`
  span the session route spells out today. The path becomes visible at every
  size.
- **Narrow:** the header stacks. Row 1: `MobileNav`, back button, then
  badges/actions right-aligned. Then the title (`truncate`, `min-w-0`,
  `text-sm font-medium`) with the subtitle (`text-xs`, muted, one line,
  `truncate`, `min-w-0`) on its **own line under the title** — even alone,
  title + path don't fit a phone width readably.

Callers:

- `routes/sessions_.$id.tsx`: passes `subtitle={session?.workingDir}`. The
  `title` becomes plain display text below the wide breakpoint (same string +
  placeholder behavior as `EditableText`'s display state) and stays the
  `EditableText` at/above it — the route already has the hook available; the
  two `useIsWide()` consumers read the same media query.
- `workspace-header.tsx`: no `subtitle`; on phones its name drops to row 2
  automatically. Inline editing stays as today (title-only row 2; the phone
  workspace row has no competing actions on that row).

### 2. `TitleDialog` + "Edit title" menu item

`components/ui/title-dialog.tsx`, modeled on `notes-dialog.tsx`: controlled
by `open`/`onOpenChange` (no own trigger), mounted keyed by session id so each
session gets a fresh draft. Single-line `Input`, `autoFocus`, prefilled with
the current name. Save PATCHes `/api/sessions/:id/name` with `{ name }`
(saving pins the name — same as the inline rename; "Resume auto title" stays
the way back) and on success invalidates the session, the sessions list, and
workspace panes (pane titles carry the session name — same trio as the
session page's `saveName`), then closes.

`components/session-actions-menu.tsx`: in the `canEdit` block, an item
**Edit title** (lucide `Pencil` or `TextCursorInput`) opening the dialog.
Because the menu is shared, the session page header, tiled cards, and manager
rows all gain quick-rename (cards/rows have no rename affordance today).

### 3. Validation (mirrors the backend, before the round-trip)

Backend rules: session/workspace name = 1–120 chars after trim; node name =
1–64. Client rules, one set:

- `EditableText` gains `maxLength?: number` (default **120**;
  `routes/nodes_.$id.tsx` passes **64**):
  - the editing `Input` gets the `maxLength` attribute (caps typing);
  - commit trims, then rejects blank with the inline error "A name is
    required" (today a blank commit silently reverts — now it says why) and
    over-length with "Keep it under N characters"; no request is sent.
- `TitleDialog`: Save disabled while the draft is blank or unchanged;
  inline errors "A title is required" / "Keep it under 120 characters";
  server rejections surface in the same slot.
- New-session form (`session-picker/new-session-form.tsx`): `maxLength={120}`
  on the optional-name input. Trim-and-omit-on-blank already happens in
  `use-create-session.ts:toSessionCreateBody` — unchanged.

### 4. Error handling

Server errors in the dialog reuse the `NotesDialog` posture: the mutation
stays open and shows `err.message` under the input. `EditableText` keeps its
existing behavior (rejection leaves the input open with the error; blur does
not silently retry while an error is shown).

## Testing

Component/lib tests beside the code (`__tests__/`, happy-dom; `test-setup.ts`
already stubs `matchMedia`):

- `title-dialog`: blank draft blocks save; >120 blocked (and input capped);
  unchanged draft disables Save; valid save PATCHes once with the trimmed
  name and closes.
- `editable-text` (extend the existing suite): over-max shows the inline
  error without calling `onSave`; blank commit shows "A name is required"
  instead of silently reverting; `maxLength` reaches the input attribute.
- `session-actions-menu` (extend): "Edit title" present for `edit`/`owner`,
  absent for `view`.
- `detail-back-header`: narrow renders the two-row structure (title row
  contains title + subtitle); wide renders one row with subtitle inline.

Manual: devtools phone viewport (~400px) on the session page — title + path
legible on row 2, ⋯ menu → Edit title round-trip, workspace page header
reflow. Full `bun run verify-types && bun run lint:check && bun run test`.

## Out of scope

- RN app header/path display.
- Workspace header's rename UX (stays inline-only; the reflow is inherited).
- Any backend schema change (the rules already exist server-side).
