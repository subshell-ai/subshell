# Workspaces first

Deep dive for `apps/server/web`, moved out of `AGENTS.md` (and out of the
draft model it replaced on 2026-10-17). This file carries the rules behind the
summary; the routing line in `AGENTS.md` names when to read it.

A workspace is a window of tabs holding REFERENCES to live subshells, and the
pane world hangs off it: a launch lands as a tab in the workspace you're
viewing, launching a first subshell creates one, and removing the final tab
retires the workspace (ruling 2026-10-20; the subshell itself keeps running,
unfiled). The server model (migration 0058, spec
`docs/superpowers/specs/2026-10-17-workspace-first-design.md`) is what the
client reads, so each rule below has both halves.

## Adding subshells

The existing-subshell picker lists eligible subshells across nodes. The new
launch form's node choice never filters that list. Sidebar drops persist a pane
against the workspace that received the drop, then refresh membership; they
never defer the write through a navigation parameter. Switching workspaces
while the request finishes cannot file the pane into the new destination.

In the new-workspace dialog, **Create workspace** on the **New subshell** tab
launches the configured subshell and adds it before entering the workspace.
A failed launch creates no empty workspace; a failed workspace creation keeps
the successful launch selected so retrying doesn't launch another process.

A workspace can begin on a subshell page: **Add a subshell to a workspace**
(`components/split-subshell-button.tsx`) opens the same add-subshell dialog the
dock uses, creates a NAMED workspace around the current subshell
(`POST /api/workspaces { name, subshellId }`, named after the subshell), and
navigates to `/workspaces/$id?add=<subshellId>&dir=<direction>`. The dock and
the tab strip consume that intent once dockview is ready, through their
ordinary `handleAdd`, then strip the params, so the first split and every later
add run one code path, with new subshells added as tabs. Split controls are omitted from the dialog
and tab context menu; desktop users arrange splits by dragging tabs. A failed add
KEEPS the params: the error banner would unmount with the screen if the page
navigated clean, so the person adding a subshell lands where they started with
something said. A reload with the params already gone must not re-add
(regression #13), which is what the idempotent add makes cheap to guarantee.

**The create response is CHECKED, not trusted** (`lib/split-workspace-refusal.ts`).
Elysia strips body fields a schema does not declare, so a server older than
this page answers the split with a plain 200 and silently drops `subshellId`,
landing the person on a workspace missing the subshell they split from. That
happened on 2026-09-14 against a dev SPA proxying to an installed binary built
hours earlier. The button now refuses a response whose `subshellCount` is not
1, deletes the empty workspace such a server did create, and says the server is
behind. (It used to also require `draft: true`; drafts are gone, and a 409 from
a pre-0058 server whose names were still unique is read the same way: as a
server-behind message, not as a name complaint.)

## Membership and the reads

- `GET /api/workspaces` carries every workspace of the caller's WITH its
  panes (`WorkspaceListItem.panes`), which is what the rail's Workspaces tree
  (`components/sidebar/workspaces-section.tsx`) renders: the whole tree is
  that one query. The tree shows workspaces ONLY: a pane that lives in none
  appears in the subshells list's machine groups, not in an "Ungrouped"
  branch (operator ruling 2026-10-17 removed that section, and the rail's
  read of `/api/subshells?workspace=none` with it). No per-workspace GET,
  no draft half to hide: there is nothing left for a list to lie about.
- `?subshellId=` is the one opt-in read, feeding the subshell page's workspace
  control (`components/subshell-workspace-link.tsx`). A subshell can sit on any
  number of workspaces; the control names none of them up front (operator
  ruling 2026-09-27: the header has no space to spend). It is an icon and the
  count, and it always opens a menu, the lone holder included. What the pure
  `workspaceLinkView` decides is the menu's rows and their order. The sort is
  stable so rows the server already ordered by recency keep that order when
  their timestamps tie, which they do, a split writing several rows inside one
  millisecond. Menu rows are real links (`render={<Link/>}` +
  `nativeButton={false}`), so middle-click still works.
- Adding a pane is IDEMPOTENT: `workspace_panes` is UNIQUE on
  `(workspace_id, subshell_id)`, and the second add returns the existing row
  with `alreadyPresent: true` rather than failing. Removing the final tab
  retires the workspace (ruling 2026-10-20, the same empty-retire the close
  path uses): the subshell keeps running unfiled, and the surface that
  removed the tab leaves the retired page. Closing a subshell itself remains
  a separate action.
  `POST /api/subshells` can file the launch (`workspaceId`), and deleting a
  subshell retires any of ITS owner's workspaces the delete emptied.

## Always in a workspace

There is no subshell-side of the app to fall out of (operator ruling, spec
2026-10-17):

- A LAUNCH files itself, into a workspace that EXISTS first (operator
  revision 2026-10-18: each press opening another fresh window on top of
  the one you just left was not the rule). `currentWorkspaceId()` rides
  the create body when a workspace page is on screen; with none there,
  `useCreateSubshell` (its `autoFile` default) JOINS an existing workspace
  after the POST through the idempotent pane-add call - the one this
  device last visited when it still exists, else the most recently
  touched - and the dialog lands there. Only an instance with no
  workspace at all (or a join that lost a retire race) opens a fresh one
  around the pane, named after it. Callers that file the pane themselves
  - the add-a-pane dialog, whose `onAdd` is the split's and the dock's
  path, and the new-workspace dialog, which created the workspace first -
  pass `autoFile: false`, or one launch would leave two workspaces
  holding the same row.
- A SELECTION means a tab. `hooks/use-open-pane-as-tab.ts` backs every plain
  left-click on a rail row or cell: focus the pane if the
  dock on screen holds it (`requestWorkspacePaneFocus`), else open the most
  recently touched workspace that holds it, else create one around it. The
  destination presentation takes the armed `armPaneFocusOnArrive` id once
  its panes exist and activates that tab. Middle-click and open-in-new-tab
  ride the row's real href, which stays `/subshells/$id`.
- `/` is still a direction (`routes/index.tsx`): the last visited workspace
  (`rememberLastWorkspace`, validated against the live LIST so a retired row
  cannot be landed on), else the most recently touched, else the empty state
  whose single button just opens the launch dialog - the create hook knows to
  open the window.

`lib/current-workspace.ts` keeps only those two facts (module-current,
localStorage-last); the landing's "make a workspace" one-shot died with this
rule because every launch now makes one anyway when there is nothing to join.
A failed create leaves a running ungrouped pane and the detail landing -
honest, and clicking that pane later files it the same way. Bearer/MCP
creates stay unfiled (no human screen to file into), which is what the
subshells list's machine-group rows exist for: they are the drag source for
"drop this onto a workspace" and the click-means-a-tab rows that build one.

## The pane-focus bar and renaming

The bar above the dock is the FOCUSED PANE's subshell header
(`components/pane-focus-header.tsx`), not a workspace title bar: dot, editable
name, working directory, the pane's disclosures and its shared
`SubshellActionsMenu` (spec 2026-10-17; the workspace header component is
deleted). Focus arrives through `lib/workspace-focus` and must name a pane of
the CURRENT workspace; a stale focus from another workspace hoists nothing.
Changing the focused pane remounts the edit control and the menu (`key`), so
dialogs never outlive the pane they named. Insert prompt keeps the existing
permissions and confirmation flow, and touch copy mode uses the same persisted
per-subshell setting as the key bar.

The workspace's own NAME has no control on the page any more. It is edited
from the workspace selector’s actions menu
(`Rename…` in `components/workspace-actions-menu.tsx`, which owns the
PUT), and shown in plain on the bar only while the workspace holds no pane.

The `/workspaces` overview is gone. Both `/` and `/workspaces` use
`WorkspaceLanding` to resume the last available workspace. The latter keeps
the workspace sidebar available when none exist, so its selector can create
one. The workspace header has no back link to an overview.
