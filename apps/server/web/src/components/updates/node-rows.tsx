import { Button } from "@internal/node-admin";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { DASH, MobilePair, RowRule, VersionCell } from "@/components/updates/row-cells";
import { useNodeUpdate } from "@/hooks/use-node-update";
import { endOnce } from "@/lib/update-copy";
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
  // The run carries the fleet the press CAPTURED, ids in press order, for
  // the whole sequence's length: a mid-run refetch takes a restarting node
  // offline, its canUpdate goes false, and a counter reading the live
  // updatable list would read "Updating 1 of 1" while the operator's own
  // press said two.
  const [run, setRun] = useState<{ ids: string[] } | null>(null);
  // Which row the page is working on RIGHT NOW, owned by the sequence rather
  // than by the shared mutation: `useMutation` can only name its latest call,
  // so a busy state read from it left every "Update all" but the first row
  // silent for the minutes that one POST takes (operator report 2026-09-25).
  // The spinner is this tab's press only; every SENTENCE about what happens
  // after the press belongs to the server's tracker, mirrored on each row.
  const [activeId, setActiveId] = useState<string | null>(null);
  const updatable = fleet.rows.filter((row) => row.canUpdate.ok);

  /** Work one node: this tab owns the row spinner while its POST runs; the
   * tracker on the server owns everything the row says afterwards. */
  async function updateOne(nodeId: string): Promise<void> {
    setActiveId(nodeId);
    try {
      await nodeUpdate.update(nodeId);
    } finally {
      // The next row has usually already claimed the spinner by the time a
      // failing or finished call gets here; only release OURS.
      setActiveId((cur) => (cur === nodeId ? null : cur));
    }
  }

  async function updateAll(): Promise<void> {
    // The single-press handler resets before it runs; the sequence must too,
    // or a refusal from before stays pinned on its row through (and after) a
    // run in which that row was never even asked.
    nodeUpdate.reset();
    setRun({ ids: updatable.map((row) => row.id) });
    try {
      for (const row of updatable) {
        try {
          await updateOne(row.id);
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
      setRun(null);
    }
  }

  const newest = fleet.release?.version ?? DASH;
  // The sequence's 1-based position WITHIN THE CAPTURED RUN. Zero means
  // either no run (idle, or a single press - there the header keeps its own
  // "Update all (N)" count) or the active row is momentarily outside the
  // run; only that second case paints, as a bare un-numbered "Updating…"
  // inside a running sequence.
  const seqPos = run === null || activeId === null ? 0 : run.ids.indexOf(activeId) + 1;

  return (
    <>
      <div className="col-span-full flex flex-wrap items-center justify-between gap-3 border-t pt-2">
        <span className="font-strong text-label">Nodes</span>
        {fleet.rows.length > 0 && (
          <Button
            variant="outline"
            disabled={updatable.length === 0 || run !== null || activeId !== null}
            onClick={() => void updateAll()}
          >
            {run !== null && <LoaderCircle aria-hidden className="mr-1.5 size-3.5 motion-safe:animate-spin" />}
            {run === null
              ? `Update all (${updatable.length})`
              : seqPos > 0
                ? `Updating ${seqPos} of ${run.ids.length}…`
                : "Updating…"}
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
        const updating = activeId === row.id;
        // The tracker entry rides the row (design 2026-09-25): every sentence
        // about an ordered update comes from the server's fact, so a refresh
        // or a second tab reads the same story mid-flight.
        const tracked = row.update;
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
                disabled={!row.canUpdate.ok || run !== null || activeId !== null}
                title={row.canUpdate.reason ?? undefined}
                onClick={() => {
                  nodeUpdate.reset();
                  void updateOne(row.id).catch(() => {
                    // The hook keeps the failure and the row renders it; a
                    // rejection here is the sequence's contract, not an error
                    // this press has anywhere else to put.
                  });
                }}
              >
                {/* The POST blocks for the node's whole download-and-restart
                    window, up to five minutes, so a bare disabled button reads
                    as nothing happening. */}
                {updating && <LoaderCircle aria-hidden className="mr-1.5 size-3.5 motion-safe:animate-spin" />}
                {updating ? "Updating…" : "Update"}
              </Button>
            </div>
            {!row.canUpdate.ok && row.canUpdate.reason !== null && (
              <p className="col-span-full truncate text-detail text-muted-foreground">{row.canUpdate.reason}</p>
            )}
            {tracked !== null && (
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
            {nodeUpdate.failure?.nodeId === row.id && tracked?.phase !== "failed" && (
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
