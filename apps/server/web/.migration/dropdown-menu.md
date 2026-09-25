# dropdown-menu

2026-08-30, transformation engine. Verdict: migrated (+dead exports dropped).

## Changed

- `src/components/ui/dropdown-menu.tsx`: `@radix-ui/react-dropdown-menu` ->
  `Menu` from `@base-ui/react/menu`. Content became `Portal > Positioner >
  Popup` with `side/sideOffset/align/alignOffset` destructured and forwarded
  to the **Positioner** (the forward-rule; `sideOffset = 4` default
  preserved). Animations: Radix fade keyframes -> `transition-opacity` +
  `data-starting-style`/`data-ending-style`. Item highlight:
  `focus:bg-accent focus:text-accent-foreground` ->
  `data-highlighted:bg-accent data-highlighted:text-accent-foreground`
  (Base UI items are divs; highlight is the state hook). `data-[disabled]:`
  -> `data-disabled:` (attribute presence, same name).
- **API decision:** the wrapper keeps an `onSelect?: () => void` prop (used by
  ~15 app call sites and the app-level `ActionItem` vocabulary) forwarded to
  Base UI's `onClick`; `closeOnClick` defaults true, matching Radix's
  close-on-select. A custom `onClick` still composes (wrapper calls it too).
- Dead exports dropped instead of ported (zero consumers, grep-verified):
  `DropdownMenuPortal`, `DropdownMenuSub`, `DropdownMenuSubTrigger`,
  `DropdownMenuSubContent`, and the unused `ChevronRight` import.
- `src/components/actions-menu.tsx`: trigger `asChild` -> `render={<Button/>}`
  (children move outside render); destructive item class
  `focus:text-destructive` -> `data-highlighted:text-destructive`.
- `src/components/working-dir-field.tsx:139`: trigger `asChild` ->
  `render={<Button>…</Button>}`.
- Tests: `actions-menu.test.tsx` passes unmodified (open, click-through,
  close-unmount, destructive class, disabled trigger).
- Leftover scan clean on all three files + consumers.

## Left alone

- Six `<DropdownMenu>` consumer files besides the two triggers: their JSX
  (Content align/className, Item onSelect, Separator) is API-compatible.

## Behavior changes

- Keyboard arrow navigation now **loops** by default (Base `loopFocus`
  default true vs Radix `loop` false). Harmless in short menus; flagged.
- Items no longer take DOM `:focus` while navigating (roving highlight via
  `data-highlighted`); any future `focus:` classes on items would be dead.
- collisionPadding 0 -> 5, arrowPadding n/a (no arrow part used).

## Verify by hand

- Sessions list: Actions (⋯) opens left-aligned to the right edge, items
  highlight on hover/arrow-keys, click runs the action and closes; clicking
  the trigger inside a card does NOT navigate the card.
- New session page: bookmark trigger shows filled/unfilled icon, the
  scrollable bookmark list (`max-h-72`) picks working dirs and saves.
- Escape and outside-click close every menu; focus returns to the trigger.
