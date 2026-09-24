import { apiFetch, Button, NODES_QUERY_KEY, type Node } from "@internal/node-admin";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { DASH, MobilePair, RowRule, VersionCell } from "@/components/updates/row-cells";
import { useNodeUpdate } from "@/hooks/use-node-update";
import { UPDATES_QUERY_KEY } from "@/lib/query-keys";
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
 * One accepted node update, from the 202 to the machine reporting back.
 *
 * The page's own contract — "nothing on this page moves without a press" — is
 * exactly why this state has to exist: a node update's LAST act lands after
 * the POST answers. The agent exits ~500 ms after the 202 and reconnects
 * seconds later on the new version, and with no poller and no live feed onto
 * this query the row used to sit saying `0.15.0 → 0.15.1` forever after an
 * update that had in fact worked (operator report, 2026-09-23: "the update did
 * work but it didn't update the version or say that it was success").
 */
interface Watch {
  /** The version the server said this machine is installing. */
  to: string;
  /** When the 202 landed; the stall clock starts here. */
  acceptedAt: number;
  /**
   * `installing` until the node reports `to` (→ `done`) or the stall clock
   * runs out (→ `stalled`). `done`/`stalled` watches are terminal: they render
   * their line and they do NOT keep the poller alive.
   */
  phase: "installing" | "done" | "stalled";
}

/** Cadence of the RETURN watcher: 2 s, and only while a watch is installing. */
const WATCH_POLL_MS = 2_000;
/**
 * After this, stop pretending to know. The restart itself is seconds; a watch
 * still installing at two minutes means the machine has not dialled back (or
 * not on the new version), which is a fact worth saying rather than a green
 * sentence worth holding forever.
 */
export const WATCH_STALL_MS = 120_000;

/**
 * The next phase of a watch, given what the polled node list says.
 * Pure so all three branches are testable without timers or fetches.
 */
export function nextPhase(
  watch: Watch,
  reported: string | null | undefined,
  nowMs: number,
  stallMs: number = WATCH_STALL_MS,
): Watch["phase"] {
  if (reported === watch.to) return "done";
  if (nowMs - watch.acceptedAt >= stallMs) return "stalled";
  return "installing";
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
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);
  const [watches, setWatches] = useState<Record<string, Watch>>({});
  const updatable = fleet.rows.filter((row) => row.canUpdate.ok);

  // The watcher rides the SAME query key the rest of the app reads nodes
  // through, `enabled` only while some update is still installing — so the
  // standing cadence this page refuses stays refused, and only the seconds an
  // operator is actually watching are polled (the route's 1 s cadence for a
  // running server job is the same precedent).
  const installing = Object.values(watches).some((w) => w.phase === "installing");
  const { data: nodesView } = useQuery({
    queryKey: NODES_QUERY_KEY,
    queryFn: () => apiFetch<{ nodes: Node[] }>("/api/nodes"),
    enabled: installing,
    refetchInterval: installing ? WATCH_POLL_MS : false,
  });

  // Advance every installing watch off the polled answer. The node reporting
  // the version it was sent is DONE, and the fleet read that feeds the rows'
  // own cells is invalidated on that transition — so the row's Running column
  // shows the new number without a reload, under its `Updated to` line.
  useEffect(() => {
    if (!installing) return;
    const nodes = nodesView?.nodes;
    if (!nodes) return;
    const nowMs = Date.now();
    let changed = false;
    let anyDone = false;
    const next: Record<string, Watch> = {};
    for (const [id, watch] of Object.entries(watches)) {
      if (watch.phase !== "installing") {
        next[id] = watch;
        continue;
      }
      const phase = nextPhase(watch, nodes.find((n) => n.id === id)?.agentVersion, nowMs);
      if (phase !== watch.phase) {
        changed = true;
        if (phase === "done") anyDone = true;
      }
      next[id] = { ...watch, phase };
    }
    if (changed) setWatches(next);
    if (anyDone) {
      void queryClient.invalidateQueries({ queryKey: UPDATES_QUERY_KEY });
    }
  }, [nodesView, watches, installing, queryClient]);

  /** Record the 202's `to` and start the stall clock for one node. */
  async function updateOne(nodeId: string): Promise<void> {
    const res = await nodeUpdate.update(nodeId);
    setWatches((prev) => ({ ...prev, [nodeId]: { to: res.to, acceptedAt: Date.now(), phase: "installing" } }));
  }

  async function updateAll(): Promise<void> {
    // The single-press handler resets before it runs; the sequence must too,
    // or a refusal from before stays pinned on its row through (and after) a
    // run in which that row was never even asked.
    nodeUpdate.reset();
    setWatches({});
    setRunning(true);
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
            {running && <LoaderCircle aria-hidden className="mr-1.5 size-3.5 motion-safe:animate-spin" />}
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
        // The node page's card got these sentences first, for the same reason:
        // after the 202 the machine is mid-restart, and "it will reconnect by
        // itself" is what a person watching a finished spinner needs to hear.
        const watch = watches[row.id];
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
                  setWatches((prev) => {
                    const { [row.id]: _cleared, ...rest } = prev;
                    return rest;
                  });
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
            {watch?.phase === "installing" && (
              <p className="col-span-full text-detail text-success">
                Update accepted. {row.name} is installing {watch.to} and will reconnect by itself.
              </p>
            )}
            {watch?.phase === "done" && (
              <p className="col-span-full text-detail text-success">Updated to {watch.to}.</p>
            )}
            {watch?.phase === "stalled" && (
              <p className="col-span-full text-detail text-muted-foreground">
                The update was accepted, but {row.name} has not reported {watch.to} yet. It may still be restarting;
                reload to check.
              </p>
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
