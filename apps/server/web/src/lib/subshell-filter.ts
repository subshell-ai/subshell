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

/** Subshells grouped by what an operator treats as distinct states. */
export interface SubshellGroups {
  /** Status "running" and the process is alive. */
  running: SubshellView[];
  /** Status "running" but the process exited — resumable. */
  exited: SubshellView[];
  /** Status "terminated". */
  terminated: SubshellView[];
}

/**
 * Splits subshells into running / paused-exited / terminated.
 *
 * "Running but not alive" is its own group rather than a variant of either
 * neighbour: the row still exists and can be restarted, which is not true of
 * a terminated one.
 */
export function groupSubshells(subshells: SubshellView[]): SubshellGroups {
  return {
    running: subshells.filter((s) => s.status === "running" && s.alive),
    exited: subshells.filter((s) => s.status === "running" && !s.alive),
    terminated: subshells.filter((s) => s.status === "terminated"),
  };
}
