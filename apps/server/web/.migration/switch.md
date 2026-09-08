# switch

2026-08-30, transformation engine. Verdict: migrated (1:1 part mapping).

## Changed

- `src/components/ui/switch.tsx` — `@radix-ui/react-switch` ->
  `Switch as SwitchPrimitive` from `@base-ui/react/switch` (Root + Thumb).
  Class rewrites per the class-mapping tables: `data-[state=checked]:` ->
  `data-checked:`, `data-[state=unchecked]:` -> `data-unchecked:`, and
  `disabled:*` -> `data-disabled:*` because Base UI's Root renders a `<span>`,
  making the `disabled:` variant dead code (skill rule: never copy the
  upstream quirk of leaving both).
- Consumer scan: 5 call sites (`system-api-keys-card.tsx:112`,
  `profile-fields.tsx:167`, `setup.tsx:245`, `settings.tsx:122`,
  `settings.tsx:159`) all pass a boolean `checked` + single-arg
  `onCheckedChange`; Base UI's callback only widens (event-details second
  arg), so zero consumer edits.
- Leftover scan clean: `grep -n "radix-ui|@radix-ui"` on this component's
  files returns nothing.

## Left alone

- None.

## Behavior changes

- Base UI's `onCheckedChange` gains an event-details argument (ignored by all
  call sites). Space/Enter keyboard activation is preserved by the primitive.

## Verify by hand

- Settings: "Allow new registrations" toggles instantly; harness allowlist
  switches save per harness (harness allowlist is disabled while the page is
  unsaved — check greyed state).
- System API keys: enable/disable switch flips a key's state chip.
