import { Button } from "@internal/node-admin";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { DASH, MobilePair, RowRule, VersionCell } from "@/components/updates/row-cells";
import { useNodeUpdate } from "@/hooks/use-node-update";
import { endOnce } from "@/lib/update-copy";
import type { NodeUpdateRow, NodeUpdates } from "@/types/updates";

/**
 * What one row says about itself, in the fewest words that are true (spec §10).
 *
 * A HELD node is the interesting case and the reason the numbers travel with
 * the rows: "needs update" alone is unactionable, while "speaks protocol 9,
 * this server speaks 10" tells an operator which end is behind — and sometimes
 * the answer is the SERVER, which is the one conclusion a node-shaped sentence
 * would never reach.
 *
 * @param row - the node
 * @param fleet - the server's own floor and protocol, the other half of the sentence
 */
export function rowState(row: NodeUpdateRow, fleet: Pick<NodeUpdates, "minNodeVersion" | "protocol">): string {
  if (row.held?.reason === "below-floor") {
    return `needs update: below this server's minimum (${fleet.minNodeVersion})`;
  }
  if (row.held?.reason === "protocol-mismatch") {
    return `needs update: speaks protocol ${row.protocolVersion ?? "?"}, this server speaks ${fleet.protocol}`;
  }
  return row.online ? "online" : "offline";
}

/**
 * The fleet: what every enrolled node is running, and what it could run.
 *
 * `local` is never here — the control-plane host's update IS the Server row
 * above, and listing it twice would offer two buttons for one act.
 *
 * **Update all is sequential and stops at the first failure**, naming the node
 * it stopped on — in that row's own failure line, since the hook keeps the
 * failure and the row renders it. Firing them in parallel would have every machine downloading
 * from the release source at once and would leave a partial fleet with no
 * statement about which half moved; stopping is what makes the next press
 * resumable by simply pressing it again.
 *
 * The section opens with a full-width rule carrying its label and Update all:
 * the fleet is a section of the same table rather than its own card, and the
 * rule is both its heading and its separation from the Server row.
 */
export function NodeRows({ fleet }: { fleet: NodeUpdates }) {
  const nodeUpdate = useNodeUpdate();
  const [running, setRunning] = useState(false);
  const updatable = fleet.rows.filter((row) => row.canUpdate.ok);

  async function updateAll(): Promise<void> {
    // The single-press handler resets before it runs; the sequence must too,
    // or a refusal from before stays pinned on its row through (and after) a
    // run in which that row was never even asked.
    nodeUpdate.reset();
    setRunning(true);
    try {
      for (const row of updatable) {
        try {
          await nodeUpdate.update(row.id);
        } catch {
          // Stop the sequence, and say it ONCE. The hook keeps the failure and
          // the row it is on renders its own destructive line — the same
          // mechanism a single-row press uses, whose comment below names it —
          // so a section-bottom copy here printed the identical message twice
          // (review 2026-09-17). The row IS the "stopped here" statement: its
          // name cell labels the machine the line sits under.
          return;
        }
      }
    } finally {
      setRunning(false);
    }
  }

  const newest = fleet.release?.version ?? DASH;

  return (
    <>
      <div className="col-span-full flex flex-wrap items-center justify-between gap-3 border-t pt-2">
        <span className="font-strong text-label">Nodes</span>
        {fleet.rows.length > 0 && (
          <Button
            variant="outline"
            disabled={updatable.length === 0 || running || nodeUpdate.pendingNodeId !== null}
            onClick={() => void updateAll()}
          >
            {running && <LoaderCircle aria-hidden className="mr-1.5 size-3.5 animate-spin" />}
            {running ? "Updating…" : `Update all (${updatable.length})`}
          </Button>
        )}
      </div>

      {fleet.release === null && (
        <p className="col-span-full text-detail text-muted-foreground">
          No node release can be offered: {endOnce(fleet.reason ?? "no reason was given")}
        </p>
      )}

      {fleet.rows.length === 0 && (
        <p className="col-span-full text-muted-foreground text-sm">No machines are enrolled as nodes.</p>
      )}

      {fleet.rows.map((row, index) => {
        const runningValue = row.agentVersion ?? "version unknown";
        const updating = nodeUpdate.pendingNodeId === row.id;
        return (
          <div key={row.id} className="contents">
            {index > 0 && <RowRule />}
            <div className="min-w-0">
              <p className="truncate font-strong text-label">{row.name}</p>
              <p className="truncate text-detail text-muted-foreground">
                {row.target ?? "no published platform"} · {rowState(row, fleet)}
              </p>
              <MobilePair running={runningValue} newest={newest} />
            </div>
            <VersionCell value={runningValue} />
            <VersionCell value={newest} />
            <div className="flex items-center justify-end">
              <Button
                variant="outline"
                size="sm"
                disabled={!row.canUpdate.ok || running || nodeUpdate.pendingNodeId !== null}
                title={row.canUpdate.reason ?? undefined}
                onClick={() => {
                  nodeUpdate.reset();
                  void nodeUpdate.update(row.id).catch(() => {
                    // The hook keeps the failure and the row renders it; a
                    // rejection here is the sequence's contract, not an error
                    // this press has anywhere else to put.
                  });
                }}
              >
                {/* The POST blocks for the node's whole download-and-restart
                    window, up to five minutes, so a bare disabled button reads
                    as nothing happening. */}
                {updating && <LoaderCircle aria-hidden className="mr-1.5 size-3.5 animate-spin" />}
                {updating ? "Updating…" : "Update"}
              </Button>
            </div>
            {!row.canUpdate.ok && row.canUpdate.reason !== null && (
              <p className="col-span-full truncate text-detail text-muted-foreground">{row.canUpdate.reason}</p>
            )}
            {nodeUpdate.failure?.nodeId === row.id && (
              <p role="alert" className="col-span-full text-destructive text-detail">
                {nodeUpdate.failure.message}
              </p>
            )}
          </div>
        );
      })}
    </>
  );
}
