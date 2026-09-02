import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { AppState } from "react-native";
import { polledInterval } from "@/hooks/polled-interval";
import { SESSIONS_KEY, SUMMARY_KEY } from "@/hooks/query-keys";
import { useForeground } from "@/hooks/use-foreground";
import { useMote } from "@/providers/subshell-provider";

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
        // resume-immediate; the badge rides along so ["summary"] is never the
        // stale one after a background stretch.
        void qc.invalidateQueries({ queryKey: SESSIONS_KEY });
        void qc.invalidateQueries({ queryKey: SUMMARY_KEY });
      }
    });
    return () => sub.remove();
  }, [qc]);

  return useQuery({
    enabled: Boolean(client),
    queryKey: SESSIONS_KEY,
    queryFn: () => client?.sessions(),
    refetchInterval: (q) => polledInterval(foreground, () => q.state.data),
    refetchIntervalInBackground: false,
  });
}
