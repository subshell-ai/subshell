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

/**
 * Whether the machine filter earns its place on screen.
 *
 * Mirrors the launch form's `hideMachineField` rule (spec 2026-09-13): with
 * nothing but the control-plane host there is no distinction to draw, so a
 * one-choice dropdown is noise; a single AGENT machine KEEPS it, because the
 * day a second one enrolls the answer is news. A filter that is set stays
 * visible whatever the rows do — hide it while it is active and the page
 * shows "no subshells" with nothing on screen to clear (a machine whose last
 * row closed while you were looking at it is exactly this case).
 */
export function showMachineFilter(ids: readonly string[], selected: string): boolean {
  if (selected !== "all") return true;
  return ids.length > 1 || (ids.length === 1 && ids[0] !== FALLBACK_NODE_ID);
}
