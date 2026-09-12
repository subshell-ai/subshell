# Design: Grouped navigation — Server Settings in the SPA, Settings in the server console

**Date:** 2026-09-11
**Status:** approved in conversation, not yet implemented
**Scope:** `apps/server/web` (the SPA the server serves) and `apps/server/desktop/ui` (the Subshell Server console). Nothing in `apps/client/*`, `apps/node/*`, `apps/server/api` or any package changes.

## 0. Why

Both sidebars are flat lists, and both have outgrown it.

In the **SPA**, the rail reads Subshells, Workspaces, Nodes, Profiles, Instance, Status, Users. "Instance" and "Status" are two admin pages that belong together and look like peers of Subshells. Plugins, a third admin page, is not in the rail at all — it hangs off a button in the Instance page header. The Instance page itself is a scroll of five unrelated cards (instance name, registration, system API keys, a node switch, the reset), and the Users page stacks a roster everybody may read under an admin-only Add-user form and above an admin-only audit trail.

In the **server console**, the rail reads Overview, Addresses, Logs, Settings, About. Addresses IS a setting — the one that rewrites `config.env` — and it sits between two pages that are not.

The fix is one UI idea applied twice: a sidebar item may be a **group** — a label with a chevron that opens to a list of pages — in the style of a "Fleet ▾ / Health / Traffic / Events" nav. Once pages can be grouped, the admin surface can be split into pages with names instead of cards in a scroll.

## 1. The rule

A **group** is a label and a chevron. **It is not a page.** Clicking it toggles its children; every page inside it has its own row. Two reasons:

- A header that is also a link needs a toggle button beside it, and the rail already avoids nesting interactive elements (see the quick-add `+` handling in `app-sidebar.tsx`). A label-only header has one job.
- Every page gets a name. "General" and "Application" exist because of this rule, and they are better than a page that is called whatever its group is called.

Groups do not nest. One level is what the two trees below need, and a second level is a design question, not an extension.

## 2. The two trees

### 2.1 The SPA

```
Subshells
Workspaces
Nodes
Profiles
Server Settings ▾        admin only — the whole group
  General                /settings
  Users                  /users
  API keys               /settings/api-keys      (new page)
  Plugins                /settings/plugins
  Status                 /settings/status
  Audit log              /settings/audit         (new page)
```

Order inside the group: what an admin sets, then who is on the instance, then credentials, then what the plane offers, then two read-only pages. Status and Audit log are last because they change nothing.

**Users moves into the admin group.** Members can still open `/users` (the roster read is instance-wide so the share picker works, and the page renders a plain roster for them) — the route and the page's member branch are untouched. What changes is only that a member's rail no longer lists it: a member's real use of the roster is the sharing dialog, which lists the same people.

**URLs do not move.** `/users` stays `/users`. Paths are identifiers, the group is presentation, and e2e already navigates by path.

**On the label.** `app-sidebar.tsx` carries a comment explaining why the entry said "Instance" and not "Server": the control-plane host's own node row is named *Server* by default, and on `/nodes` an admin saw the word on two things. "Server Settings" is a two-word label for a group of pages, and it reads as the plane's settings rather than as that node; the decision here is to accept it. Rewrite the comment to say that, do not delete it.

### 2.2 The server console

```
Overview
Logs
Settings ▾
  Addresses
  Application
About
```

**Application** is the section that is called Settings today: the tray preference and the reset button. It is about this app and this machine rather than about the server's addresses, which is what the name says. About stays last and outside the group, for the reason the existing `console-nav.ts` comment gives (a page that only tells you things does not belong beside the two that alter the machine).

**Section ids do not change.** `SectionId` stays `"overview" | "addresses" | "logs" | "settings" | "about"`; the section labelled Application keeps the id `settings`, its `section-settings` element, and every `goTo("settings")` call. Ids are identifiers and labels are labels — the same distinction AGENTS.md draws between directory names and component ids — and renaming the id would touch the reset flow's element ids for no behavioural gain. The label map is where the rename happens.

## 3. The nav model (SPA)

### 3.1 Data

`NavItem` stays what it is. Add a group type and a union:

```ts
/** A page in the rail. */
export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  short?: string;
  requiresAdmin?: boolean;
}

/** A label with a chevron that opens to pages. Never a page itself (§1). */
export interface NavGroup {
  /** Stable key: the React key, and what a chevron press is recorded against. */
  id: string;
  label: string;
  /** Shown beside the label when expanded; never shown collapsed (§3.3). */
  icon: LucideIcon;
  children: NavItem[];
  /** Gates the WHOLE group. Children carry no flag of their own. */
  requiresAdmin?: boolean;
}

export type NavEntry = NavItem | NavGroup;
export const isNavGroup = (e: NavEntry): e is NavGroup => "children" in e;
```

`NAV_ITEMS: NavItem[]` becomes `NAV_ENTRIES: NavEntry[]` in the order of §2.1. The one group is:

```ts
{
  id: "server-settings",
  label: "Server Settings",
  icon: ServerCog,
  requiresAdmin: true,
  children: [
    { to: "/settings",          label: "General",   icon: Settings,   short: "Gen"  },
    { to: "/users",             label: "Users",     icon: Users,      short: "Users" },
    { to: "/settings/api-keys", label: "API keys",  icon: KeyRound,   short: "Keys" },
    { to: "/settings/plugins",  label: "Plugins",   icon: Puzzle,     short: "Plug" },
    { to: "/settings/status",   label: "Status",    icon: Activity,   short: "Stat" },
    { to: "/settings/audit",    label: "Audit log", icon: ScrollText, short: "Audit" },
  ],
}
```

All icons are lucide-react. `ServerCog` for the group, so `Settings` (the gear) can stay on General and `Server` stays on Nodes.

### 3.2 The pure helpers

`visibleNavItems(isAdmin)` is imported by two test files and is the one place the admin gate lives. Keep the name and the contract — it returns the **flat** list of pages the viewer may reach, groups flattened — and add a second helper for the rail:

```ts
/** The rail's entries for this viewer: admin-gated groups drop as a whole. */
export function visibleNavEntries(isAdmin: boolean | undefined): readonly NavEntry[];

/** Every page the viewer may reach, groups flattened, in rail order. */
export function visibleNavItems(isAdmin: boolean | undefined): readonly NavItem[];
```

"Unknown ≠ open" still holds: while `isAdmin` is `undefined` the group is hidden.

### 3.3 Rendering

**Expanded rail.** A leaf renders exactly as today. A group renders a header row — icon, label, chevron at the right edge (`ChevronDown`, rotated `-90deg` when closed, 200 ms transition like the collapse chevron) — as a `<button type="button" aria-expanded={open} aria-controls={listId}>`. Below it, when open, a `<div id={listId}>` of the children, each rendered with the same link classes as a top-level leaf but indented (`pl-9`, icon kept, text `text-sm`), so an active child carries the same gradient as an active top-level page. The header row itself never takes the active gradient; when a child is active and the group is closed, the header shows `text-accent-foreground` so the closed group still says "you are in here".

**Collapsed rail.** Group headers are not rendered. Children render as icons in the rail, in order, exactly as a collapsed leaf does today (centered icon, `title` tooltip of `label (short)`). Every page stays one click away in both widths, which is the property the collapsed rail exists for.

**Active state.** Unchanged: `location.pathname === item.to`, exact match. (Detail routes such as `/nodes/:id` have never lit up Nodes, and this spec does not change that.)

**Open state (corrected 2026-09-12).** **The route decides, and a chevron press overrides it until the route changes.** So a group is open exactly while you are on one of its pages and shut otherwise, and the chevron always works, in both directions, including to shut a group you are inside. The rule is a pure function, `groupOpen(override, childActive) => override ?? childActive`, and is tested.

Nothing is persisted. A press is meant to last until you navigate, so it is held beside the pathname it was made on and expires when that changes — no `localStorage`, no effect, no second render.

The original rule here was `stored || childActive` with a persisted default of open, and it was wrong on both halves. It made the chevron a no-op on exactly the pages a person is most likely to press it from, reported as "I'm not able to collapse things", and it left the group standing open on every unrelated page. The reasoning it rested on — that the rail must be able to say where you are — does not need it: the group header stays lit when it is shut over an active child, which is what the `text-accent-foreground` rule in the previous paragraph is for.

**The drawer.** `mobile-top-bar.tsx` renders the same component with `forceExpanded`; it gets groups for free. `desktop-sidebar.tsx` likewise.

### 3.4 Where the `+` buttons and recents live

Unchanged. The Subshells filter, the recents and the two quick-add `+` buttons are keyed on `item.to === "/"` and `"/workspaces"`, both of which stay top-level leaves. Do not generalise them.

## 4. Page changes (SPA)

### 4.1 General — `routes/settings.tsx`

- `PageHeader` title becomes **"General"**, subtitle "Instance name, registration, and reset (admins)".
- The `action` slot (the Status and Plugins buttons) is **removed**. The rail reaches both now.
- Cards, in order: `InstanceNameCard`, Registration, `ResetServerCard` (still under `resetCardVisible`). The System API keys card and the Launch-on-the-server card leave this page (§4.3, §4.6).
- The member branch — the sentence "Instance settings are for admins" — is unchanged. e2e pins it.

### 4.2 Users — `routes/users.tsx`

- The Audit trail card and its `["audit"]` query leave this page (§4.4). The `createUser` handler stops invalidating `["audit"]` — nothing on the page reads it any more. (The Audit log page refetches on mount, so the trail is current when opened.)
- Header subtitle: admins "Admin user management", members "The people on this instance".
- Nothing else. Add-user, the roster table, the role and password controls, and the member branch stay as they are.

### 4.3 API keys — `routes/settings_.api-keys.tsx` (new)

`PageHeader` title "API keys", subtitle "Long-lived bearer keys for external tooling against this instance." Body: the admin gate as `settings.tsx` has it (render nothing while `viewerIsAdmin` is undefined, the "for admins" sentence for members), then `<SystemApiKeysCard />` unchanged. The card keeps its own title; a page with one card and a header that repeat each other is acceptable here because the card is reused nowhere else and its `CardTitle` is what its tests and copy refer to.

### 4.4 Audit log — `routes/settings_.audit.tsx` (new)

`PageHeader` title "Audit log", subtitle "Latest subshell lifecycle and admin events (admins)". Body: the admin gate, then the audit table **moved verbatim** out of `users.tsx` into `components/settings/audit-trail-card.tsx` with its query (`["audit"]`, `GET /api/audit?limit=50`) and its three-state loading/error/empty copy. The route file is the gate plus the card, in the thin-orchestrator shape `.claude/rules/code-style.md` asks for.

### 4.5 Route files

TanStack file routes: `settings_.api-keys.tsx` → `/settings/api-keys`, `settings_.audit.tsx` → `/settings/audit`, matching how `settings_.status.tsx` and `settings_.plugins.tsx` already flatten. `routeTree.gen.ts` regenerates on build.

### 4.6 The local-launch switch moves to the node

`LocalLaunchCard` ("Launch on the server") toggles the seeded Everyone/`edit` grant on the `local` node. It leaves `settings.tsx` and renders on the node detail page, `routes/nodes_.$id.tsx`, **only when `n.kind === "local"`**, placed directly after the header and before `NodeAllowedDirs` — the two are both "who may launch here, and where". The card already gates itself on `Node.canManage` for `local` and renders nothing otherwise, so no new visibility logic is added. Its doc comment says "Settings-page switch"; update it.

The security-context rule stays true and should be re-read, not re-derived: disabling the host as a launch target is the removal of that share row, boot never re-seeds it, and there is no flag. Moving the card moves a door, not the mechanism.

## 5. The console (Tauri server app)

### 5.1 `lib/console-nav.ts`

`SectionId`, `SECTIONS` (flat render order, still what `render()` iterates to hide sections) and `addressesAvailability`/`heroState` are unchanged except:

- `SECTIONS` order becomes `["overview", "logs", "addresses", "settings", "about"]` so that the flat order equals the tree's reading order (the test in §7.2 pins that equality).
- `SECTION_LABELS.settings` becomes `"Application"`.
- A tree is added:

```ts
export type NavEntry =
  | { kind: "section"; id: SectionId }
  | { kind: "group"; id: "settings-group"; label: string; children: readonly SectionId[] };

export const NAV_TREE: readonly NavEntry[] = [
  { kind: "section", id: "overview" },
  { kind: "section", id: "logs" },
  { kind: "group", id: "settings-group", label: "Settings", children: ["addresses", "settings"] },
  { kind: "section", id: "about" },
];

/** The tree, flattened to section order. Must equal SECTIONS. */
export function flattenNavTree(tree: readonly NavEntry[]): SectionId[];
```

### 5.2 `main.ts`

`buildNav()` walks `NAV_TREE`. A section entry builds the `button.nav-item` exactly as today (the Overview dot included). A group entry builds:

```html
<button type="button" class="nav-group" aria-expanded="true" aria-controls="nav-group-settings">
  <span>Settings</span><span class="nav-chevron" aria-hidden="true"></span>
</button>
<div class="nav-group-children" id="nav-group-settings"> …child .nav-item buttons with class "child"… </div>
```

Open state follows the same corrected rule as the SPA (§3.3), and lives in the same shape: `navGroupOpen(override, childCurrent) => override ?? childCurrent` is a pure function in `console-nav.ts` beside its siblings, and `main.ts` holds only the outstanding press (`navGroupPress`, `undefined` = follow the section), which `goTo` clears. Nothing is persisted. `renderNav()` sets `aria-expanded` and toggles `hidden` on the children container.

So the console opens with the group shut, since it opens on Overview, and the group opens when you enter Addresses or Application.

`goTo` is unchanged. The `desktop_open_console({ screen: "reset" })` deep link is unaffected: the reset view is a takeover over the whole shell, not a section.

### 5.3 `index.html` and `styles.css`

- `index.html`: `<h2 class="section-title">Settings</h2>` in `section-settings` becomes `Application`. The comment above `#nav` still holds (labels have one source).
- `styles.css`: `.nav-group` shares `.nav-item`'s geometry (same padding, same font, muted colour, no current state), `justify-content: space-between`; `.nav-chevron` is a 12 px chevron drawn with a rotated border or an inline SVG data URI, `transform: rotate(-90deg)` when `aria-expanded="false"`, 200 ms transition; `.nav-group-children` is a flex column with `gap: 2px` and `padding-left: 14px`, plus a 1 px `var(--color-line)` left rule inset to read as a tree like the reference; `.nav-item.child` has `font-size: 13px`. `.nav-group-children[hidden] { display: none }` to match the existing `[hidden]` idiom in this stylesheet.

## 6. Copy changes, gathered

| where | before | after |
|---|---|---|
| SPA rail | Instance / Status (two leaves), Users (top level) | Server Settings ▾ → General, Users, API keys, Plugins, Status, Audit log |
| `/settings` header | "Instance" / "Instance-wide configuration (admins)" + Status/Plugins buttons | "General" / "Instance name, registration, and reset (admins)", no buttons |
| `/users` admin subtitle | "Admin user management and audit trail" | "Admin user management" |
| `/settings/api-keys` | — | "API keys" / "Machine credentials for tooling that talks to this instance (admins)" |
| `/settings/audit` | — | "Audit log" / "A read-only record of what happened on this instance (admins)" |
| console rail | Overview, Addresses, Logs, Settings, About | Overview, Logs, Settings ▾ → Addresses, Application; About |
| console `section-settings` title | Settings | Application |

**A page header must not repeat the card beneath it** (learned 2026-09-12). Both new pages first carried their card's own `CardDescription` verbatim as the page subtitle. That is one sentence twice, a few pixels apart, and it also makes every by-text locator ambiguous between the ungated header and the gated card — e2e's member check failed on exactly that, reading the header as proof the audit table had leaked. The header says whose page it is; the card says what the table holds.

## 7. Tests

### 7.1 SPA unit tests (`bun test`, `apps/server/web`)

Update `components/__tests__/sidebar-nav.test.ts` and `app-sidebar.test.ts`, and add cases so that together they pin:

- `visibleNavItems(false)` and `visibleNavItems(undefined)` contain none of the six group pages — `/users` included, which is the reversal of the current assertion — and do contain `/`, `/workspaces`, `/nodes`, `/profiles`.
- `visibleNavItems(true)` contains all six group pages, in the §2.1 order, and `visibleNavEntries(true)` has exactly one group, labelled "Server Settings", carrying `requiresAdmin`.
- No child of a group carries `requiresAdmin` (the gate is the group's).
- No two entries across `visibleNavEntries(true)` — group icons and every leaf — share an icon (extend the existing uniqueness test).
- `groupOpen(override, childActive)`: `(undefined, true) → true` and `(undefined, false) → false` (the route decides), `(false, true) → false` (a press shuts a group you are inside — the regression this pins), `(true, false) → true`.
- `routes/__tests__/users-page.test.tsx` exists and renders the page for an admin, a member and the service account. Keep it green (the admin case no longer sees an "Audit trail" heading — assert its absence there), and add `components/settings/__tests__/audit-trail-card.test.tsx` in the same style, covering the loading, error, empty and populated states.

### 7.2 Console unit tests (`apps/server/desktop/ui/src/__tests__/console-nav.test.ts`)

- `SECTIONS` equals `["overview", "logs", "addresses", "settings", "about"]` and `SECTIONS[0]` is `overview`.
- `flattenNavTree(NAV_TREE)` equals `SECTIONS` — the two orders are one order.
- About is last and is not a child of any group; Addresses and the `settings` section are the group's children, in that order.
- `navGroupOpen(override, childCurrent)`: the same four cases as `groupOpen` above.
- `SECTION_LABELS.settings` is `"Application"`, and every section is labelled.

### 7.3 e2e (`e2e/`, Playwright, not in `bun run test`)

Three specs reference the old rail and must be updated in the same change, or CI's e2e job goes red:

- `08-mobile-shell.spec.ts`: it clicks `link "Instance"` and expects `/settings`. Now: open the drawer, click `button "Server Settings"` only if `aria-expanded` is `false`, then click `link "General"`, expect `/settings$`.
- `10-auth-experience.spec.ts`: it asserts the aside has no `link "Instance"` for a member. Now: assert no `button "Server Settings"` and no `link "General"` in the aside — and additionally no `link "Users"`, since that entry is inside the group now. Its `heading "Users"` check on `/users` still passes (members can open the route).
- `12-nodes.spec.ts` (comment at line ~94) mentions `/settings` being labelled "Server" — read it and fix the comment or the locator if it resolves by label.
- `13-local-plugins.spec.ts` and `14-registry-install.spec.ts` navigate by path to `/settings/plugins`; no change.

Add nothing new to e2e; the unit tests above are the pin for the tree.

## 8. Verification

```bash
bun run verify-types
bun run lint:check
bun run test
bun run test:e2e       # needs tmux + `bunx playwright install chromium`; run it — §7.3 touches three specs
```

Then by hand, since none of it is automated:

1. SPA as admin, expanded rail: on a page OUTSIDE the group it is shut; every child navigates; entering a child opens it and leaving shuts it again with no press; the active gradient sits on the child, not the header; the chevron works from both outside and INSIDE the group, and while shut over the current page the header stays lit. (This item described the pre-correction rule until 2026-09-12 — it asked the verifier to confirm the group "cannot be shown closed" with a child active, which is the exact bug §3.3 now removes. A verification list is as much a source of truth as the rule it checks.)
2. SPA as admin, collapsed rail: six extra icons appear where the group is, each with a tooltip, each navigating; no header row.
3. SPA as a member: the rail ends at Profiles; `/users` still renders the roster by URL.
4. Mobile width: the drawer shows the group; picking a child closes the drawer as picking a leaf does.
5. `/nodes/<local id>` as admin: the Launch-on-the-server card is present above Allowed directories; on an agent node it is absent.
6. Console (`bun run dev:desktop-server`): Settings opens to Addresses and Application; Overview's dot still tracks the hero; the reset flow from Application → the takeover → back is unchanged.

## 9. Implementation order

1. `console-nav.ts` + its test (pure, no DOM) — then `main.ts`, `index.html`, `styles.css`; run the console by hand.
2. `app-sidebar.tsx` types and helpers + the two nav tests — then the render (expanded, collapsed, open state).
3. New pages: `audit-trail-card.tsx` + `settings_.audit.tsx`; `settings_.api-keys.tsx`; the removals from `settings.tsx` and `users.tsx`.
4. `LocalLaunchCard` into `nodes_.$id.tsx`.
5. The three e2e specs.
6. §8.

Each step leaves `verify-types`, `lint:check` and `test` green on its own.

## 10. Out of scope, on purpose

- **Preferences and Account stay in the user menu.** They are per-user, the menu is the conventional door, and a "You" group in the rail would put two member pages beside the admin group with no reason to be neighbours.
- **No nested groups, no group that is also a link** (§1).
- **No URL moves.** `/users` stays; the two new routes are additions.
- **The Subshell Client app** (`apps/client/desktop`) has no sidebar; the step flow is untouched.
- **Detail-route highlighting** (`/nodes/:id` lighting Nodes) is a separate, older question and is not solved here.
- **A changeset.** This is SPA + server-console work, so if one is written it names `@internal/server` and `@internal/desktop-server` — never `@internal/server-web`, which is an ignored package (AGENTS.md, "Never write a changeset for an `ignore`d package").
