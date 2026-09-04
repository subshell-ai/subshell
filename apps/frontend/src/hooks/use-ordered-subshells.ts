import { useMemo } from "react";
import { useSubshellsList } from "@/hooks/use-subshells";
import { sortByStatus } from "@/lib/subshell-indicator";
import type { SubshellView } from "@/types/subshell";

/**
 * The FULL subshell list in sidebar order: status band (waiting → working →
 * idle → node-offline → exited → ended), cache order (newest first) as the
 * tie-break. The sidebar slices/filters this; the prev/next swipe walks it
 * whole (spec 2026-09-04). ONE definition so both surfaces can't drift.
 */
export function useOrderedSubshells(): SubshellView[] {
  const { data } = useSubshellsList();
  return useMemo(() => sortByStatus(data ?? []), [data]);
}
