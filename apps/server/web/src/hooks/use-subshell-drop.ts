import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import { readSubshellDrag } from "@/lib/subshell-dnd";
import type { SubshellView } from "@/types/subshell";

/** Recheck the live cache at drop time so helper rows can't be transferred independently. */
export function useSubshellDrop() {
  const queryClient = useQueryClient();
  return useCallback(
    (transfer: Pick<DataTransfer, "types" | "getData">) => {
      const id = readSubshellDrag(transfer);
      const row = queryClient.getQueryData<SubshellView[]>(SUBSHELLS_QUERY_KEY)?.find((row) => row.id === id);
      return row?.crossAgent ? null : id;
    },
    [queryClient],
  );
}
