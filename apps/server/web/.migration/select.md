# select

2026-08-30, transformation engine. Verdict: migrated (with consumer fixes —
this family had the largest call-site surface).

## Changed

- `src/components/ui/select.tsx` — `@radix-ui/react-select` -> `Select` from
  `@base-ui/react/select`. Content split into `Portal > Positioner > Popup >
  List` (Radix `Viewport` -> `List`); positioning props destructured and
  forwarded to the **Positioner** (declare -> destructure -> forward rule).
  - The wrapper keeps its Radix-era `position?: "popper" | "item-aligned"`
    API, translated internally to `alignItemWithTrigger` (popper -> false +
    `sideOffset ?? 4` + `align="start"` to match Radix defaults).
  - Trigger-width parity (`--radix-select-trigger-width` on the viewport) ->
    `min-w-[var(--anchor-width)]` on the Popup in popper mode; the old
    `translate-y-1` + `h-[var(--radix-select-trigger-height)]` hacks are
    gone (the Positioner's sideOffset replaces them).
  - Item highlight: `focus:bg-accent` -> `data-highlighted:bg-accent`;
    `data-[disabled]:` -> `data-disabled:`; `Icon asChild` -> `render`.
- **Consumer value-label fix (Base UI renders the RAW value in `Value`)** —
  three roots whose labels differ from values now pass `items` maps:
  - `components/profile-fields.tsx` (harness select; label mirrors the
    "— not installed" suffix),
  - `components/session-picker/new-session-form.tsx` and `routes/new.tsx`
    ("{name} ({harnessId})" — the exact string e2e specs 05/06/08 assert).
- **Consumer null-widening**: Base UI's `onValueChange` receives
  `Value | null`; `profile-fields.tsx`, `new-session-form.tsx`, `new.tsx`
  guard `!== null` (these selects can never clear). `routes/users.tsx`
  (`v as "admin" | "user"`) already casts and needed no change; its
  values equal their labels so it needs no `items`.
- Leftover scan clean on all touched files.

## Left alone

- `session-picker/direction-split.tsx`'s segmented buttons — not a Select.

## Behavior changes

- Typeahead still works (Base UI derives it from `ItemText`; the old Radix
  `textValue` prop was never passed).
- Base UI auto-falls back from item-aligned to flip positioning on touch
  input when space is short — popper mode unaffected.
- No scroll up/down arrows existed before and none added; a long profile
  list relies on `max-h-96 overflow` clipping exactly as before (flag, same
  as pre-migration).

## Verify by hand

- New session page: choose a profile -> the trigger shows "Default (pi)",
  the panel opens under the trigger at full trigger width, keyboard up/down
  + Enter select, Escape closes and returns focus.
- Profile editor: harness select shows "not installed" suffix in both the
  panel and the collapsed trigger; switching harness keeps lock behavior.
