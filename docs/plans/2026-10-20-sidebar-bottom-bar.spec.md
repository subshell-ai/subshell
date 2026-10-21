# Spec: replace the mini sidebar rail with a bottom section bar

**Amended 2026-10-20 by operator follow-ups:** the Subshell mark returned as the Workspaces cell icon; the Subshell for Mobile and Account cells are buttons (install dialog / profile card), not links.

## §1 Behavior

The narrow icon rail (logo, four section icons, desktop "Open in browser") is
removed everywhere: browser SPA, desktop shells, and the mobile drawer. The
wide panel becomes the whole sidebar. Its section actions move to a
horizontal button bar docked at the bottom of the panel: Workspaces, Subshell
for Mobile, Settings, Account, plus "Open in browser" as a fifth button only
inside desktop shells. No logo button: the rail's "/s" mark is gone, per the
operator. Each button is the section's Link with its existing accessible name
and `aria-current="page"` on the active section; active also gets the accent
background the rail uses today. Tooltips sit above the bar. The account
button keeps its amber update dot for admins. The bar keeps
`aria-label="Main sections"` on its `nav` so existing queries keep resolving.

Remembered-destination behavior carries over: clicking a different section
navigates to that section's last visited page (settings remembers /nodes vs
/presets etc.; workspaces ignores a remembered `/` landing). Clicking the
already-active section navigates to its remembered page, except inside
`/workspaces/$id` where clicking Workspaces stays a no-op.

## §2 Removals

Panel collapse retires with the rail: no `subshell.sidebarCollapsed` pref, no
`forceExpanded` prop, no `collapsed` state, no `aria-expanded` on section
links. A collapsed panel has no affordance to expand once the rail is gone,
so keeping the state would strand it. The desktop "Toggle Sidebar" menu item
(CmdOrCtrl+B) and its `toggle-sidebar` action are deleted end to end: the
native menu entry (apps/server/desktop `menu.rs`, `bridge.rs`) and the SPA
listener branch. `focus-filter` and every other desktop action stay.

## §3 Frozen interfaces

- `nav` accessible name "Main sections" (drawer close logic and six e2e specs
  select it).
- Section link names "Workspaces", "Subshell for Mobile", "Settings",
  "Account", "Open in browser"; `aria-current="page"`.
- Drawer contract: section clicks keep the drawer open (onSectionNavigate);
  page/pane clicks close it; quick-add closes it.
- `AppSidebar` props `headerEnd`, `headerAbove`, `onQuickAdd`,
  `onSectionNavigate`, `onSectionNavigated`, `footerEnd`, `variant`; the
  `collapsed` field drops from `footerEnd`'s ctx only.
- The `__root.tsx` sidebar mount line stays one line containing `bare`
  (root-frame-guards source grep).
- Modifier-clicks (meta/ctrl/shift/alt) and middle-click pass through to the
  real Link.

## §4 Mobile drawer

The drawer keeps width `w-80 max-w-[90vw]`; its content gains the 56px the
rail used to eat. Panel header (section title + close X) is unchanged.

## §5 Tests, docs, changesets

Unit tests that assert collapse (app-sidebar-group, app-sidebar-account) are
rewritten to the new semantics. e2e `30-context-sidebar.spec.ts` drops its
collapse-toggle tail and keeps destination-restore assertions; `08-mobile-
shell.spec.ts` keeps passing through the same accessible names. `docs/
sidebar.md` and the mini-rail lines of `apps/server/web/AGENTS.md` describe
the bar. A changeset lists `@internal/server` and `@internal/desktop-server`.

## §6 Verification

Focused bun tests for touched files; `bun run test --filter=@internal/server-web`
then full trio at the boundary; `bun run rust:check` for the Rust edit; e2e
specs 08 and 30 via `E2E_VERBOSE=0 bun run test:e2e -- 30 08` shape if the
stack allows, else named for manual run.
