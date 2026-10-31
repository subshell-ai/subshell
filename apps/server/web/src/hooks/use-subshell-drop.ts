import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import { readSubshellDrag } from "@/lib/subshell-dnd";
import type { SubshellView } from "@/types/subshell";

/**
 * Recheck a candidate subshell id against the live cache at drop time, so
 * helper rows can't be transferred independently (a row whose cache says
 * cross-agent is refused even if its payload named it). Shared by the HTML5
 * transports (via {@link useSubshellDrop}) and the pointer transport (which
 * gets the id straight from the session and calls the guard directly).
 */
export function useSubshellDropGuard() {
  const queryClient = useQueryClient();
  return useCallback(
    (id: string | null): string | null => {
      if (id === null) return null;
      const row = queryClient.getQueryData<SubshellView[]>(SUBSHELLS_QUERY_KEY)?.find((row) => row.id === id);
      return row?.crossAgent ? null : id;
    },
    [queryClient],
  );
}

/**
 * The HTML5-transport drop handler: reads the dragged id off the transfer
 * and runs it through the same guard the pointer transport uses (which
 * already holds the id from its session and calls
 * {@link useSubshellDropGuard} directly), so both transports accept a drop
 * only for a still-fileable row.
 */
export function useSubshellDrop() {
  const guard = useSubshellDropGuard();
  return useCallback((transfer: Pick<DataTransfer, "types" | "getData">) => guard(readSubshellDrag(transfer)), [guard]);
}
