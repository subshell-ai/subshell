import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
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
  const [foreground, setForeground] = useState(() => AppState.currentState === "active");

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      setForeground(s === "active");
      if (s === "active") void qc.invalidateQueries({ queryKey: ["sessions"] }); // resume-immediate
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
