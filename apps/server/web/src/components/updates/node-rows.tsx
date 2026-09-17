import { useState } from "react";
import { Button } from "@/components/ui/button";
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
export function rowState(row: NodeUpdateRow, fleet: Pick<NodeUpdates, "minAgentVersion" | "protocol">): string {
  if (row.held?.reason === "below-floor") {
    return `needs update — below this server's minimum (${fleet.minAgentVersion})`;
  }
  if (row.held?.reason === "protocol-mismatch") {
    return `needs update — speaks protocol ${row.protocolVersion ?? "?"}, this server speaks ${fleet.protocol}`;
  }
  return row.online ? "online" : "offline";
}

/**
 * The fleet: what every enrolled agent is running, and what it could run.
 *
 * `local` is never here — the control-plane host's update IS the Server row
 * above, and listing it twice would offer two buttons for one act.
 *
 * **Update all is sequential and stops at the first failure**, naming the node
 * it stopped on. Firing them in parallel would have every machine downloading
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
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const updatable = fleet.rows.filter((row) => row.canUpdate.ok);

  async function updateAll(): Promise<void> {
    setRunError(null);
    setRunning(true);
    try {
      for (const row of updatable) {
        try {
          await nodeUpdate.update(row.id);
        } catch (error) {
          setRunError(`${row.name}: ${error instanceof Error ? error.message : String(error)}`);
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
                  setRunError(null);
                  nodeUpdate.reset();
                  void nodeUpdate.update(row.id).catch(() => {
                    // The hook keeps the failure and the row renders it; a
                    // rejection here is the sequence's contract, not an error
                    // this press has anywhere else to put.
                  });
                }}
              >
                Update
              </Button>
            </div>
            {!row.canUpdate.ok && row.canUpdate.reason !== null && (
              <p className="col-span-full truncate text-detail text-muted-foreground">{row.canUpdate.reason}</p>
            )}
            {nodeUpdate.failure?.nodeId === row.id && (
              <p className="col-span-full text-destructive text-detail">{nodeUpdate.failure.message}</p>
            )}
          </div>
        );
      })}

      {runError !== null && <p className="col-span-full text-destructive text-detail">{runError}</p>}
    </>
  );
}
