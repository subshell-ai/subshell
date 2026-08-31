# button

2026-08-30, transformation engine (no components.json in this repo — style
unattributed, so the project's own classes are the source of truth). Verdict:
migrated.

## Changed

- `src/components/ui/button.tsx` — `@radix-ui/react-slot` + `forwardRef` +
  `asChild` replaced by `Button as ButtonPrimitive` from
  `@base-ui/react/button` (per the skill's hard rule: real Button primitive,
  never a hand-rolled useRender wrapper). cva variant/size classes kept
  byte-identical. `ButtonProps` is now `ButtonPrimitive.Props & VariantProps`.
- `src/routes/bookmarks_.$id.tsx:39`, `src/routes/profiles_.$id.tsx:39`,
  `src/routes/workspaces_.$id.tsx:52` — the only three `asChild` call sites:
  `<Button asChild><Link/></Button>` -> `<Button render={<Link/>} />`.
- Leftover scan clean: `grep -n "radix-ui|@radix-ui|asChild|IconPlaceholder"`
  on these four files returns nothing.

## Left alone

- `@radix-ui/react-slot` stays in package.json until the LAST radix wrapper
  is migrated (coexistence is fine); the dependency is removed project-wide
  at the end.
- `disabled:pointer-events-none disabled:opacity-50` kept: the Base UI Button
  renders a real `<button>`, so `disabled:` variants stay live.

## Behavior changes

- None expected. `focusableWhenDisabled` is a new opt-in prop, unused.
- Dropped `forwardRef` wrapper: ref is passed through props spread (React 19);
  no call site used a Button ref (grep-verified).

## Verify by hand

- Any page: buttons render identically (variants ghost/outline/destructive).
- A session card (whole card is a link) and the "Back to bookmarks/profiles/
  workspaces" buttons: clicking follows the route, keyboard focus ring shows.
- Disabled button (e.g. Add user while busy): greyed, not clickable.
