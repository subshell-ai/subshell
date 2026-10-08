# Sidebar: Settings group + account card in the header

Date: 2026-10-07
Status: approved by operator (sections A-D each confirmed)
Base: `origin/main` (b57a10c7), worktree `sidebar-settings`.

## Problem

Two asks from the operator:

1. Nodes, Presets, and Prompts sit at top level in the rail while the instance
   pages live under a "Server Settings" group. The personal pages should sit in
   their own "Settings" group the same way.
2. The footer card at the bottom of every rail (server version row + user menu)
   is infrequently accessed and always present. Operator's ruling, after options
   were weighed: "Replace the server name with the account card in the header and
   fold the version into the menu." Applies to the browser rail AND both desktop
   shells (the rail is one shared component).

A prior implementation of the grouping exists on `feat/ssh-support`
(152dd790); this spec ports its shape, minus the SSH Connections child, which
`main` has no route for.

## A. Settings group

In `components/sidebar/sidebar-nav.ts`, replace the three top-level items with a
group between Workspaces and Server Settings:

```
{ id: "personal-settings", label: "Settings", icon: UserRoundCog,
  children: [Nodes (/nodes), Presets (/presets), Prompts (/prompts)] }
```

- No `requiresAdmin`: every signed-in person reaches these pages today; access
  rules are unchanged, this is chrome only.
- Group behavior comes from the existing machinery plus one rule the grouping
  needs: the chevron opens it when the route is inside, and detail pages like
  `/nodes/local` count, via a segment-aware `childActive` prefix rule
  (`pathname === child.to || (child.to !== "/settings" &&
  pathname.startsWith(child.to + "/"))`) that Task 1 of the plan adds to
  `app-sidebar.tsx`. General is exact-only so a future personal page under
  `/settings/...` cannot light the admin group. The collapsed rail renders the
  children as plain icons with no header, so collapsed behavior is identical to
  today.
- "Settings" vs "Server Settings": the second word is the disambiguator, same
  reasoning the Server Settings label comment (spec 2026-09-11 §2.1) records.
- `UserRoundCog` (person-gear) distinguishes it from the plain `Settings` gear
  on General and the `ServerCog` on the admin group.

## B. Account card in the header

The footer's `UserMenu` moves to the header, replacing the `instanceName` detail
line under the wordmark:

```
[subshell wordmark]                        [collapse chevron]
[avatar] Theo Gravity                          ▾
```

- Expanded trigger: avatar + display name + chevron, `DropdownMenu` opening
  downward (`side="bottom"`; today's `side="top"` was right for a footer).
  Props stay as they are: `AppSidebar` owns the queries and actions.
- Collapsed trigger: initials avatar, icon-only, centered under the wordmark
  button; tooltip and accessible name keep the `Account: <display>` form.
- Menu contents, top to bottom:
  1. Identity block (as today: name, email), plus one inert `detail` line:
     `Subshell Server <serverVersion> · <instanceName>`, the version folded in,
     and the instance name (the rail line it replaces) preserved here.
  2. An `Update available: v<latest>` item (amber `ArrowUpCircle`, navigates to
     `/settings/updates`), rendered ONLY when `viewerIsAdmin === true` AND the
     server's `updateAvailable` is true. Same gate `ServerVersionRow` had.
  3. Separator, Preferences, Account settings, Feedback, About Subshell,
     separator, Sign out (all unchanged).
- The version row's amber marker is a status light (version-row.tsx: "it has no
  off switch"), so it must survive outside the menu: when the update condition
  above is true, the avatar carries a small amber dot (collapsed rail included).
  Pressing through the menu is the act; the dot is the light.
- The header card takes over `ServerVersionRow`'s read and is the rail's
  only consumer of `useUpdates`; the Updates page's own use shares the same
  cached query by key, keeping one request per document load.

## C. Footer behavior

- The bordered footer div renders only when `footerEnd` is supplied. Web passes
  nothing: no footer div at all, no border, no padding.
- `ServerVersionRow` (`components/sidebar/server-version-row.tsx`) is deleted;
  its read moves into the header card. `VersionRow` stays (DesktopAppUpdateRow
  consumes it).
- Desktop shells keep their footer rows (server pill + app-update row via
  `footerEnd`) at the bottom, above nothing; their `UserMenu` moves to the
  header exactly like web's. The desktop app-update marker keeps its own row -
  that row is desktop chrome describing the app bundle and is out of scope.
- `AboutDialog` and `MobileInstallDialog` stay mounted in `AppSidebar` (they are
  overlays; their mount point moves out of the deleted footer div to the aside
  root). Triggers are unaffected; the dialogs must not be mounted inside the
  dropdown.
- The "Subshell for Mobile" and desktop-only "Open in browser" rows stay as the
  last nav items. The mobile drawer gets the header card for free (`forceExpanded`).

## Files touched

- `components/sidebar/sidebar-nav.ts` - group; `NAV_ENTRIES` only.
- `components/app-sidebar.tsx` - render `UserMenu` in the header slot, delete the
  instanceName line and the always-on footer div, move dialog mounts.
- `components/user-menu.tsx` - downward dropdown, version+instance detail line,
  update item, avatar dot; gains `serverVersion`, `instanceName`, update props
  (props-only stays true - the sidebar owns the queries).
- `components/sidebar/server-version-row.tsx` - deleted.
- `routes/__root.tsx` - drop `browserFooter` / `ServerVersionRow` import.

## Tests

- `sidebar-nav.test.ts`: Settings group membership + flattened-page visibility
  unchanged (member reaches /nodes /presets /prompts; gate untouched).
- `user-menu.test.tsx`: version line renders; update item and avatar dot appear
  ONLY under `viewerIsAdmin === true` + `updateAvailable`; absent otherwise;
  sign-out still reachable.
- Replace `server-version-row.test.tsx` coverage with the header-card assertions.
- `app-sidebar-group.test.tsx` / `app-sidebar.test.ts`: header card present
  expanded and collapsed; web footer gone; desktop footer rows still render.
- Focused runs while iterating; full `verify-types`, `lint:check`, `lint:prose`,
  `test` at the boundary (verification.md).

## Docs

- `apps/server/web/docs/sidebar.md`: the Settings group and the header account
  card; the footer entry (if any) updated to desktop-only rows.
- One changeset under `.changeset/`.

## Out of scope

- The Expo mobile app (separate navigation).
- `/nodes` `/presets` `/prompts` route, access, or page changes.
- Desktop server pill and app-update row redesign.
- SSH Connections (does not exist on `main`).
