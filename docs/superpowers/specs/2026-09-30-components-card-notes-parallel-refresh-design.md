# Components card: Notes for the CLI rows, parallel Update all, refresh keeps its story

Date: 2026-09-30. Builds on the updates design (2026-09-15, §15 shipped) and the
server-side tracker (2026-09-25).

## Summary

Three fixes to the Components table (`apps/server/web/src/components/updates/`),
all web-only; no route, schema or CLI changes.

1. The Server row and the Nodes section gain the `Notes` release-page link the
   desktop rows already carry.
2. "Update all" fires its nodes in parallel instead of one at a time.
3. A page refreshed during an update stops going blind: the server job's live
   phases raise the poll cadence, and node rows take their busy state from the
   tracker instead of from the tab's memory.

## Item 1: Notes on the CLI rows

**The defect, as observed.** A browser shows `Notes` under both desktop app
rows and under neither CLI row. The Server row and the Nodes section hold the
same `ReleaseRef` (with its `tag`) that the desktop rows link with, so the
information is already in the payload; the link was simply only ever written
for the desktop rows.

**The rulings (operator, 2026-09-30).** One `Notes` link in the Nodes section
header, not one per row: the whole fleet is offered one node release, so every
row's link would be the same page. The Server row gets its link beside the
Update button. Browser surfaces only, matching the existing desktop-row rule
that a dash answers inside the app windows.

**Mechanics.** `releasePageUrl` moves out of `desktop-rows.tsx` to
`components/updates/row-cells.tsx`, the shared cell vocabulary of this table,
and the three call sites import it. The link is present whenever the release
it names is non-null (`view.latest` for the Server row, `fleet.release` for
Nodes), up-to-date rows included, exactly as the desktop rows behave. Styling
copies the desktop rows' anchor classes (`text-detail underline`).

## Item 2: Update all is parallel

**The defect, as observed.** The button works through the fleet one POST at a
time, each blocking until its node answers.

**Why it was sequential.** The original rationale (comment in `node-rows.tsx`):
a parallel fleet would download at once and "leave a partial fleet with no
statement about which half moved", and stopping at the first failure made the
next press resumable. The first half of that sentence is obsolete: nodes
download from the plane, not from GitHub (the `nut_` single-use token route),
and the plane memoizes its own release fetch. The second half was written
before the server-side tracker (design 2026-09-25), which now states every
node's own story on its own row, independently of any other row.

**The ruling (operator, 2026-09-30).** Fire all ordered nodes concurrently;
each runs to its own end; each failure reports on its own row. No global
stop-at-first-failure. A refusal that never opened a tracker entry (offline,
too old, would kill panes: everything the route refuses BEFORE
`beginUpdate`) has no server-side story, so the tab keeps a per-node failure
map (`Record<nodeId, string>`) for exactly those, rendered by the same row
mechanism a single press uses today.

**Mechanics.**

- `useNodeUpdate` gains the batch shape: `update(nodeId)` stays promise-returning
  (the single-press path is one call). The single `useMutation` cannot name
  more than its latest variables, so the hook drops it for plain `useState`
  maps it already outgrew: an in-flight set (`pendingNodeIds`) and a failure
  map (`Record<nodeId, string>`). Each settled success invalidates the queries
  as today. `node-update-card.tsx` (the node detail page) is the hook's other
  consumer, through `pendingNodeId`; it switches to `pendingNodeIds.has(id)`,
  which reads the same on a card that can only press one node at a time.
- `updateAll` captures the updatable ids, fires every POST concurrently, and
  awaits `Promise.allSettled`; the run ends when all have settled. No
  cancellation exists: a dispatched node update cannot be recalled, which is
  part of why the old stop-at-failure bought less than it appeared to.
- The header button reads `Updating…` with a spinner while this tab's run is
  in flight. The old `Updating 1 of 2…` counter named a sequence position,
  and a sequence is what no longer exists.
- The pinned tests that assert the counter and the stop ("says a failed
  'Update all' ONCE, on the row it stopped at") are rewritten to the new
  contract: every row keeps its own single statement, and one row's refusal
  does not silence the others' progress.

## Item 3: A refresh keeps the update's story

**The defect, as observed.** Reload the page while the Server row is
downloading and the job line freezes at the moment of load: MB stops counting,
phases stop moving, and the row never learns the update finished.

**Root cause.** `GET /api/admin/updates` carries the job (server state, it
survives the reload), but nothing re-reads it. `updatesPollMs`
(`apps/server/web/src/lib/updates-poll.ts`) raises the 2 s cadence only from
the tracker's live entries, and the server's OWN tracker entry starts at the
swap: `beginSelfUpdate` runs in `server-update.ts`'s `restarting` phase, after
download, verify and backup. So for the longest stretch of a server update a
refreshed page has no live entry to see, returns `false` from the gate, and
never refetches. (The tab that pressed is unaffected: it passes its explicit
1 s cadence.)

**Mechanics.**

- `updatesPollMs` gains one gate ahead of the tracker checks: a job in any
  phase other than `failed` returns the active cadence. It is a server fact,
  so the refreshed page picks the cadence back up on its first read, the same
  property the node tracker was built for. When the server exits for its
  restart the gate is still `restarting`, the query keeps refetching into the
  outage, and the page catches the new boot when it answers: `job` is null,
  the boot finalizer has re-created the terminal tracker entry, and the row
  shows `Updated to X.` (or the revert) with no user action.
- Node rows: `busy` for a row becomes "this tab's POST is in flight OR the
  row's tracker entry is live (`working` / `restarting`)". The row button's
  spinner and disabled state read that, and `Update all` is disabled while any
  row is busy or its own run is in flight. `activeId` / `run` shrink to this
  tab's press bookkeeping; every refresh-surviving statement stays the
  tracker's, as designed 2026-09-25. A `stalled` row is not busy: the button
  re-enables two minutes on, matching the tracker's own "a human takes over"
  reading.
- Not done, deliberately: persisting the tab's run to storage. The server
  already holds the truth; a second client-side copy of it would only drift.

## Tests

- `updates-poll.test.ts`: live server job (each non-failed phase) yields the
  active cadence; a `failed` job does not; precedence of the explicit cadence
  unchanged.
- `updates-node-rows.test.tsx`: parallel dispatch (two POSTs in flight at
  once), one refusal does not stop the other row, per-node failure lines
  render once, a live tracker entry alone (no press) spins the row and
  disables both buttons.
- `updates-server-row.test.tsx` / a new table-level test: the Server row's
  Notes link and the Nodes header Notes link appear with a release and vanish
  without one, in the browser surfaces only.
- `updates-desktop-rows.test.tsx`: unchanged behavior after the `releasePageUrl`
  move (import path only).

## Verification

Focused: `bun test` on the files above, `bunx turbo verify-types
--filter=@internal/server-web`, `bunx biome check` on changed paths. At the
boundary: `bun run verify-types`, `bun run lint:check`, `bun run lint:prose`,
`bun run test`.
