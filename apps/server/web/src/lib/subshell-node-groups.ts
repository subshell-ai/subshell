import type { Node } from "@internal/node-admin";
import { subshellStatusRank } from "@/lib/subshell-indicator";
import type { SubshellView } from "@/types/subshell";

/**
 * One node's worth of sidebar rows: the machine, its label, and the
 * subshells running there.
 *
 * The group carries `nodeId` as well as `label` because the two answer
 * different questions — the id keys the collapse preference and React's
 * reconciliation, the label is what a person reads. An admin renaming a node
 * must move every rendered surface and leave every stored preference alone,
 * which only holds while those stay separate values (AGENTS.md, "nothing
 * rendered derives from the id").
 */
export interface SubshellNodeGroup {
  /** Node the subshells run on ("local" = the control-plane host) */
  nodeId: string;
  /** What the header renders — the node's own name when known (see `title`) */
  label: string;
  /**
   * The header's hover text: the NAME when the registry resolved it, the
   * full node id otherwise — the same reveal `nodePill` gives a card
   * (`title={subshell.nodeId}`), and the only way to tell which machine an
   * "unknown node" or a short-id header actually names.
   */
  title: string;
  /** The rows, in the order they arrived (i.e. the caller's status sort), capped by `limit` */
  subshells: SubshellView[];
  /** How many this node has in total, before the cap — `subshells.length` when nothing was dropped */
  total: number;
}

/**
 * Bucket a node id has when the payload carries none. Older cached rows
 * predate `SubshellView.nodeId`, and the backend has always put those on the
 * control-plane host, so they read as `local` rather than as a nameless
 * seventh group.
 */
export const FALLBACK_NODE_ID = "local";

/**
 * The label (and hover title) for one node id, on the ladder the home card's
 * node pill established, with one widening the pill does not need:
 *
 * - the registry resolved the id → the node's NAME, which is what a person
 *   reads and what a rename moves;
 * - the registry has NEVER SUCCEEDED (in flight, or failed with NOTHING
 *   CACHED) → the SHORT id with the full one as `title`. A failed REFRESH of
 *   a populated cache is NOT this arm — stale-but-cached keeps the name,
 *   which is why the caller's flag is `nodeData === undefined` and not
 *   `isError`. Absence proves nothing yet, and a failed list proves less
 *   than nothing — the card can live because it returns null
 *   for `local` outright, but this header labels EVERY node including the
 *   control-plane host, and a "deleted node" verdict above `local` after a
 *   flaky `/api/nodes` would be a lie about the one machine that cannot be
 *   deleted;
 * - the registry ANSWERED without the id → "unknown node". Not "deleted
 *   node": deletion is one cause, but the list is share-filtered, so a revoked
 *   grant (an admin narrowing `local`, a node share pulled under a live
 *   subshell) lands here too, and "unknown" claims only what is known.
 *
 * Exported beside {@link groupSubshellsByNode} because the Wave C diagnostics
 * HUD names a pane's machine too, and two ladders for one question is how the
 * sidebar and the HUD end up disagreeing about the same node.
 *
 * @param nodeId - the node id to name (an absent id falls back to `local`, as the grouping does)
 * @param nodes - the caller's visible nodes, or undefined while the query is unanswered
 * @param unanswered - true while NO read has ever succeeded (see the ladder above)
 */
export function nodeLabelFor(
  nodeId: string,
  nodes: readonly Node[] | undefined,
  unanswered: boolean,
): { label: string; title: string } {
  const known = nodes?.find((n) => n.id === nodeId);
  if (known) return { label: known.name, title: known.name };
  if (unanswered) return { label: nodeId.slice(0, 8), title: nodeId };
  return { label: "unknown node", title: nodeId };
}

/**
 * Groups sidebar subshells by the machine they run on.
 *
 * The input is expected to arrive in the rail's status order (see
 * `useOrderedSubshells`) and that order is preserved INSIDE every group —
 * this function re-buckets, it never re-sorts rows.
 *
 * Two ordering facts worth holding:
 *
 * - **Groups sort by their liveliest member**, not by name or by node order.
 *   The whole point of the status band is that something waiting for you is
 *   the first thing you see, and grouping by machine would have buried it
 *   under whichever node happened to come first. The rank is the MINIMUM over
 *   the group's rows, not the first row's: the caller's sort happened once,
 *   against the data, while activity is re-derived against the CLOCK on every
 *   render — so the first row can have gone idle underneath a group whose
 *   second row is still printing. Ties keep the order the buckets were
 *   discovered in, which is itself the status order.
 * - **The cap is PER GROUP.** A quiet machine's pile of ended sessions can
 *   crowd out that machine's own live work, exactly as it could before
 *   grouping, and can no longer crowd out another machine's.
 *
 * @param subshells - the rail's status-ordered list
 * @param nodes - the caller's visible nodes, for resolving each bucket's label
 * @param options.limit - max rows per group; omitted = no cap (filter mode)
 * @param options.unanswered - true while the nodes read has not succeeded (see {@link nodeLabelFor})
 */
export function groupSubshellsByNode(
  subshells: readonly SubshellView[],
  nodes: readonly Node[] | undefined,
  { limit, unanswered = false }: { limit?: number; unanswered?: boolean } = {},
): SubshellNodeGroup[] {
  // Insertion-ordered, so the discovery order IS the input's status order and
  // the sort below only has to break ties.
  const buckets = new Map<string, SubshellView[]>();
  for (const sub of subshells) {
    const nodeId = sub.nodeId || FALLBACK_NODE_ID;
    const bucket = buckets.get(nodeId);
    if (bucket) bucket.push(sub);
    else buckets.set(nodeId, [sub]);
  }
  const groups = [...buckets].map(([nodeId, rows]) => ({
    nodeId,
    ...nodeLabelFor(nodeId, nodes, unanswered),
    // The liveliest member decides, whatever position the input's sort left
    // the rows in — see the docblock. `rows` is non-empty by construction.
    rank: Math.min(...rows.map(subshellStatusRank)),
    subshells: limit === undefined ? rows : rows.slice(0, limit),
    total: rows.length,
  }));
  // Stable, so equal ranks keep their discovery order.
  groups.sort((a, b) => a.rank - b.rank);
  return groups.map(({ nodeId, label, title, subshells: rows, total }) => ({
    nodeId,
    label,
    title,
    subshells: rows,
    total,
  }));
}
