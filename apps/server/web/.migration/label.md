# label

2026-08-30, transformation engine. Verdict: migrated (native `<label>` —
Base UI has no standalone Label primitive, per the skill's
no-counterpart table).

## Changed

- `src/components/ui/label.tsx` — `@radix-ui/react-label` Root replaced by a
  plain `<label>`; classes unchanged; `forwardRef` dropped (no consumer uses
  a Label ref). One `biome-ignore lint/a11y/noLabelWithoutControl` added:
  the rule statically inspects JSX attributes and cannot see `htmlFor`
  arriving through the props spread.
- No consumer changes: all 20-odd `<Label htmlFor=...>` call sites are plain
  HTML semantics that survive untouched.

## Left alone

- `src/routes/users.tsx` `<Label aria-hidden className="invisible">` (a
  decorative spacer label) — kept exactly as-is; it had no `htmlFor` before
  the migration either (Radix's opaque component node bypassed the a11y
  lint). Flagged, not fixed.

## Behavior changes

- None.

## Verify by hand

- Login page: clicking "Password" focuses the password field.
- Settings: switch labels toggle their switch on click.
