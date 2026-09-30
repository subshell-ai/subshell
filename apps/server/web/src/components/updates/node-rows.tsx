import { Button } from "@internal/node-admin";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { DASH, MobilePair, RowRule, releasePageUrl, VersionCell } from "@/components/updates/row-cells";
import { useNodeUpdate } from "@/hooks/use-node-update";
import { desktopShell } from "@/lib/desktop";
import { endOnce } from "@/lib/update-copy";
import { isUpdateLive } from "@/lib/updates-poll";
import type { NodeUpdateRow, NodeUpdates, UpdateTrackerState } from "@/types/updates";

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
  // The third refusal (spec 2026-09-24 ledger R3): a node that passed BOTH the
  // floor and the protocol but has no encryption pin. A held row whose reason is
  // neither of the two above can only be that one, so the test is a catch-all on
  // `held` rather than a `=== "encryption-required"` — the client's `HeldReason`
  // union lives in the Apache `@internal/node-admin` package (out of scope for
  // this change), and naming the new literal here would be an un-overlapping
  // comparison against a type that has not grown it. Same remedy the other chips
  // point at: the node updates and registers.
  if (row.held) {
    return "node needs to re-pair its encryption identity";
  }
  return row.online ? "online" : "offline";
}

/**
 * What one tracker entry says on its row, in the page's own words.
 *
 * The phase is SERVER state (design 2026-09-25: `update-tracker.ts` on the
 * server, mirrored into this payload), not component memory — which is what
 * lets a refreshed page, or a second admin tab, pick up an in-flight update
 * mid-sentence instead of after the fact. The older reason still stands too:
 * a node update's LAST act lands AFTER the POST answers (operator report,
 * 2026-09-23: "the update did work but it didn't update the version"), and
 * the tracker is now the thing that knows.
 */
function updateLine(row: NodeUpdateRow, update: UpdateTrackerState): string {
  switch (update.phase) {
    case "working":
    case "restarting":
      // One sentence for both live phases: to the page they are the same
      // fact, the machine is on its way; only the server knows which half.
      return `${row.name} is installing ${update.to} and will reconnect by itself.`;
    case "done":
      return `Updated to ${update.to}.`;
    case "failed":
      return `The update to ${update.to} did not land: ${update.message ?? "the node gave no reason"}.`;
    case "stalled":
      return `The update was accepted, but ${row.name} has not reported ${update.to} yet. It may still be restarting; reload to check.`;
  }
}

/**
 * The fleet: what every enrolled node is running, and what it could run.
 *
 * **Update all fires every updatable row at once** (spec 2026-09-30). The
 * original sequence stopped at the first failure so a partial fleet could
 * not read as unexplained; the server tracker (design 2026-09-25) states
 * each machine's own story on its own row now, so the sequence protected a
 * silence that no longer exists - and nodes download from the plane, which
 * memoizes its own release fetch, so a parallel batch is N LAN reads, not
 * N hits on the release source. A dispatched update cannot be recalled,
 * which is what the old stop actually bought.
 *
 * A row is busy when the tracker says live, or this tab's POST is in
 * flight; the second covers only the window before the payload catches up,
 * the first is what keeps spinning and locking through a REFRESH or on a
 * tab that never pressed. `Update all` and every row button lock on that;
 * the tab's own batch additionally labels the header "Updating…".
 *
 * The section opens with a full-width rule carrying its label, the offered
 * release's Notes link (one for the section: every row is offered the same
 * release page), and Update all.
 */
export function NodeRows({ fleet }: { fleet: NodeUpdates }) {
  const nodeUpdate = useNodeUpdate();
  // True while THIS tab's batch has unsettled POSTs. Row busy no longer
  // reads this (the tracker owns busy); it only labels the header and keeps
  // the whole fleet locked while the tab's own press is half-dispatched.
  const [batch, setBatch] = useState(false);
  // Browser surfaces only: the dash-inside-the-app rule the desktop rows
  // already follow (`link = shell === null && release !== null`), because a
  // target="_blank" anchor is inert in a Tauri webview, a dead control.
  const inBrowser = desktopShell() === null;

  const updatable = fleet.rows.filter((row) => row.canUpdate.ok);
  const rowBusy = (row: NodeUpdateRow): boolean => nodeUpdate.pendingNodeIds.has(row.id) || isUpdateLive(row.update);
  const anyBusy = batch || fleet.rows.some(rowBusy);

  async function updateAll(): Promise<void> {
    // The run clears prior refusals first, or a refusal from before stays
    // pinned on a row this run never even asked.
    nodeUpdate.reset();
    setBatch(true);
    try {
      // allSettled, not all: every row's outcome owns its own row, and one
      // rejection must not silence, or march past, the others.
      await Promise.allSettled(updatable.map((row) => nodeUpdate.update(row.id)));
    } finally {
      setBatch(false);
    }
  }

  const newest = fleet.release?.version ?? DASH;

  return (
    <>
      <div className="col-span-full flex flex-wrap items-center justify-between gap-3 border-t pt-2">
        <span className="font-strong text-label">Nodes</span>
        <div className="flex items-center gap-3">
          {inBrowser && fleet.release !== null && (
            <a
              href={releasePageUrl(fleet.release.tag)}
              target="_blank"
              rel="noreferrer"
              className="text-detail underline hover:text-foreground"
            >
              Notes
            </a>
          )}
          {fleet.rows.length > 0 && (
            <Button variant="outline" disabled={updatable.length === 0 || anyBusy} onClick={() => void updateAll()}>
              {batch && <LoaderCircle aria-hidden className="mr-1.5 size-3.5 motion-safe:animate-spin" />}
              {batch ? "Updating…" : `Update all (${updatable.length})`}
            </Button>
          )}
        </div>
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
        // Busy FIRST from the server's fact, then this tab's POST: the
        // spinner survives the refresh, the second covers the gap before
        // the payload catches up.
        const updating = rowBusy(row);
        // The tracker entry rides the row (design 2026-09-25): every
        // sentence about an ordered update comes from the server's fact,
        // so a refresh or a second tab reads the same story mid-flight.
        const tracked = row.update;
        const failure = nodeUpdate.failures[row.id];
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
                disabled={!row.canUpdate.ok || batch || updating}
                title={row.canUpdate.reason ?? undefined}
                onClick={() => {
                  void nodeUpdate.update(row.id).catch(() => {
                    // The failure map keeps the refusal and the row renders
                    // it; the rejection is the hook's batch contract, not
                    // an error this press has anywhere else to put.
                  });
                }}
              >
                {/* The POST blocks for the node's whole download-and-restart
                    window, up to five minutes, and the tracker keeps this
                    spinner on after the POST answers, so a bare disabled
                    button reads as nothing happening. */}
                {updating && <LoaderCircle aria-hidden className="mr-1.5 size-3.5 motion-safe:animate-spin" />}
                {updating ? "Updating…" : "Update"}
              </Button>
            </div>
            {!row.canUpdate.ok && row.canUpdate.reason !== null && (
              <p className="col-span-full truncate text-detail text-muted-foreground">{row.canUpdate.reason}</p>
            )}
            {tracked != null && (
              <p
                className={`col-span-full text-detail ${
                  tracked.phase === "done" || tracked.phase === "working" || tracked.phase === "restarting"
                    ? "text-success"
                    : tracked.phase === "failed"
                      ? "text-destructive"
                      : "text-muted-foreground"
                }`}
              >
                {updateLine(row, tracked)}
              </p>
            )}
            {/* This tab's refusal renders as its alert ONLY while the tracker
                has not also recorded the failure: once the entry exists, the
                sentence above carries the same words, and 2026-09-17's lesson
                says one failing row shows a refusal exactly once. */}
            {failure !== undefined && tracked?.phase !== "failed" && (
              <p role="alert" className="col-span-full text-destructive text-detail">
                {failure}
              </p>
            )}
          </div>
        );
      })}
    </>
  );
}
