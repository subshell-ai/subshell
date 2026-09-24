# Users table action menu (2026-09-24)

## The problem

`/settings/users` renders its per-row controls as three inline widgets — a
role `Select`, "Reset password", "Disable/Enable" — under a `Manage` column
header. Two of the instance's rows (the viewer's own, and the server-marked
`manageable: false` service account) can hold none of those, so the header
sits over text that manages nothing: "Your account", "Service account".
The operator read the column as nonsense. It is also the tree's last table
still spreading row actions inline while every other table (nodes, presets,
subshells) uses the shared `ActionsMenu` kebab.

## Decisions taken in the design conversation

- **Fold the three controls into one `ActionsMenu`** (operator call
  2026-09-24): the shared component at `components/actions-menu.tsx`, the
  same one the Nodes rows drive.
- **The labels stay** (operator call 2026-09-24): the self row and the
  service row keep their muted text; what goes is the visible header that
  made them read as failed controls.
- **The disabled marker is already right**: the warning `Disabled` badge
  beside the role badge plus the dimmed row carries the state; no louder
  marker was asked for once the operator learned it ships today.

## The mechanism

### The table (`components/users/users-table.tsx`)

- The `Manage` `th` becomes the Nodes table's cell verbatim:
  `<th className="pb-2 text-right font-strong"><span className="sr-only">Actions</span></th>`
  — visually headerless, named for screen readers, right-aligned.
- The last cell right-aligns its contents too: the two muted labels
  ("Your account", "Service account") and the kebab all sit at the row's
  right edge.
- Untouched: the Role column's badges (role + `Disabled`), the dimming of a
  disabled row, the Add user dialog, the route, and the server.

### The row actions (`components/users/user-row-actions.tsx`)

The `div` of Select + two buttons is replaced by
`<ActionsMenu label={user.email} items={...} disabled={busy} />`. Items,
in order:

- **Promote to admin** / **Demote to user** — one item named by the TARGET
  role: the word comes from `USER_ROLE_LABELS` (via `asUserRole(user.role)`)
  lowercased into the sentence, so menu and badge trace to one spelling and
  the copy still follows the app's sentence-case menu idiom. Same instant `PATCH
  /api/users/:id/role` as today; no dialog. The last-admin 409 returns the
  server's sentence verbatim, rendered beside the kebab where the Select
  error rendered before, auto-cleared at 8 s as today.
- **Reset password** — opens the existing dialog unchanged: typed-in-the-
  clear password, shown-once result, the sessions-cut sentence.
- **Disable account** (`destructive`, opens the existing confirm dialog
  naming the nodes-disconnect cost) / **Enable account** when the row is
  disabled — the immediate one-shot it is today, reported by the row
  re-rendering un-disabled.

Self rows and `manageable === false` rows keep returning the muted label,
exactly as today — the gating logic does not move.

### Fall-out

- `USER_ROLE_OPTIONS` (`types/user-role.ts`) survives for the Add user
  dialog's select; its doc comment naming "both role selects… the per-row
  one" and `user-row-actions.tsx`'s `Select` + `USER_ROLE_OPTIONS` imports
  go away with the control.
- Icons (lucide, one per item as `ActionItem` requires): role flip
  `ShieldCheck` / `ShieldOff`, password `KeyRound`, disable `UserX`, enable
  `UserCheck`. Only **Disable account** is red; **Demote to user** removes a
  capability but signs nobody out and is reversible from the same menu one
  click away, so it stays neutral.
- Tests: `__tests__/user-row-actions.test.tsx` keeps all eleven contracts,
  re-expressed through the menu (open the trigger, target items by name):
  no trigger on the self row, the two labels, role PATCH body per current
  role, the server's 409 sentence shown and auto-cleared, the password
  dialog's shown-once and confirm-gated flow, disable confirm vs enable
  immediate, busy locking.
- No AGENTS.md change: it describes the page's gating history, not the row
  controls' shape.

## Verification

`bun run verify-types && bun run lint:check && bun run test` in
`apps/server/web`; no server or package change, so no build-order concern.
