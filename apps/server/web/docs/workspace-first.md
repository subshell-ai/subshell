# Workspaces first

Deep dive for `apps/server/web`, moved out of `AGENTS.md` (and out of the
draft model it replaced on 2026-10-17). This file carries the rules behind the
summary; the routing line in `AGENTS.md` names when to read it.

A workspace is a window of tabs holding REFERENCES to live subshells, and the
pane world hangs off it: a launch lands as a tab in the workspace you're
viewing, `Split` is what creates one, and the row self-retires when its last
pane is removed. The server model (migration 0058, spec
`docs/superpowers/specs/2026-10-17-workspace-first-design.md`) is what the
client reads, so each rule below has both halves.

## The split flow

A workspace can begin on a subshell page: **Split**
(`components/split-subshell-button.tsx`) opens the same add-subshell dialog the
dock uses, creates a NAMED workspace around the current subshell
(`POST /api/workspaces { name, subshellId }`, named after the subshell), and
navigates to `/workspaces/$id?add=<subshellId>&dir=<direction>`. The dock and
the tab strip consume that intent once dockview is ready, through their
ordinary `handleAdd`, then strip the params, so the first split and every later
add run one code path, and the picker's direction is honoured. A failed add
KEEPS the params: the error banner would unmount with the screen if the page
navigated clean, so the person who pressed Split lands where they started with
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
  that one query plus one for the Ungrouped branch
  (`/api/subshells?workspace=none`). No per-workspace GET, no draft half to
  hide: there is nothing left for a list to lie about.
- `?subshellId=` is the one opt-in read, feeding the subshell page's workspace
  control (`components/subshell-workspace-link.tsx`). A subshell can sit on
  any number of workspaces, so that control has two shapes, decided by the
  pure `workspaceLinkView`: ONE is a direct link naming it, SEVERAL is
  "In N workspaces" opening a menu of all of them. The sort is stable so rows
  the server already ordered by recency keep that order when their timestamps
  tie, which they do, a split writing several rows inside one millisecond.
  Menu rows are real links (`render={<Link/>}` + `nativeButton={false}`), so
  middle-click still works.
- Adding a pane is IDEMPOTENT: `workspace_panes` is UNIQUE on
  `(workspace_id, subshell_id)`, and the second add returns the existing row
  with `alreadyPresent: true` rather than failing. Removing the LAST pane
  deletes the workspace (`removePane` resolves `{ workspaceDeleted }`) and the
  presentation takes the person to the subshell that remained, or to `/`.
  `POST /api/subshells` can file the launch (`workspaceId`), and deleting a
  subshell retires any of ITS owner's workspaces the delete emptied.

## The landing and the one-shot

`/` is a direction, not a page (`routes/index.tsx`): it opens the last visited
workspace (`rememberLastWorkspace`, validated against the live LIST so a row
that self-retired cannot be landed on), else the most recently touched one,
else an empty state with one button. That button arms the one-shot
(`requestCreateInNewWorkspace` in `lib/current-workspace.ts`) so the launch it
opens creates a fresh workspace (`POST /api/workspaces { name, subshellId }`)
and lands there; a launch from INSIDE a workspace files the tab into it
instead (`currentWorkspaceId()` rides the create body). The one-shot is CONSUMED
on read and reset with the dialog, so an abandoned launch does not make the
next one a workspace-maker.

## Pane focus in the header

The workspace header offers the focused pane's shared `SubshellActionsMenu` in
both dock and phone-tab presentations. Focus must name a pane in the current
workspace; a stale focus from another workspace cannot expose its actions.
Changing the focused subshell remounts the menu, closing dialogs for the old
pane. Insert prompt keeps the existing permissions and confirmation flow, and
touch copy mode uses the same persisted per-subshell setting as the key bar.
