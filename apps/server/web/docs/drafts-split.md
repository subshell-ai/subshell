# Drafts and the split flow

Deep dive for `apps/server/web`, moved verbatim out of `AGENTS.md`.
This file carries the full history behind the summary; the routing line in
`AGENTS.md` names when to read it.

A workspace can begin on a subshell page: **Split** (`components/split-subshell-button.tsx`)
opens the same add-subshell dialog the dock uses, creates a DRAFT workspace
around the current subshell (`POST /api/workspaces { draft: true, subshellId }`)
and navigates to `/workspaces/$id?add=<subshellId>&dir=<direction>`. The dock
and the tab strip consume that intent once dockview is ready, through their
ordinary `handleAdd`, then strip the params, so the first split and every later
add run one code path, and the picker's direction is honoured.

Three rules keep a draft honest, and each is load-bearing:

- **Drafts are absent from `GET /api/workspaces`**, so `/workspaces`, the
  sidebar recents and the cards need no draft awareness. The only read that
  returns them is `?subshellId=`, which feeds the subshell page's workspace
  control (`components/subshell-workspace-link.tsx`). A subshell can sit on
  any number of workspaces, so that control has two shapes, decided by the
  pure `workspaceLinkView`: ONE is a direct link naming it, SEVERAL is
  "In N workspaces" opening a menu of all of them. Drafts lead and read
  "Unsaved workspace" rather than their placeholder name, and the sort is
  stable so rows the server already ordered by recency keep that order when
  their timestamps tie, which they do, a split writing several rows inside
  one millisecond. Menu rows are real links (`render={<Link/>}` +
  `nativeButton={false}`), so middle-click still works.
- **A draft below two panes is discarded**: server-side when a pane is removed
  (`removePane` resolves `{ workspaceDeleted }`), and client-side on read by
  `hooks/use-discard-thin-draft.ts`, which sends the person back to the
  remaining subshell. That hook is GUARDED by the `?add=` intent: a freshly
  created draft is one pane for as long as its second pane is in flight, and the
  presentations strip the params only after the refetch shows both, and only
  when the add actually LANDED. A failed add keeps the params, so the guard
  stays engaged and the error banner stays on screen instead of the draft
  being discarded from under it with nothing said (review, 2026-09-14). Break
  that ordering and every split discards itself.
- **`useInvalidateWorkspaces` also invalidates the per-subshell membership
  query**, so a link to a draft never outlives the draft.
- **The create response is CHECKED, not trusted** (`lib/split-workspace-refusal.ts`).
  Elysia strips body fields a schema does not declare, so a server older than
  this page answers the split with a plain 200 and silently drops both `draft`
  and `subshellId`, landing the person on a workspace missing the subshell
  they split from. That happened on 2026-09-14 against a dev SPA proxying to an
  installed binary built hours earlier. The button now refuses a response that
  is not `{ draft: true, subshellCount: 1 }`, deletes the empty workspace such
  a server did create, and says the server is behind.

`WorkspaceHeader` renders a draft with a static "Unsaved workspace" title plus
**Save workspace…** (`PUT /:id { name, draft: false }`, the one transition) and
**Discard**; the presentation supplies `onDiscarded` so a discard lands on the
active pane's subshell. Copy says "unsaved workspace"; code says `draft`.
