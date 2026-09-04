import { useMemo } from "react";
import { useSubshellsList } from "@/hooks/use-subshells";
import { sortByStatus } from "@/lib/subshell-indicator";
import { sortByCreation } from "@/lib/subshell-order";
import type { SubshellView } from "@/types/subshell";

/**
 * The FULL subshell list in SIDEBAR order: status band (waiting → working →
 * idle → node-offline → exited → ended), cache order (newest first) as the
 * tie-break. The sidebar slices/filters this.
 *
 * The prev/next swipe used to walk this same list — "ONE definition so both
 * surfaces can't drift" — and that turned out to be the wrong sharing. The
 * status band ranks by `activity`, i.e. "output within the last 60s", so the
 * order changes on its own as agents print; a list you read wants that, a
 * thing you navigate does not. Navigation uses
 * {@link useSwipeOrderedSubshells} instead.
 */
export function useOrderedSubshells(): SubshellView[] {
  const { data } = useSubshellsList();
  return useMemo(() => sortByStatus(data ?? []), [data]);
}

/**
 * The FULL subshell list in a STABLE order, for prev/next swipe navigation.
 *
 * Separate from {@link useOrderedSubshells} on purpose — see the note there.
 * Within one status band the two agree, because the sidebar's tie-break is
 * already newest-first, so this changes what a swipe does only when the bands
 * would have reordered things underneath the user.
 */
export function useSwipeOrderedSubshells(): SubshellView[] {
  const { data } = useSubshellsList();
  return useMemo(() => sortByCreation(data ?? []), [data]);
}
