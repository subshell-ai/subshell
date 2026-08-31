# Radix -> Base UI: whole-project migration

2026-08-30, transformation engine (no components.json in the repo, so no CLI
golden pairs; every file transformed from its own classes + the skill's
reference tables). Verdict: complete — zero Radix imports remain.

## Changed

Per-component detail lives in the sibling files (`button.md`, `label.md`,
`switch.md`, `tabs.md`, `dialog.md`, `dropdown-menu.md`, `select.md`).

- Dependency swap: added `@base-ui/react` 1.7.0 (pinned); removed
  `@radix-ui/react-{avatar,checkbox,dialog,dropdown-menu,label,select,slot,
  switch,tabs}`. Avatar and checkbox were already unused (dead deps) and
  removed with the rest; `tabs` was dead *code* (deleted wrapper, see
  `tabs.md`).
- App-code sweep (beyond the wrappers themselves): `asChild` -> `render` at
  the 5 call sites (3 route "Back" buttons, 2 dropdown triggers);
  `focus:` -> `data-highlighted:` item styling (actions-menu destructive
  class); Select `items` maps + `Value | null` guards at 3 roots;
  one `biome-ignore` on the native-label wrapper.
- Remaining Radix mentions in src are prose only (comments/jSDoc describing
  the migration), verified by `grep -rn "@radix-ui" src` = 0 hits.

## Left alone

- No cmdk/vaul/sonner/input-otp/react-day-picker/recharts wrappers exist in
  this project — the skill's hard-rule exemption list is moot here.
- `dockview-react`, xterm, TanStack: not primitive libraries, untouched.

## Behavior changes (rolled up — details per component report)

- Menu arrow-key navigation loops by default (`loopFocus` true).
- Menu/Select items highlight via `data-highlighted`, never DOM focus.
- Select trigger prints labels only because the 3 label-bearing roots now
  pass `items` — a new Select whose label differs from its value needs one.
- Dialog focus-on-open target can differ subtly (X-button-first popups).

## Verify

- `bunx tsc --noEmit` clean in @internal/frontend; frontend `bun test`
  (115) green at every component step; root `bun run verify-types` +
  `lint:check` + `bun run test` green (see final run below); full Playwright
  e2e suite (10 specs, real browser: wizard Selects, dialogs, actions
  menus, session lifecycle) green.

## Manual QA still worth a minute (desktop)

- New session end-to-end via the /new page (Select open/pick/placeholder).
- Terminate-from-card confirm dialog (focus return + reload button).
- ⋯ menus everywhere, especially inside clickable cards (click must not
  navigate the card behind).
