import { Button, Card, CardContent, CardHeader, CardTitle } from "@internal/node-admin";
import { DesktopRows } from "@/components/updates/desktop-rows";
import { FoldedServerRow } from "@/components/updates/folded-server-row";
import { NodeRows } from "@/components/updates/node-rows";
import { RowRule } from "@/components/updates/row-cells";
import { ServerRow } from "@/components/updates/server-row";
import type { StartServerUpdate } from "@/hooks/use-updates";
import { desktopShell } from "@/lib/desktop";
import type { UpdatesView } from "@/types/updates";

/**
 * Every component this instance can run, in one table (spec 2026-09-15 §6,
 * consolidated 2026-09-17): two desktop rows, the Server row, and the fleet.
 *
 * Three cards became one because the four columns hold the SAME kind of thing
 * in every row — what it is, what it runs, what it could run, what to do —
 * and a card each put "newest" at a different x in every section, so the
 * table's whole read (scan the middle two columns, spot the mismatch) was
 * something each reader had to reconstruct instead of see.
 *
 * ONE grid, deliberately not one per section as `installed-plugins-card.tsx`
 * does — its long comment carries the track sizing and the `display: contents`
 * mechanics, and it explains too why groups there get separate grids: they are
 * different KINDS of thing whose columns need not agree. Here the columns are
 * one question asked of every component, so their tracks agree across the
 * whole table or the table is not saying anything.
 *
 * Everything a row says that is not a cell — job phases, blockers, the backup
 * sentence, held-node reasons — is a `col-span-full` detail line inside the
 * row's `contents` wrapper, in the order the old cards carried them. Below
 * `sm` the version pair folds into the name cell (`row-cells.tsx`).
 */
export function UpdatesTable({
  view,
  update,
  onCheck,
  checking,
}: {
  /** `GET /api/admin/updates` in full */
  view: UpdatesView;
  /** The page's update handle */
  update: StartServerUpdate;
  /** Re-read the release source now */
  onCheck: () => void;
  /** True while that check is in flight */
  checking: boolean;
}) {
  const shell = desktopShell();
  // Narrowed rather than asked twice, so the branch below and `FoldedServerRow`
  // cannot disagree about which shell this is — the component takes a non-null
  // shell precisely because it is unreachable without one.
  const inServerApp = shell?.app === "server";
  return (
    <Card>
      {/* No description: the page header already says what this table is.
          The old cards' captions ("X is available. Running Y.", "Nodes can be
          updated to X.") stated what the Running and Newest columns now state
          per row — one voice, in the middle of each row, not above sections. */}
      {/* Re-check sits HERE, not in the Server row, because that is what it
          has always done: `useCheckUpdates` invalidates the whole
          `UPDATES_QUERY_KEY` on success — deliberately, so the desktop and
          node rows cannot keep stating what the previous read said while the
          Server row moves. In the Server row's action cell it READ as
          server-only, which is the operator's report of 2026-09-18 ("re-check
          should be a global button"). Nothing about its behaviour changed. */}
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle>Components</CardTitle>
        <Button variant="outline" size="sm" disabled={!view.server.source.enabled || checking} onClick={onCheck}>
          {checking ? "Checking…" : "Re-check"}
        </Button>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
          {/* A header row: the four questions, in the order every row answers
              them. Running/Newest hide below `sm` with their columns. */}
          <div className="font-strong text-detail text-muted-foreground">Name</div>
          <div className="hidden font-strong text-detail text-muted-foreground sm:block">Running</div>
          <div className="hidden font-strong text-detail text-muted-foreground sm:block">Newest</div>
          <div className="justify-self-end font-strong text-detail text-muted-foreground">Update</div>
          <RowRule />

          {/* The order is the operator's call (2026-09-17, pinned by
              updates-table.test.tsx): the two desktop rows lead, the Server
              follows, and the fleet is last because it is the only section
              that grows with the machines enrolled. */}
          {/* Inside Subshell Server the app row and the Server row are ONE
              row (spec 2026-09-18 D4): the app SHIPS the server, so they are
              one act, and the assistant is the only surface that can drive
              either half. The client app's row stays beside it — that is a
              different product, and this window cannot install it.

              In a BROWSER nothing folds: the page cannot raise a window on a
              machine it is not running on, so the release-source update and
              the release links are the only controls that can exist there. */}
          {inServerApp ? (
            <>
              <FoldedServerRow shell={shell} app={view.desktop.server} server={view.server} />
              <RowRule />
              <DesktopRows desktop={view.desktop} apps={["client"]} />
            </>
          ) : (
            <>
              <DesktopRows desktop={view.desktop} />
              <RowRule />
              {/* The tracker's self entry rides too: an update ordered from
                  ANY tab (or by the last boot) gets its ending read here by
                  whoever opens the page next. Inside Subshell Server the
                  bundled-install path shells to the CLI, which the server-side
                  tracker cannot see, and the assistant owns that story - so it
                  belongs to this browser row only. */}
              <ServerRow view={view.server} update={update} serverUpdate={view.serverUpdate} />
            </>
          )}
          <NodeRows fleet={view.nodes} />
        </div>
      </CardContent>
    </Card>
  );
}
