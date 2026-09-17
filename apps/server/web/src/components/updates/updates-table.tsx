import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DesktopRows } from "@/components/updates/desktop-rows";
import { NodeRows } from "@/components/updates/node-rows";
import { RowRule } from "@/components/updates/row-cells";
import { ServerRow } from "@/components/updates/server-row";
import type { StartServerUpdate } from "@/hooks/use-updates";
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
  serverVersion,
}: {
  /** `GET /api/admin/updates` in full */
  view: UpdatesView;
  /** The page's update handle */
  update: StartServerUpdate;
  /** Re-read the release source now */
  onCheck: () => void;
  /** True while that check is in flight */
  checking: boolean;
  /** What the instance reports it is running, for the bundled-server line */
  serverVersion: string | undefined;
}) {
  return (
    <Card>
      {/* No description: the page header already says what this table is.
          The old cards' captions ("X is available. Running Y.", "Nodes can be
          updated to X.") stated what the Running and Newest columns now state
          per row — one voice, in the middle of each row, not above sections. */}
      <CardHeader>
        <CardTitle>Components</CardTitle>
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
          <DesktopRows desktop={view.desktop} />
          <RowRule />
          <ServerRow
            view={view.server}
            update={update}
            onCheck={onCheck}
            checking={checking}
            serverVersion={serverVersion}
          />
          <NodeRows fleet={view.nodes} />
        </div>
      </CardContent>
    </Card>
  );
}
