import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { AppState } from "react-native";
import { useForeground } from "@/hooks/use-foreground";
import { hasActivity, pollIntervalMs } from "@/lib/poll-policy";
import { useMote } from "@/providers/mote-provider";

/**
 * The list poll (spec §Transport): 3 s while anything runs/waits, 15 s
 * quiescent, stopped in background, immediate on resume. Query data is the
 * source of truth for every screen; nothing else re-fetches.
 */
export function useSessions() {
  const { client } = useMote();
  const qc = useQueryClient();
  const foreground = useForeground();

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") {
        // resume-immediate; ["summary"] rides along so the tab badge refreshes
        // too (its own interval follows this query's policy).
        void qc.invalidateQueries({ queryKey: ["sessions"] });
        void qc.invalidateQueries({ queryKey: ["summary"] });
      }
    });
    return () => sub.remove();
  }, [qc]);

  return useQuery({
    enabled: Boolean(client),
    queryKey: ["sessions"],
    queryFn: () => client?.sessions(),
    refetchInterval: (q) => pollIntervalMs({ foreground, hasActivity: hasActivity(q.state.data ?? []) }) ?? false,
    refetchIntervalInBackground: false,
  });
}
