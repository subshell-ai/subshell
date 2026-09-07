# dialog

2026-08-30, transformation engine. Verdict: migrated.

## Changed

- `src/components/ui/dialog.tsx` — `@radix-ui/react-dialog` ->
  `Dialog as DialogPrimitive` from `@base-ui/react/dialog`.
  Part mapping Overlay->`Backdrop`, Content->`Popup` (centered modal: NO
  Positioner, per the overlays reference), rest 1:1. All exported wrapper
  names unchanged (`Dialog`, `DialogTrigger`, `DialogClose`, `DialogPortal`,
  `DialogOverlay`, `DialogContent`, `DialogHeader/Footer/Title/Description`).
  - Animations restated from Radix keyframe classes to
    `transition-[opacity(,scale)] duration-150` +
    `data-starting-style:`/`data-ending-style:` (class-mapping idiom).
  - `forwardRef` dropped: zero consumers pass refs (grep-verified); the
    sr-only "Close" span replaced by `aria-label="Close"` on the X button
    (AccessibleIcon -> aria-label pattern).
  - `DialogPrimitive.Portal` renders a wrapper `<div>` (Radix rendered
    nothing extra) — harmless; consumers style via Popup/Backdrop only.
- Consumers: **zero edits needed.** All four (`confirm-dialog.tsx`,
  `notes-dialog.tsx`, `add-session-dialog.tsx`, `system-api-keys-card.tsx`)
  use only `Dialog open + single-arg onOpenChange` and content parts —
  Base UI's callback only widens (event-details second arg). No consumer used
  `onOpenAutoFocus`/`onEscapeKeyDown`/`forceMount`/`DialogTrigger`/
  `DialogPortal` directly (grep: zero hits outside the wrapper).
- Tests: `confirm-dialog.test.tsx` passes unmodified against Base UI under
  happy-dom; typecheck clean.
- Caught post-commit by e2e (spec 05): the first cut used
  `-translate-x-[-50%]` (double negative -> `calc(-50% * -1)` = +50%, dialog
  pushed off-viewport). Fixed to the original `translate-x-[-50%]` form.
  Lesson: happy-dom unit tests cannot see geometry; overlay positioning
  changes need the Playwright run.
- Leftover scan clean: `grep -n "radix-ui|@radix-ui|asChild|data-\[state"`
  on dialog.tsx and its consumers returns nothing.

## Left alone

- `notes-dialog.tsx`'s `onOpenChange: (open: boolean) => void` prop type —
  still exactly what its call sites pass; Base UI's wider signature is
  assignable to it.

## Behavior changes (flagged, not patched)

- Focus-on-open: Radix focuses the first focusable inside Content; Base UI
  does the same but the exact target for dialogs whose first tabbable is the
  X button may feel different (Base prefers the popup container when the
  first tabbable is a close button). No call site set `initialFocus`.
- Escape/outside-press dismissal now flows through `eventDetails.reason` —
  nobody consumed the per-interaction callbacks, so no behavior was lost.

## Verify by hand

- Terminate a session -> confirm dialog: opens, Cancel/confirm work, focus
  returns to the Actions button after close.
- System keys: "New system key" dialog saves; the one-time secret dialog
  copies and closes with the X.
- Edit notes dialog on a session card.
