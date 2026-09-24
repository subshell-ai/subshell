import { FALLBACK_NODE_ID } from "@/lib/subshell-node-groups";
import type { SubshellView } from "@/types/subshell";

/**
 * Filters subshells by a free-text query against name, working directory and
 * harness — the three things people actually recognise a subshell by.
 *
 * Shared so every place that searches subshells searches them identically:
 * the subshells page and the workspace's add-subshell dialog. An empty or
 * whitespace query returns the input unchanged (the same array, not a copy).
 */
export function filterSubshells(subshells: SubshellView[], query: string): SubshellView[] {
  const q = query.trim().toLowerCase();
  if (!q) return subshells;
  return subshells.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.workingDir.toLowerCase().includes(q) ||
      s.harnessId.toLowerCase().includes(q),
  );
}

/** The machine's own bucket id on a row that predates `nodeId` — same fallback the grouping uses. */
function nodeOf(s: SubshellView): string {
  return s.nodeId || FALLBACK_NODE_ID;
}

/**
 * The distinct machines these subshells run on, in discovery order.
 * The page's machine filter lists exactly these (plus "All"), so the filter
 * can never offer a machine with nothing behind it.
 */
export function machineIds(subshells: readonly SubshellView[]): string[] {
  return [...new Set(subshells.map(nodeOf))];
}

/** The rows running on ONE machine (see {@link machineIds} for the id space). */
export function filterByNode(subshells: readonly SubshellView[], nodeId: string): SubshellView[] {
  return subshells.filter((s) => nodeOf(s) === nodeId);
}
