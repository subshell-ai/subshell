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
  /** What the header renders — the node's own name, never its id (see above) */
  label: string;
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
const FALLBACK_NODE_ID = "local";

/**
 * The label for one bucket, on the ladder the home card's node pill
 * established: a name when the registry holds the id; the SHORT id while the
 * registry has not answered yet (absence proves nothing in flight, and a cold
 * load must not flash "deleted node" above every remote row); the plain words
 * once it has. A failed list is indistinguishable from a vanished node from
 * here and reads the same way.
 *
 * @param nodeId - the bucket's node id
 * @param nodes - the caller's visible nodes, or undefined while the query is unanswered
 * @param pending - true while that query is still in flight
 */
function labelFor(nodeId: string, nodes: readonly Node[] | undefined, pending: boolean): string {
  const known = nodes?.find((n) => n.id === nodeId);
  if (known) return known.name;
  if (pending) return nodeId.slice(0, 8);
  return "deleted node";
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
 *   under whichever node happened to come first. Ties keep the order the
 *   buckets were discovered in, which is itself the status order.
 * - **The cap is PER GROUP.** A quiet machine's pile of ended sessions can
 *   crowd out that machine's own live work, exactly as it could before
 *   grouping, and can no longer crowd out another machine's.
 *
 * @param subshells - the rail's status-ordered list
 * @param nodes - the caller's visible nodes, for resolving each bucket's label
 * @param options.limit - max rows per group; omitted = no cap (filter mode)
 * @param options.pending - true while the nodes query is unanswered (see {@link labelFor})
 */
export function groupSubshellsByNode(
  subshells: readonly SubshellView[],
  nodes: readonly Node[] | undefined,
  { limit, pending = false }: { limit?: number; pending?: boolean } = {},
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
    label: labelFor(nodeId, nodes, pending),
    // The rows arrived in status order, so the first one IS the liveliest.
    rank: subshellStatusRank(rows[0] as SubshellView),
    subshells: limit === undefined ? rows : rows.slice(0, limit),
    total: rows.length,
  }));
  // Stable, so equal ranks keep their discovery order.
  groups.sort((a, b) => a.rank - b.rank);
  return groups.map(({ nodeId, label, subshells: rows, total }) => ({ nodeId, label, subshells: rows, total }));
}
