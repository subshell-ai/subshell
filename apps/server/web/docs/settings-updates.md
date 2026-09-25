# /settings/updates: one Components table

Deep dive for `apps/server/web`, moved verbatim out of `AGENTS.md`.
This file carries the full history behind the summary; the routing line in
`AGENTS.md` names when to read it.

**`/settings/updates` is ONE Components table, not three cards** (2026-09-17).
The two desktop apps, the Server and the fleet share one grid (name / running
/ newest / act), because those are the same four questions in every row, and a
card each put "newest" at a different x per section, so the table's read (scan
the middle two columns, spot the mismatch) had to be reconstructed by the
reader instead of seen. The mechanics are `installed-plugins-card.tsx`'s (its
long comment carries the track sizing and the `display: contents` rows), with
one deliberate divergence: plugins get one grid PER GROUP because their groups
are different kinds of thing, while here the columns must agree ACROSS
sections or the table says nothing. Everything that is not a cell (job
phases, `canApply` blockers, the backup sentence, held-node reasons, a run's
failure) is a `col-span-full` detail line inside its row, in the order the
old cards carried them, and below `sm` the version pair folds into the name
cell as `running → newest` (`row-cells.tsx`). The row order (desktop apps,
Server, Nodes last) is the operator's 2026-09-17 call and is pinned by
`updates-table.test.tsx`, since nothing else on the page would notice a swap.
The old card descriptions ("X is available. Running Y.", "Nodes can be updated
to X.") are gone on purpose: the two version cells state that per row, in one
voice. **A node update's last act lands AFTER its 202** (2026-09-23), which is
why `node-rows.tsx` owns a bounded watcher the Server row's job-poll already
set the precedent for: the POST answers ACCEPTANCE, the agent restarts seconds
later, and the page's standing "no cadence" rule would otherwise leave the row
stating the old version forever (operator: "the update did work but it didn't
update the version or say that it was success"). While any row is installing,
the rows ride a 2 s poll of `NODES_QUERY_KEY` (`enabled`-gated, self-stopping
when every watch is terminal) and the row says accepted-installing, then
"Updated to X." with the version cells invalidated, then (after two minutes
without a return) says the machine has not come back rather than hold a
green line forever. `nextPhase` is exported and pure for exactly that
three-branch test.

**Inside Subshell Server the app row and the Server row are ONE row** (spec
2026-09-18 D4, `folded-server-row.tsx`). That app SHIPS the server it would
install, so on that machine "update the app" and "update the server" are one
act whose second half is the first half's tail. Two rows and three controls
for it was our packaging presented as the user's decision. The folded row
states BOTH pairs (the app's in the cells, since the row is named for the app;
the server's as its detail line) and offers ONE control, which opens the
assistant, the only surface allowed to drive either install. `DesktopRows` is
asked for the client alone there, and its server branch is DELETED rather than
left unreachable. A browser is untouched and keeps both rows, the
release-source Update and the release links, because nothing there can install
anything on a machine the page is not running on.

**Re-check lives in the card header**, not in the Server row (operator's call,
2026-09-18). It always invalidated the whole `UPDATES_QUERY_KEY`
(deliberately, so no row keeps stating what the previous read said while the
Server row moves), so sitting in that row's action cell only made a global
control read as a server-only one. Its behaviour did not change.
