# Mobile Support: iPhone 15 Pro & iPad Pro 11"

**Date:** 2026-08-30
**Status:** Approved design (brainstorming complete, pending implementation plan)
**Author:** Theo + Claude (brainstorming session)

## 1. Problem

Mote is desktop-first. The content routes already stack cleanly (fluid grids,
single-column cards) and the workspace deliberately flips to tabs below 1024px
with 44px touch targets — but the shell assumes a wide screen. On a phone today:

- The persistent sidebar eats 224 of 393px on every page; the terminal page
  starts at ~169px of terminal until the user finds a 24px chevron.
- Five surfaces use `h-screen`/`min-h-screen` (100vh). iOS Safari's collapsing
  URL bar makes 100vh taller than the visible viewport, clipping the terminal
  bottom. No `dvh`, no `env(safe-area-inset-*)` anywhere.
- Dialogs have no `max-height`/scroll: the add-session dialog clips off-screen.
- The terminal has no way to reach Esc / Ctrl-C / arrows / Tab from a soft
  keyboard, and no reliable way to open the `/` command palette.
- `/users` create-form is a fixed 12-column grid (~57px fields at 393px).

Target devices (CSS px, verified against Apple specs and Playwright 1.62.1
descriptors):

| Device | Full screen | In Safari | Playwright descriptor |
|---|---|---|---|
| iPhone 15 Pro | 393×852 (1179×2556 @3x) | 393×659 | `iPhone 15 Pro` (393×659, touch) |
| iPad Pro 11" 4th gen | 834×1194 / 1194×834 (2388×1668 @2x) | same (no collapsing bar) | `iPad Pro 11`, `iPad Pro 11 landscape` |

Note the 2024 M4 iPad Pro 11" is 834×1210 — the extra 16px is irrelevant to
every decision here.

## 2. Decisions ratified during brainstorming

| # | Decision | Choice |
|---|----------|--------|
| 1 | Mobile intent | **Monitor + intervene**: full control of running sessions from a phone (read, reply, Esc/^C, terminate, dialogs); heavy authoring stays desktop-first but must not break |
| 2 | Terminal input | **Accessory key bar** (Esc · ^C · ⇧Tab · Tab · `/` · arrows) over the existing raw-byte `sendInput` path; not a compose-line, not plain-xterm |
| 3 | Install model | **Lightweight home-screen app**: static manifest + Apple meta + icons, `display: standalone`. **No service worker** — every screen needs the server |
| 4 | iPad role | **True multi-pane in landscape** (≥1024px keeps dockview, touch-polished); portrait uses the existing tab mode |
| 5 | Architecture | **Approach A — responsive shell pass on one component tree.** Rejected: `/m` route tree (a second nav surface forever; unnecessary since components already stack), CSS-only triage (drops the key bar, install model, iPad polish) |
| 6 | Breakpoint rule | One rule everywhere: **≥1024px desktop shell / <1024px mobile shell**, reusing `WORKSPACE_TILING_MIN_WIDTH` + `useIsWide()` so sidebar↔drawer and dock↔tabs flip together; iPad portrait gets both mobile behaviours for free |
| 7 | Libraries | Research-first, then native where it wins (see §8): adds **`@base-ui/react` (1.7.0)** and **`sharp` (dev)** only. **Primitive policy (Theo's call):** the installed tree is legacy Radix; *new* primitives go on **Base UI** — shadcn's current foundation — falling back to Radix only where Base UI has no equivalent. So the nav drawer (`sheet.tsx`) is built on `@base-ui/react` `Dialog`; existing Radix primitives stay untouched (migrating them is its own project). `vaul` rejected (its swipe-to-close adds nothing for a nav drawer), `vite-plugin-pwa` rejected (service-worker-centric), `usehooks-ts` rejected (repo hook already exists), npm has nothing for xterm key bars or keyboard-inset |
| 8 | Dialog scroll fix | Stays in the legacy Radix `dialog.tsx` — a class-only change, no new primitive involved, so the Base-UI policy doesn't bite |

## 3. Shell: drawer + mobile top bar

- New `components/ui/sheet.tsx`: a side sheet built on **Base UI's `Dialog`**
  (`@base-ui/react`, new dep) — `Root/Portal/Backdrop/Popup/Title/Close`,
  animated via `data-starting-style`/`data-ending-style`/`data-open`. It is the
  first primitive in the tree on Base UI per the policy in decision #7;
  swipe-to-close is not required for a nav drawer.
- `__root.tsx`: below 1024px, the drawer's hamburger (`MobileNav`) rides in
  the page's own header row where one exists — session detail and workspace
  detail embed it, so the nav costs no extra chrome row (a post-review pass
  dropped the sketched `MobileTopBar` "app title" and the bar itself on those
  pages: every row there is terminal/tab space). Pages without a header get a
  slim fallback bar (`MobileTopBar`) holding just the hamburger. The
  hamburger opens the sheet containing the **existing** `AppSidebar` forced
  expanded (collapse chevron hidden). Navigating closes the sheet.
- The sidebar's manual collapse chevron and localStorage persistence stay
  exactly as-is on desktop.
- Safe areas: the shell pads `padding-top: env(safe-area-inset-top)` (so the
  merged header rows clear the notch); the portaled sheet carries its own
  top/bottom insets; scrollable content gets
  `padding-bottom: env(safe-area-inset-bottom)`.

## 4. Viewport height & touch CSS

- Replace all five `h-screen`/`min-h-screen` usages with `h-dvh`/`min-h-dvh`
  (Tailwind v4 native). `index.html` viewport meta gains `viewport-fit=cover`.
- Terminal container: `touch-action: pan-y` + `overscroll-behavior: contain`
  so one-finger swipe scrolls the xterm buffer instead of rubber-banding the
  page. Interactive elements (key bar, buttons) get `touch-action:
  manipulation` to suppress double-tap zoom.
- **Open risk (explicit):** xterm 6's touch scrolling on iOS Safari is the one
  behaviour not provable by docs or desktop emulation. Live iPhone check is a
  release test item (§9); if xterm's own touch handling proves broken, the
  fallback is a thin scroll-proxy overlay driving `term.scrollLines()` —
  deliberately not pre-built (YAGNI until proven).

## 5. Terminal: accessory key bar + keyboard inset

- `components/terminal-key-bar.tsx` on the session page. Buttons map to raw
  byte sequences sent through the terminal handle's existing
  `sendInput(data)` (bytes are forwarded to the pane byte-for-byte; tmux
  translates plain CSI arrows for whatever the inner app expects — same
  encoding a desktop xterm in normal cursor mode sends):

  | Button | Bytes | Note |
  |---|---|---|
  | Esc | `\x1b` | interrupt Claude Code |
  | ^C | `\x03` | |
  | ⇧Tab | `\x1b[Z` | Claude Code permission-mode cycle |
  | Tab | `\t` | completion |
  | ⏎ | `\r` | submit at in-session prompts (added post-review — same byte a physical Enter sends) |
  | `/` | opens the existing `/` palette | not a raw byte; same handler the physical key uses |
  | ← ↑ ↓ → | `\x1b[D` `\x1b[A` `\x1b[B` `\x1b[C` | |

- Visible when `matchMedia("(pointer: coarse)")` matches — new
  `useIsCoarsePointer()` hook (same shape as `useIsWide()`). Keyed on pointer
  type, not keyboard visibility, so it renders under Playwright touch
  emulation (which has no soft keyboard) and on Bluetooth-keyboard iPads.
- `useVisualViewportInsets()` hook (over the native `visualViewport` API —
  no library exists; as shipped this replaced the sketched `--keyboard-inset`
  CSS var): on resize/scroll returns the visible height and iOS's downward
  pan in px, and `__root.tsx` applies them as an inline `height`/
  `translateY` on the app shell — pinning the whole shell (top bar, page,
  key bar) above the soft keyboard, so every page's `h-full` stays correct
  without per-page math. The existing `ResizeObserver` → `fit.fit()` loop
  resizes xterm — no terminal plumbing changes.
- Session header at `<sm`: working-dir text hidden (`hidden sm:inline`),
  remaining children wrap (already `flex`; add `flex-wrap` where missing).

## 6. iPad landscape: dock touch polish

No breakpoint change — 1194px keeps the dock. CSS-only in
`src/styles/dockview-theme.css`: taller tab strips and group-header hit areas,
~28px splitter hit area (visual line stays slim). **The documented finger path
for split/close/rename is every pane's existing menu**; drag-splitting stays
best-effort on touch (manual check, no test).

## 7. Small fixes folded in

- `components/ui/dialog.tsx` content: `max-h-[85dvh] overflow-y-auto` plus
  `w-[calc(100%-1.5rem)]` under `sm` — fixes tall-dialog clipping (add-session
  form) and edge-to-edge placement at once.
- `routes/users.tsx` create-form: `grid-cols-1` under `sm`, existing 12-col
  spans restored at `sm:`+.
- Folder picker inside add-session: works once dialogs scroll; no other
  phone-specific work.

## 8. Home-screen install

- Create `apps/frontend/public/`: `manifest.webmanifest` (name `Mote`,
  `display: standalone`, dark `theme_color`/`background_color` matched to the
  app token, icons 192/512-maskable).
- Icons: a new source SVG committed under `public/`, rasterised **once** via
  `sharp` (devDependency) to `icon-192.png`, `icon-512.png` (maskable),
  `apple-touch-icon.png` (180). PNGs are committed; `sharp` runs only as a dev
  script.
- `index.html`: manifest link, `apple-mobile-web-app-capable`,
  `apple-mobile-web-app-status-bar-style: black-translucent`, touch-icon
  links.
- **Backend change required (found while planning).** `static.plugin.ts`
  serves only `/`, `/index.html` and `/assets/*`; its SPA fallback 404s every
  top-level path containing a dot — so `/manifest.webmanifest` and
  `/icons/*.png` would never reach a browser in prod. The fallback gains a
  pre-check: a dotted path whose file actually exists inside `dist/` (resolved
  with the same traversal guard as `/assets/*`) is served with the right
  content type; everything else keeps today's behavior exactly. Covered by
  extended `static.plugin.test.ts` cases.

## 9. Testing

- **Unit (`bun test`, frontend):** the key-bar byte table (pure exported
  constant → assert exact sequences); `useKeyboardInset` against a stubbed
  `visualViewport` (matchMedia is already mocked in `test-setup.ts`);
  `useIsCoarsePointer` on/off.
- **E2E (Playwright, `e2e/`):** new projects `mobile` =
  `devices["iPhone 15 Pro"]` (393×659, touch) and `ipad-landscape` =
  `devices["iPad Pro 11 landscape"]` (1194×834, touch); existing specs stay on
  the desktop chromium project. New specs (numbering continues: 08, 09):
  - `08-mobile-shell`: no horizontal overflow (`scrollWidth ≤ innerWidth`) on
    /, /sessions/:id, /workspaces, /settings at 393px; hamburger opens the
    drawer; a nav tap navigates and closes it; dialog scrolls (add-session
    fully reachable); at 1194×834 the sidebar is present (desktop shell).
  - `09-mobile-terminal`: key bar visible under touch emulation; clicking
    `^C`/arrows delivers bytes into a real stub-`pi` pane — requires a small
    **stub extension**: the stub also echoes stdin raw bytes (`cat -v`-style)
    so the pane log/terminal shows `^C`; workspace renders tabs at 393 and the
    dock at 1194 (asserting the never-clobber rule is already covered by
    existing workspace specs).
- **Manual gate before merge** (needs a real device; Theo): iPhone Safari —
  xterm one-finger scroll, keyboard open/close keeps prompt visible, key bar
  usable with one thumb, Add-to-Home-Screen launches standalone with no
  clipped chrome; iPad landscape — pane menus drive split/close by finger.

## 10. Invariants this design must not break

1. Desktop rendering is unchanged at ≥1024px (sidebar, dock, dialogs, forms).
2. The narrow tab mode keeps never writing `layout_json` (existing rule,
   `workspace-tabs.tsx` header comment — mobile work must not import the
   debounced-save machinery).
3. `env -i` curation, token lifecycle, WS single-use tokens: untouched. The
   only backend change in the whole feature is the static-plugin dist-root
   file serving (§8); auth/session code is not touched.
4. No `mote mcp`/harness surface changes.

## 11. Out of scope

Service worker / offline; Android-specific tuning (it benefits incidentally);
a separate mobile route tree; making dockview drag-splitting *good* on touch;
Bluetooth-keyboard special handling; iPad stylus/Apple Pencil; `/users` beyond
un-breaking the grid; landscape-lock on phone.

## 12. Follow-up status: Radix → Base UI migration — DONE (2026-08-30)

Done *ahead* of this project at Theo's direction. The whole `components/ui`
tree moved to `@base-ui/react` (button→Button primitive, label→native,
switch/tabs→direct, dialog→Backdrop/Popup, dropdown-menu→Menu,
select→Positioner/Popup/List, tabs deleted as dead code); every Radix package
is gone from package.json. Per-component reports: `apps/frontend/.migration/`.
Consequences for the mobile plan: the §7 dialog tweak lands on the Base UI
`dialog.tsx`; `sheet.tsx` (§3) is plain Base UI Dialog like its siblings; the
spec's earlier "legacy Radix tree" phrasing is historical.
